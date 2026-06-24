//! ScreenCaptureKit-based capture, used in place of xcap's `capture_image()`
//! on macOS. xcap still calls the deprecated `CGWindowListCreateImage`, which
//! newer macOS releases allow (no permission re-prompt) but answer with a
//! blank/empty image. ScreenCaptureKit is the API Apple still backs.
use anyhow::{anyhow, Context, Result};
use image::RgbaImage;
use screencapturekit::screenshot_manager::{CGImageExt, ImageFormat as SckImageFormat, SCScreenshotManager};
use screencapturekit::shareable_content::{SCShareableContent, SCShareableContentInfo};
use screencapturekit::stream::configuration::SCStreamConfiguration;
use screencapturekit::stream::content_filter::SCContentFilter;
use std::sync::atomic::{AtomicU32, Ordering};

/// `SCScreenshotManager` (the one-shot capture API we use) requires macOS 14+;
/// on older systems the symbol is simply unavailable at runtime. Callers
/// should check this and fall back to xcap's `CGWindowListCreateImage` path,
/// which is still the only option pre-14 and isn't known to be broken there.
pub fn is_available() -> bool {
    let Ok(output) = std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
    else {
        return false;
    };
    let version = String::from_utf8_lossy(&output.stdout);
    version
        .trim()
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .map(|major| major >= 14)
        .unwrap_or(false)
}

/// `CGImageExt::rgba_data()` goes through the crate's custom Core Graphics
/// re-render path, which comes back with a zeroed alpha channel (image is
/// there but fully transparent, so it renders as black over a dark UI).
/// `save()` writing through ImageIO does not have this bug, so we round-trip
/// through a temp PNG instead of touching `rgba_data()`.
fn cgimage_to_rgba(image: &screencapturekit::screenshot_manager::CGImage) -> Result<RgbaImage> {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = std::env::temp_dir().join(format!(
        "shotcove_sck_{}_{n}.png",
        std::process::id()
    ));
    let path_str = tmp_path
        .to_str()
        .ok_or_else(|| anyhow!("temp path is not valid UTF-8"))?;

    image
        .save(path_str, SckImageFormat::Png)
        .map_err(|e| anyhow!("failed to encode captured image: {e}"))?;

    let result = image::open(&tmp_path)
        .map(|img| img.to_rgba8())
        .context("failed to read captured image back from temp file");
    let _ = std::fs::remove_file(&tmp_path);
    result
}

/// Attempts a tiny (2x2) display capture purely to learn whether the Screen
/// Recording permission is granted; also triggers the system prompt the
/// first time it runs. Falls back to the Core Graphics TCC API pre-macOS 14,
/// since `SCScreenshotManager` itself isn't available there.
pub fn probe_permission() -> bool {
    if !is_available() {
        return legacy_probe_permission();
    }
    let Ok(content) = SCShareableContent::get() else { return false };
    let Some(display) = content.displays().into_iter().next() else { return false };
    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();
    let config = SCStreamConfiguration::new().with_width(2).with_height(2);
    SCScreenshotManager::capture_image(&filter, &config).is_ok()
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
}

/// Pre-macOS 14 permission probe via the Core Graphics TCC API. Triggers the
/// system permission prompt the first time it runs, same as the SCK probe above.
fn legacy_probe_permission() -> bool {
    unsafe {
        if CGPreflightScreenCaptureAccess() {
            return true;
        }
        CGRequestScreenCaptureAccess()
    }
}

/// Captures a single display, identified by its `CGDirectDisplayID`
/// (same value as `xcap::Monitor::id()` on macOS).
pub fn capture_display(display_id: u32) -> Result<RgbaImage> {
    let content = SCShareableContent::get()
        .map_err(|e| anyhow!("failed to list shareable content: {e}"))?;
    let display = content
        .displays()
        .into_iter()
        .find(|d| d.display_id() == display_id)
        .ok_or_else(|| anyhow!("display {display_id} not found"))?;

    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();

    let (pixel_w, pixel_h) = SCShareableContentInfo::for_filter(&filter)
        .map(|info| info.pixel_size())
        .unwrap_or((display.width(), display.height()));

    let config = SCStreamConfiguration::new()
        .with_width(pixel_w)
        .with_height(pixel_h);

    let image = SCScreenshotManager::capture_image(&filter, &config)
        .map_err(|e| anyhow!("ScreenCaptureKit display capture failed: {e}"))
        .context("failed to capture display image")?;

    cgimage_to_rgba(&image)
}

/// Captures a single window, identified by its `CGWindowID` (same value as
/// `xcap::Window::id()` on macOS), as an isolated layer with real alpha at
/// the rounded corners/shadow edge.
///
/// Deliberately uses the streaming `SCStream` API instead of
/// `SCScreenshotManager::capture_image`: the one-shot screenshot manager
/// reliably returns a fully transparent/blank frame for window-style content
/// filters in this crate, while the stream API (the older, more mature path)
/// renders window content correctly. Captures exactly one frame, then stops.
pub fn capture_window(window_id: u32) -> Result<RgbaImage> {
    use screencapturekit::prelude::*;
    use screencapturekit::cv::CVPixelBufferLockFlags;
    use std::sync::mpsc::{sync_channel, SyncSender};
    use std::time::Duration;

    struct FrameGrabber {
        tx: SyncSender<(Vec<u8>, u32, u32, usize)>,
    }

    impl SCStreamOutputTrait for FrameGrabber {
        fn did_output_sample_buffer(&self, sample: CMSampleBuffer, output_type: SCStreamOutputType) {
            if !matches!(output_type, SCStreamOutputType::Screen) {
                return;
            }
            let Some(pixel_buffer) = sample.image_buffer() else { return };
            let Ok(guard) = pixel_buffer.lock(CVPixelBufferLockFlags::READ_ONLY) else { return };
            let (width, height, bytes_per_row) = (guard.width() as u32, guard.height() as u32, guard.bytes_per_row());
            let _ = self.tx.try_send((guard.as_slice().to_vec(), width, height, bytes_per_row));
        }
    }

    let content = SCShareableContent::get()
        .map_err(|e| anyhow!("failed to list shareable content: {e}"))?;
    let window = content
        .windows()
        .into_iter()
        .find(|w| w.window_id() == window_id)
        .ok_or_else(|| anyhow!("window {window_id} not found"))?;

    let filter = SCContentFilter::create().with_window(&window).build();
    let frame = window.frame();
    let pixel_w = (frame.size.width as u32).max(1);
    let pixel_h = (frame.size.height as u32).max(1);

    let config = SCStreamConfiguration::new()
        .with_width(pixel_w)
        .with_height(pixel_h)
        .with_pixel_format(PixelFormat::BGRA);

    let (tx, rx) = sync_channel(1);
    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(FrameGrabber { tx }, SCStreamOutputType::Screen);
    stream
        .start_capture()
        .map_err(|e| anyhow!("failed to start window capture stream: {e}"))?;

    let frame_result = rx.recv_timeout(Duration::from_secs(3));
    let _ = stream.stop_capture();

    let (data, width, height, bytes_per_row) =
        frame_result.map_err(|_| anyhow!("timed out waiting for a window frame"))?;

    let mut buffer = Vec::with_capacity(width as usize * height as usize * 4);
    for row in data.chunks_exact(bytes_per_row) {
        buffer.extend_from_slice(&row[..width as usize * 4]);
    }
    // BGRA -> RGBA
    for px in buffer.chunks_exact_mut(4) {
        px.swap(0, 2);
    }

    RgbaImage::from_raw(width, height, buffer)
        .ok_or_else(|| anyhow!("captured window pixel buffer does not match {width}x{height}"))
}
