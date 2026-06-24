//! Cross-platform "copy file(s) to the clipboard" — i.e. putting a *file reference*
//! on the clipboard so it can be pasted into a file manager / chat app as an actual
//! file, not just the image bytes. Each OS exposes this through a completely different
//! API, so there is a separate implementation per platform behind one uniform signature.

use std::path::PathBuf;
use tauri::AppHandle;

/// Windows: CF_HDROP via the Win32 clipboard (see [`crate::win_util`]).
#[cfg(windows)]
pub fn copy_files_to_clipboard(_app: &AppHandle, paths: &[PathBuf]) -> Result<(), String> {
    crate::win_util::copy_files_to_clipboard(paths)
}

/// macOS: write file URLs to the general `NSPasteboard`.
#[cfg(target_os = "macos")]
pub fn copy_files_to_clipboard(_app: &AppHandle, paths: &[PathBuf]) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2_app_kit::{NSPasteboard, NSPasteboardWriting};
    use objc2_foundation::{NSArray, NSString, NSURL};

    if paths.is_empty() {
        return Err("no files to copy".into());
    }

    let mut objs: Vec<Retained<ProtocolObject<dyn NSPasteboardWriting>>> =
        Vec::with_capacity(paths.len());
    for p in paths {
        let s = NSString::from_str(&p.to_string_lossy());
        let url = NSURL::fileURLWithPath(&s);
        objs.push(ProtocolObject::from_retained(url));
    }
    let array = NSArray::from_retained_slice(&objs);
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    if pasteboard.writeObjects(&array) {
        Ok(())
    } else {
        Err("NSPasteboard writeObjects failed".into())
    }
}

/// Linux (X11/Wayland via GTK): expose the file(s) on the CLIPBOARD selection using the
/// `text/uri-list` target plus GNOME/Nautilus's `x-special/gnome-copied-files` so that
/// file managers paste them as files. Must run on the GTK main thread, so the work is
/// dispatched there and we block briefly for its result.
#[cfg(target_os = "linux")]
pub fn copy_files_to_clipboard(app: &AppHandle, paths: &[PathBuf]) -> Result<(), String> {
    let uris: Vec<String> = paths
        .iter()
        .map(|p| url::Url::from_file_path(p).map(|u| u.to_string()))
        .collect::<Result<_, _>>()
        .map_err(|_| "invalid (non-absolute) file path".to_string())?;

    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    app.run_on_main_thread(move || {
        let _ = tx.send(set_clipboard_uris(&uris));
    })
    .map_err(|e| format!("failed to dispatch to GTK main thread: {e}"))?;

    rx.recv()
        .map_err(|e| format!("clipboard task did not report a result: {e}"))?
}

#[cfg(target_os = "linux")]
fn set_clipboard_uris(uris: &[String]) -> Result<(), String> {
    let clipboard = gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD);
    let targets = [
        gtk::TargetEntry::new("x-special/gnome-copied-files", gtk::TargetFlags::empty(), 0),
        gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 1),
    ];

    let uris_owned = uris.to_vec();
    let set = clipboard.set_with_data(&targets, move |_clip, selection, info| {
        if info == 0 {
            // GNOME/Nautilus format: "copy\n<uri>\n<uri>…"
            let mut data = String::from("copy");
            for u in &uris_owned {
                data.push('\n');
                data.push_str(u);
            }
            let target = selection.target();
            selection.set(&target, 8, data.as_bytes());
        } else {
            let refs: Vec<&str> = uris_owned.iter().map(|s| s.as_str()).collect();
            selection.set_uris(&refs);
        }
    });
    if !set {
        return Err("failed to set clipboard data".into());
    }

    // Ask the clipboard manager to keep the data alive after the app loses focus / exits.
    clipboard.store();
    Ok(())
}

/// Other platforms (e.g. *BSD): no implementation.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub fn copy_files_to_clipboard(_app: &AppHandle, _paths: &[PathBuf]) -> Result<(), String> {
    Err("Copying files to the clipboard is not supported on this platform".into())
}
