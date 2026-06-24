use anyhow::{anyhow, Context, Result};
use crate::config::{CustomBodyType, CustomMethod, CustomProvider, CustomResponseType};

// ---------------------------------------------------------------------------
// Format support
// ---------------------------------------------------------------------------

fn provider_accepts(id: &str, ext: &str) -> bool {
    match id {
        "prntscr"   => matches!(ext, "png" | "jpg" | "jpeg"),
        "imgbb"     => matches!(ext, "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp"),
        "freeimage" => matches!(ext, "png" | "jpg" | "jpeg" | "webp" | "gif"),
        "catbox"    => true,
        _           => true, // custom providers accept all formats
    }
}

fn to_png_bytes(bytes: &[u8]) -> Result<Vec<u8>> {
    convert_bytes(bytes, "png")
}

fn convert_bytes(bytes: &[u8], target_ext: &str) -> Result<Vec<u8>> {
    let img = image::load_from_memory(bytes)
        .or_else(|_| {
            // image crate may not support all formats (e.g. AVIF without dav1d decoder).
            // Fall back to the OS-level WIC decoder on Windows.
            #[cfg(target_os = "windows")]
            { wic_load_image(bytes) }
            #[cfg(not(target_os = "windows"))]
            { Err(anyhow!("unsupported image format")) }
        })
        .context("failed to load image")?;

    let fmt = match target_ext {
        "jpg" | "jpeg" => image::ImageFormat::Jpeg,
        "webp"         => image::ImageFormat::WebP,
        "bmp"          => image::ImageFormat::Bmp,
        "gif"          => image::ImageFormat::Gif,
        _              => image::ImageFormat::Png,
    };
    let mut out = Vec::new();
    img.write_to(&mut std::io::Cursor::new(&mut out), fmt)
        .with_context(|| format!("{target_ext} conversion failed"))?;
    Ok(out)
}

/// Decode any image format supported by Windows Imaging Component (WIC),
/// including AVIF (Windows 11) and HEIC. Returns a DynamicImage in RGBA8.
#[cfg(target_os = "windows")]
fn wic_load_image(bytes: &[u8]) -> Result<image::DynamicImage> {
    use windows::Win32::Graphics::Imaging::*;
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

        let factory: IWICImagingFactory = CoCreateInstance(
            &CLSID_WICImagingFactory,
            None,
            CLSCTX_INPROC_SERVER,
        ).context("WIC factory creation failed")?;

        let stream = SHCreateMemStream(Some(bytes))
            .ok_or_else(|| anyhow!("WIC: failed to create memory stream"))?;

        let decoder = factory.CreateDecoderFromStream(
            &stream,
            std::ptr::null(),
            WICDecodeOptions(0), // WICDecodeMetadataCacheOnDemand
        ).context("WIC: decoder creation failed")?;

        let frame: IWICBitmapFrameDecode = decoder.GetFrame(0)
            .context("WIC: GetFrame failed")?;

        let mut width = 0u32;
        let mut height = 0u32;
        frame.GetSize(&mut width, &mut height)
            .context("WIC: GetSize failed")?;

        let converter: IWICFormatConverter = factory.CreateFormatConverter()
            .context("WIC: CreateFormatConverter failed")?;

        converter.Initialize(
            &frame,
            &GUID_WICPixelFormat32bppBGRA,
            WICBitmapDitherType(0),   // WICBitmapDitherTypeNone
            None,
            0.0,
            WICBitmapPaletteType(0),  // WICBitmapPaletteTypeMedianCut
        ).context("WIC: FormatConverter Initialize failed")?;

        let stride = width * 4;
        let mut buf = vec![0u8; (stride * height) as usize];
        converter.CopyPixels(std::ptr::null(), stride, &mut buf)
            .context("WIC: CopyPixels failed")?;

        // WIC gives BGRA — swap to RGBA for image crate
        for px in buf.chunks_exact_mut(4) {
            px.swap(0, 2);
        }

        let img = image::RgbaImage::from_raw(width, height, buf)
            .ok_or_else(|| anyhow!("WIC: buffer size mismatch"))?;
        Ok(image::DynamicImage::ImageRgba8(img))
    }
}

// ---------------------------------------------------------------------------
// Per-provider uploaders
// ---------------------------------------------------------------------------

async fn upload_imgbb(api_key: &str, png_b64: &str) -> Result<String> {
    upload_chevereto("https://api.imgbb.com/1/upload", "image", api_key, png_b64).await
}

async fn upload_freeimage(api_key: &str, png_b64: &str) -> Result<String> {
    upload_chevereto("https://freeimage.host/api/1/upload", "source", api_key, png_b64).await
}

async fn upload_chevereto(endpoint: &str, param_name: &str, api_key: &str, png_b64: &str) -> Result<String> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .context("failed to create HTTP client")?;
    let resp = http
        .post(endpoint)
        .query(&[("key", api_key)])
        .form(&[
            (param_name, png_b64),
            ("name",  "screenshot"),
        ])
        .send()
        .await
        .context("failed to send image upload request")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("upload error ({}): {body}", status.as_u16()));
    }

    let json: serde_json::Value = resp.json().await.context("failed to parse response")?;
    let url = json["data"]["url"]
        .as_str()
        .or_else(|| json["image"]["url"].as_str())
        .ok_or_else(|| anyhow!("image URL not found in response: {:?}", json))?;

    Ok(url.to_string())
}

async fn upload_catbox(userhash: &str, file_name: &str, bytes: Vec<u8>) -> Result<String> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .context("failed to create HTTP client")?;
    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name.to_string())
        .mime_str("image/png")
        .map_err(|e| anyhow!("multipart part error: {e}"))?;
    let mut form = reqwest::multipart::Form::new()
        .text("reqtype", "fileupload")
        .part("fileToUpload", file_part);

    if !userhash.trim().is_empty() {
        form = form.text("userhash", userhash.trim().to_string());
    }

    let resp = http
        .post("https://catbox.moe/user/api.php")
        .multipart(form)
        .send()
        .await
        .context("failed to send Catbox upload request")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("Catbox upload error ({}): {body}", status.as_u16()));
    }

    let url = resp.text().await.context("failed to read Catbox response")?;
    let trimmed = url.trim().to_string();
    if !trimmed.starts_with("http") {
        return Err(anyhow!("Catbox upload error: {trimmed}"));
    }
    Ok(trimmed)
}

async fn upload_prntscr(bytes: Vec<u8>) -> Result<String> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .cookie_store(true)
        .build()
        .context("failed to create HTTP client")?;

    // Visit the main page to obtain a session cookie
    let _: Result<_, _> = http
        .get("https://prnt.sc/")
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Sec-Fetch-Dest", "document")
        .header("Sec-Fetch-Mode", "navigate")
        .header("Sec-Fetch-Site", "none")
        .header("Sec-Ch-Ua", "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"")
        .header("Sec-Ch-Ua-Mobile", "?0")
        .header("Sec-Ch-Ua-Platform", "\"Windows\"")
        .send()
        .await;

    let file_part = reqwest::multipart::Part::bytes(bytes)
        .file_name("screenshot.png".to_string())
        .mime_str("image/png")
        .map_err(|e| anyhow!("multipart part error: {e}"))?;

    let form = reqwest::multipart::Form::new()
        .part("image", file_part);

    let resp = http
        .post("https://prntscr.com/upload.php")
        .header("Accept", "application/json, text/javascript, */*; q=0.01")
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Referer", "https://prnt.sc/")
        .header("Origin", "https://prnt.sc")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("Sec-Fetch-Dest", "empty")
        .header("Sec-Fetch-Mode", "cors")
        .header("Sec-Fetch-Site", "same-site")
        .header("Sec-Ch-Ua", "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"")
        .header("Sec-Ch-Ua-Mobile", "?0")
        .header("Sec-Ch-Ua-Platform", "\"Windows\"")
        .multipart(form)
        .send()
        .await
        .context("failed to send prnt.sc upload request")?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("prnt.sc upload error ({}): {body}", status.as_u16()));
    }

    let json: serde_json::Value = resp.json().await.context("failed to parse prnt.sc response")?;
    let url = json["data"]
        .as_str()
        .ok_or_else(|| anyhow!("image URL not found in prnt.sc response: {:?}", json))?;

    if !url.starts_with("http") {
        return Err(anyhow!("prnt.sc: {url} (response: {json})"));
    }

    Ok(url.to_string())
}

// ---------------------------------------------------------------------------
// Custom provider
// ---------------------------------------------------------------------------

/// Applies browser-like default headers first, then the provider's custom headers.
/// If the provider defines a header with the same name as a default, the default is skipped
/// so the provider's value wins.
fn apply_custom_headers(
    mut req: reqwest::RequestBuilder,
    provider_headers: &str,
) -> reqwest::RequestBuilder {
    const DEFAULTS: &[(&str, &str)] = &[
        ("Accept",             "*/*"),
        ("Accept-Language",    "en-US,en;q=0.9"),
        ("Sec-Fetch-Dest",     "empty"),
        ("Sec-Fetch-Mode",     "cors"),
        ("Sec-Fetch-Site",     "same-site"),
        ("Sec-Ch-Ua",          "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\""),
        ("Sec-Ch-Ua-Mobile",   "?0"),
        ("Sec-Ch-Ua-Platform", "\"Windows\""),
    ];

    // Collect user-defined header keys (lowercased for case-insensitive comparison)
    let user_keys: std::collections::HashSet<String> = provider_headers
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') { return None; }
            Some(line.split_once(':')?.0.trim().to_lowercase())
        })
        .collect();

    // Add defaults only when user hasn't overridden them
    for (k, v) in DEFAULTS {
        if !user_keys.contains(&k.to_lowercase()) {
            req = req.header(*k, *v);
        }
    }

    // Add user-defined headers (override any default with same name)
    for line in provider_headers.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { continue; }
        if let Some((k, v)) = line.split_once(':') {
            req = req.header(k.trim(), v.trim());
        }
    }

    req
}

/// Build a browser-like HTTP client for custom provider uploads.
/// Pre-visits the Referer URL (if specified in headers) or the upload URL's origin
/// so that any session/Cloudflare cookies are collected before the actual request.
async fn build_custom_http(provider: &CustomProvider) -> reqwest::Result<reqwest::Client> {
    let http = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36")
        .cookie_store(true)
        .build()?;

    // Determine which URL to pre-visit:
    // Use the Referer header value (if user supplied one), otherwise use the upload URL's origin.
    let referer_url: Option<String> = provider.headers.lines().find_map(|line| {
        let line = line.trim();
        let (k, v) = line.split_once(':')?;
        if k.trim().to_lowercase() == "referer" { Some(v.trim().to_string()) } else { None }
    });

    let pre_visit = referer_url.or_else(|| {
        let parsed = url::Url::parse(provider.url.trim()).ok()?;
        Some(format!("{}://{}", parsed.scheme(), parsed.host_str()?))
    });

    if let Some(url) = pre_visit {
        let _ = http.get(&url)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8")
            .header("Accept-Language", "en-US,en;q=0.9")
            .header("Sec-Fetch-Dest", "document")
            .header("Sec-Fetch-Mode", "navigate")
            .header("Sec-Fetch-Site", "none")
            .header("Sec-Ch-Ua", "\"Google Chrome\";v=\"131\", \"Chromium\";v=\"131\", \"Not_A Brand\";v=\"24\"")
            .header("Sec-Ch-Ua-Mobile", "?0")
            .header("Sec-Ch-Ua-Platform", "\"Windows\"")
            .send()
            .await;
    }

    Ok(http)
}

async fn upload_custom(provider: &CustomProvider, file_name: &str, bytes: Vec<u8>) -> Result<String> {
    if provider.url.trim().is_empty() {
        return Err(anyhow!("Custom provider '{}': URL is empty", provider.name));
    }

    let http = build_custom_http(provider).await
        .context("failed to create HTTP client")?;

    // Build base request from method
    let mut req = match provider.method {
        CustomMethod::Get   => http.get(provider.url.trim()),
        CustomMethod::Post  => http.post(provider.url.trim()),
        CustomMethod::Put   => http.put(provider.url.trim()),
        CustomMethod::Patch => http.patch(provider.url.trim()),
    };

    // Attach default browser headers + provider-defined overrides
    req = apply_custom_headers(req, &provider.headers);

    // Parse extra static fields ("key=value" lines)
    let extra: Vec<(String, String)> = provider.extra_fields.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') { return None; }
            let (k, v) = line.split_once('=')?;
            Some((k.trim().to_string(), v.trim().to_string()))
        })
        .collect();

    let mime_type = mime_for_filename(file_name);

    req = match provider.body_type {
        CustomBodyType::Multipart => {
            let mut form = reqwest::multipart::Form::new();
            for (k, v) in &extra {
                form = form.text(k.clone(), v.clone());
            }
            let part = reqwest::multipart::Part::bytes(bytes)
                .file_name(file_name.to_string())
                .mime_str(mime_type)
                .map_err(|e| anyhow!("multipart part error: {e}"))?;
            form = form.part(provider.file_field.clone(), part);
            req.multipart(form)
        }
        CustomBodyType::FormData => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let mut fields: Vec<(String, String)> = extra.clone();
            fields.push((provider.file_field.clone(), b64));
            req.form(&fields)
        }
        CustomBodyType::Json => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let mut obj = serde_json::Map::new();
            for (k, v) in &extra {
                obj.insert(k.clone(), serde_json::Value::String(v.clone()));
            }
            obj.insert(provider.file_field.clone(), serde_json::Value::String(b64));
            req.json(&serde_json::Value::Object(obj))
        }
        CustomBodyType::Binary => {
            req.header("Content-Type", mime_type).body(bytes)
        }
    };

    let resp   = req.send().await.context("request failed")?;
    let status = resp.status();
    let headers = resp.headers().clone();
    let body   = resp.text().await.unwrap_or_default();

    if !status.is_success() {
        return Err(anyhow!("HTTP {}: {body}", status.as_u16()));
    }

    extract_url(provider, &headers, &body)
}

/// Generate a realistic 64×64 PNG test image using the image crate, then convert to target format.
fn make_test_image(target_ext: &str) -> Result<(Vec<u8>, &'static str)> {
    use image::{ImageBuffer, Rgb};
    let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(64, 64, |x, y| {
        Rgb([(x * 4) as u8, (y * 4) as u8, 128u8])
    });
    let mut buf = Vec::new();
    let fmt = match target_ext {
        "jpg" | "jpeg" => { img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)?; "image/jpeg" }
        "gif"          => { img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Gif)?;  "image/gif"  }
        _              => { img.write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)?;  "image/png"  }
    };
    Ok((buf, fmt))
}

/// Send a test image to the custom provider and return the raw response body + status.
pub async fn test_custom_provider(provider: &CustomProvider) -> Result<(u16, String, String)> {
    if provider.url.trim().is_empty() {
        return Err(anyhow!("URL is empty"));
    }

    // Pick the target format: first entry in accepted_formats, else "png"
    let target_ext = provider.accepted_formats.first().map(String::as_str).unwrap_or("png");
    let (test_bytes, mime_type) = make_test_image(target_ext)?;
    let test_filename = format!("test.{target_ext}");

    let http = build_custom_http(provider).await?;

    let mut req = match provider.method {
        CustomMethod::Get   => http.get(provider.url.trim()),
        CustomMethod::Post  => http.post(provider.url.trim()),
        CustomMethod::Put   => http.put(provider.url.trim()),
        CustomMethod::Patch => http.patch(provider.url.trim()),
    };
    req = apply_custom_headers(req, &provider.headers);
    let extra: Vec<(String, String)> = provider.extra_fields.lines().filter_map(|line| {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') { return None; }
        let (k, v) = line.split_once('=')?;
        Some((k.trim().to_string(), v.trim().to_string()))
    }).collect();
    req = match provider.body_type {
        CustomBodyType::Multipart => {
            let mut form = reqwest::multipart::Form::new();
            for (k, v) in &extra { form = form.text(k.clone(), v.clone()); }
            let part = reqwest::multipart::Part::bytes(test_bytes)
                .file_name(test_filename).mime_str(mime_type)?;
            form = form.part(provider.file_field.clone(), part);
            req.multipart(form)
        }
        CustomBodyType::FormData => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&test_bytes);
            let mut fields = extra.clone();
            fields.push((provider.file_field.clone(), b64));
            req.form(&fields)
        }
        CustomBodyType::Json => {
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(&test_bytes);
            let mut obj = serde_json::Map::new();
            for (k, v) in &extra { obj.insert(k.clone(), serde_json::Value::String(v.clone())); }
            obj.insert(provider.file_field.clone(), serde_json::Value::String(b64));
            req.json(&serde_json::Value::Object(obj))
        }
        CustomBodyType::Binary => req.header("Content-Type", mime_type).body(test_bytes),
    };
    let resp    = req.send().await.context("request failed")?;
    let status  = resp.status().as_u16();
    let headers = resp.headers().clone();
    let body    = resp.text().await.unwrap_or_default();
    // Pretty-print JSON if possible
    let pretty = serde_json::from_str::<serde_json::Value>(&body)
        .map(|v| serde_json::to_string_pretty(&v).unwrap_or(body.clone()))
        .unwrap_or(body.clone());
    // Also show response headers as a string
    let hdrs: String = headers.iter()
        .map(|(k, v)| format!("{}: {}", k, v.to_str().unwrap_or("?")))
        .collect::<Vec<_>>().join("\n");
    Ok((status, hdrs, pretty))
}

fn extract_url(
    provider: &CustomProvider,
    headers: &reqwest::header::HeaderMap,
    body: &str,
) -> Result<String> {
    let value = provider.response_value.trim();
    match &provider.response_type {
        CustomResponseType::PlainText => {
            let trimmed = body.trim();
            if trimmed.starts_with("http") {
                Ok(trimmed.to_string())
            } else {
                Err(anyhow!("response body is not a URL: {body}"))
            }
        }

        CustomResponseType::JsonPath => {
            if value.is_empty() {
                return Err(anyhow!("JSON path is empty"));
            }
            let json: serde_json::Value = serde_json::from_str(body)
                .with_context(|| format!("failed to parse JSON response: {body}"))?;
            let mut cur = &json;
            // Normalise bracket notation: "files[0].url" → "files.0.url"
            let normalised = value.replace('[', ".").replace(']', "");
            for key in normalised.split('.').filter(|s| !s.is_empty()) {
                cur = if let Ok(idx) = key.parse::<usize>() {
                    cur.get(idx)
                        .ok_or_else(|| anyhow!("index [{idx}] out of range in response: {json}"))?
                } else {
                    cur.get(key)
                        .ok_or_else(|| anyhow!("key '{key}' not found in response: {json}"))?
                };
            }
            cur.as_str()
                .map(|s| s.to_string())
                .ok_or_else(|| anyhow!("value at '{value}' is not a string: {cur}"))
        }

        CustomResponseType::Header => {
            if value.is_empty() {
                return Err(anyhow!("header name is empty"));
            }
            let hval = headers.get(value)
                .ok_or_else(|| anyhow!("header '{value}' not found in response"))?;
            Ok(hval.to_str().context("header value is not valid UTF-8")?.to_string())
        }

        CustomResponseType::Regex => {
            if value.is_empty() {
                return Err(anyhow!("regex pattern is empty"));
            }
            let re = regex::Regex::new(value)
                .with_context(|| format!("invalid regex: {value}"))?;
            let caps = re.captures(body)
                .ok_or_else(|| anyhow!("regex did not match response: {body}"))?;
            caps.get(1)
                .map(|m| m.as_str().to_string())
                .ok_or_else(|| anyhow!("regex has no capture group 1"))
        }
    }
}

fn mime_for_filename(name: &str) -> &'static str {
    match std::path::Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("") {
        "jpg" | "jpeg" => "image/jpeg",
        "webp"         => "image/webp",
        "gif"          => "image/gif",
        "bmp"          => "image/bmp",
        "avif"         => "image/avif",
        _              => "image/png",
    }
}

// ---------------------------------------------------------------------------
// Common entry point — fallback chain
// ---------------------------------------------------------------------------

async fn upload_single(
    settings: &crate::config::Settings,
    id: &str,
    file_name: &str,
    bytes: &[u8],
) -> Result<String> {
    match id {
        "imgbb" => {
            let key = settings.imgbb_api_key.trim();
            if key.is_empty() {
                return Err(anyhow!("ImgBB API key not set (Settings → Direct Link)"));
            }
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            upload_imgbb(key, &b64).await
        }
        "freeimage" => {
            let key = settings.freeimage_api_key.trim();
            if key.is_empty() {
                return Err(anyhow!("Freeimage.host API key not set (Settings → Direct Link)"));
            }
            use base64::Engine;
            let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
            upload_freeimage(key, &b64).await
        }
        "catbox" => upload_catbox(&settings.catbox_userhash, file_name, bytes.to_vec()).await,
        "prntscr" => upload_prntscr(bytes.to_vec()).await,
        _ => Err(anyhow!("unknown provider: {id}")),
    }
}

pub async fn upload_to_provider(
    settings: &crate::config::Settings,
    file_name: &str,
    bytes: &[u8],
) -> Result<String> {
    // Built-in providers + custom providers merged into a common queue.
    // Each entry: (id, enabled).
    let builtin_enabled: Vec<&str> = settings.direct_link_providers.iter()
        .filter(|p| p.enabled)
        .map(|p| p.id.as_str())
        .collect();
    let custom_enabled: Vec<&CustomProvider> = settings.custom_providers.iter()
        .filter(|p| p.enabled)
        .collect();

    if builtin_enabled.is_empty() && custom_enabled.is_empty() {
        return Err(anyhow!(
            "No direct link provider is enabled (Settings → Direct Link)"
        ));
    }

    let ext = std::path::Path::new(file_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    // Build lookup maps for O(1) access.
    let builtin_map: std::collections::HashMap<&str, bool> = settings.direct_link_providers.iter()
        .filter(|p| p.enabled)
        .map(|p| (p.id.as_str(), true))
        .collect();
    let custom_map: std::collections::HashMap<&str, &CustomProvider> = settings.custom_providers.iter()
        .filter(|p| p.enabled)
        .map(|p| (p.id.as_str(), p))
        .collect();

    // Determine iteration order: use provider_order if set, otherwise fallback.
    let mut ordered_ids: Vec<&str> = if !settings.provider_order.is_empty() {
        settings.provider_order.iter().map(|s| s.as_str()).collect()
    } else {
        builtin_enabled.iter().copied()
            .chain(custom_enabled.iter().map(|p| p.id.as_str()))
            .collect()
    };
    // Append any enabled providers missing from the order list.
    let in_order: std::collections::HashSet<&str> = ordered_ids.iter().copied().collect();
    for id in builtin_enabled.iter().copied() {
        if !in_order.contains(id) { ordered_ids.push(id); }
    }
    for p in custom_enabled.iter() {
        if !in_order.contains(p.id.as_str()) { ordered_ids.push(p.id.as_str()); }
    }

    let mut last_err = String::new();

    for id in ordered_ids {
        if let Some(_) = builtin_map.get(id) {
            let (upload_name, upload_bytes) = if !provider_accepts(id, &ext) {
                match to_png_bytes(bytes) {
                    Ok(png) => {
                        let stem = std::path::Path::new(file_name)
                            .file_stem().and_then(|s| s.to_str()).unwrap_or("screenshot");
                        (format!("{stem}.png"), png)
                    }
                    Err(e) => { last_err = format!("[{id}] PNG conversion failed: {e}"); continue; }
                }
            } else {
                (file_name.to_string(), bytes.to_vec())
            };
            match upload_single(settings, id, &upload_name, &upload_bytes).await {
                Ok(url) => return Ok(url),
                Err(e) => { last_err = format!("[{id}] {e}"); }
            }
        } else if let Some(provider) = custom_map.get(id) {
            // Convert to a supported format if needed
            let (upload_name, upload_bytes) = if !provider.accepted_formats.is_empty()
                && !provider.accepted_formats.iter().any(|f| f == &ext || (f == "jpg" && ext == "jpeg"))
            {
                let target = provider.accepted_formats.first().map(String::as_str).unwrap_or("png");
                let stem = std::path::Path::new(file_name)
                    .file_stem().and_then(|s| s.to_str()).unwrap_or("image");
                match convert_bytes(bytes, target) {
                    Ok(converted) => (format!("{stem}.{target}"), converted),
                    Err(e) => {
                        last_err = format!("[{}] format conversion to {target} failed: {e}", provider.name);
                        continue;
                    }
                }
            } else {
                (file_name.to_string(), bytes.to_vec())
            };
            match upload_custom(provider, &upload_name, upload_bytes).await {
                Ok(url) => return Ok(url),
                Err(e) => { last_err = format!("[{}] {e}", provider.name); }
            }
        }
    }

    Err(anyhow!("{last_err}"))
}

pub fn any_provider_enabled(settings: &crate::config::Settings) -> bool {
    settings.direct_link_providers.iter().any(|p| p.enabled)
        || settings.custom_providers.iter().any(|p| p.enabled)
}
