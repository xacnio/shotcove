use super::{DriveClient, DriveFile, API, UPLOAD_API};
use anyhow::{anyhow, bail, Context, Result};
use serde::Deserialize;
use std::time::Duration;

impl DriveClient {
    pub async fn ensure_folder(
        &self,
        client_id: &str,
        client_secret: &str,
        name: &str,
    ) -> Result<String> {
        if let Some(id) = self.folder_id.lock().unwrap().clone() {
            return Ok(id);
        }
        let _init_guard = self.folder_init_lock.lock().await;
        if let Some(id) = self.folder_id.lock().unwrap().clone() {
            return Ok(id);
        }
        let token = self.access_token(client_id, client_secret).await?;
        let query = format!(
            "name='{}' and mimeType='application/vnd.google-apps.folder' and trashed=false",
            name.replace('\'', "\\'")
        );
        let resp = self
            .http
            .get(format!("{API}/files"))
            .query(&[("q", query.as_str()), ("fields", "files(id,name)")])
            .bearer_auth(&token)
            .send()
            .await?;
        #[derive(Deserialize)]
        struct FileList { files: Vec<FileMeta> }
        #[derive(Deserialize)]
        struct FileMeta { id: String }
        if resp.status().is_success() {
            let list: FileList = resp.json().await?;
            if let Some(f) = list.files.into_iter().next() {
                *self.folder_id.lock().unwrap() = Some(f.id.clone());
                return Ok(f.id);
            }
        }
        let resp = self
            .http
            .post(format!("{API}/files"))
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "name": name,
                "mimeType": "application/vnd.google-apps.folder",
            }))
            .send()
            .await?;
        if !resp.status().is_success() {
            bail!("failed to create Drive folder: {}", resp.text().await.unwrap_or_default());
        }
        let meta: FileMeta = resp.json().await?;
        *self.folder_id.lock().unwrap() = Some(meta.id.clone());
        Ok(meta.id)
    }

    pub async fn upload_file_with_progress<F>(
        &self,
        client_id: &str,
        client_secret: &str,
        folder_name: &str,
        path: &std::path::Path,
        drive_file_name: &str,
        on_progress: F,
    ) -> Result<String>
    where
        F: Fn(u64, u64, u64) + Send + Sync + 'static,
    {
        use futures::StreamExt;
        use std::sync::{Arc, atomic::{AtomicU64, Ordering}};

        let folder_id = self.ensure_folder(client_id, client_secret, folder_name).await?;
        let token = self.access_token(client_id, client_secret).await?;
        let file_name = drive_file_name.to_string();
        let bytes = tokio::fs::read(path).await.context("failed to read file")?;
        let total = bytes.len() as u64;
        let mime = mime_for_ext(path);
        let modified_time = modified_rfc3339(path).await;

        const CHUNK: usize = 65536;
        let on_prog = Arc::new(on_progress);
        let mut backoff = Duration::from_millis(800);

        for attempt in 0u8..6 {
            let chunks: Vec<Vec<u8>> = bytes.chunks(CHUNK).map(|c| c.to_vec()).collect();
            let sent_ctr = Arc::new(AtomicU64::new(0));
            let start = std::time::Instant::now();
            let sent2 = sent_ctr.clone();
            let prog2 = on_prog.clone();
            let progress_stream = futures::stream::iter(chunks).map(move |chunk| {
                let n = chunk.len() as u64;
                let sent = sent2.fetch_add(n, Ordering::Relaxed) + n;
                let ms = start.elapsed().as_millis() as u64;
                let bps = if ms > 0 { sent * 1000 / ms } else { 0 };
                prog2(sent, total, bps);
                Ok::<_, std::io::Error>(http_body::Frame::data(bytes::Bytes::from(chunk)))
            });
            let body = reqwest::Body::wrap(http_body_util::StreamBody::new(progress_stream));
            let metadata = {
                let mut obj = serde_json::json!({ "name": &file_name, "parents": [&folder_id] });
                if let Some(ref t) = modified_time { obj["modifiedTime"] = serde_json::Value::String(t.clone()); }
                obj
            };
            let meta_part = reqwest::multipart::Part::text(metadata.to_string()).mime_str("application/json; charset=UTF-8")?;
            let file_part = reqwest::multipart::Part::stream_with_length(body, total).mime_str(mime)?;
            let form = reqwest::multipart::Form::new().part("metadata", meta_part).part("file", file_part);
            let resp = self.http
                .post(format!("{UPLOAD_API}/files?uploadType=multipart&fields=id"))
                .bearer_auth(&token).multipart(form).send().await?;
            if resp.status().as_u16() == 429 {
                if attempt < 5 {
                    let wait = resp.headers().get("Retry-After")
                        .and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok())
                        .map(Duration::from_secs).unwrap_or(backoff);
                    tokio::time::sleep(wait).await;
                    backoff = (backoff * 2).min(Duration::from_secs(30));
                    continue;
                }
                bail!("Drive rate limit: failed after 5 attempts");
            }
            if !resp.status().is_success() {
                bail!("upload failed: {}", resp.text().await.unwrap_or_default());
            }
            #[derive(Deserialize)]
            struct Uploaded { id: String }
            let up: Uploaded = resp.json().await?;
            return Ok(up.id);
        }
        bail!("upload: maximum retry count reached")
    }

    pub async fn share_link(&self, client_id: &str, client_secret: &str, file_id: &str) -> Result<String> {
        let token = self.access_token(client_id, client_secret).await?;
        let resp = self.http
            .post(format!("{API}/files/{file_id}/permissions"))
            .bearer_auth(&token)
            .json(&serde_json::json!({ "role": "reader", "type": "anyone" }))
            .send().await?;
        if !resp.status().is_success() {
            bail!("failed to grant share permission: {}", resp.text().await.unwrap_or_default());
        }
        let resp = self.http
            .get(format!("{API}/files/{file_id}?fields=webViewLink"))
            .bearer_auth(&token).send().await?;
        #[derive(Deserialize)]
        struct Meta { #[serde(rename = "webViewLink")] web_view_link: Option<String> }
        let meta: Meta = resp.json().await?;
        meta.web_view_link.ok_or_else(|| anyhow!("failed to get share link"))
    }

    pub async fn list_files(
        &self,
        client_id: &str,
        client_secret: &str,
        folder_name: &str,
        on_page: impl Fn(usize, usize),
    ) -> Result<(Vec<DriveFile>, bool)> {
        {
            let cache = self.cached_files.lock().unwrap();
            if let Some((ref files, ref instant)) = *cache {
                if instant.elapsed() < Duration::from_secs(30) {
                    return Ok((files.clone(), true));
                }
            }
        }
        let folder_id = self.ensure_folder(client_id, client_secret, folder_name).await?;
        let token = self.access_token(client_id, client_secret).await?;
        let query = format!("'{}' in parents and trashed=false", folder_id);
        let mut all_files: Vec<DriveFile> = Vec::new();
        let mut page_token: Option<String> = None;
        let mut page_no: usize = 0;
        loop {
            let mut params: Vec<(&str, String)> = vec![
                ("q", query.clone()),
                ("fields", "nextPageToken,files(id,name,createdTime,webViewLink,size,mimeType)".to_string()),
                ("orderBy", "createdTime desc".to_string()),
                ("pageSize", "1000".to_string()),
            ];
            if let Some(ref pt) = page_token { params.push(("pageToken", pt.clone())); }
            let resp = self.http.get(format!("{API}/files")).query(&params).bearer_auth(&token).send().await?;
            if !resp.status().is_success() {
                bail!("failed to list Drive files: {}", resp.text().await.unwrap_or_default());
            }
            #[derive(Deserialize)]
            struct L {
                files: Vec<DriveFile>,
                #[serde(rename = "nextPageToken")] next_page_token: Option<String>,
            }
            let l: L = resp.json().await?;
            all_files.extend(l.files.into_iter().filter(|f| {
                f.mime_type.as_deref().map(|m| m.starts_with("image/")).unwrap_or(false)
            }));
            page_no += 1;
            on_page(all_files.len(), page_no);
            page_token = l.next_page_token;
            if page_token.is_none() { break; }
        }
        let mut cache = self.cached_files.lock().unwrap();
        *cache = Some((all_files.clone(), std::time::Instant::now()));
        Ok((all_files, false))
    }

    pub async fn find_file_by_name(
        &self, client_id: &str, client_secret: &str, folder_name: &str, file_name: &str,
    ) -> Result<Option<String>> {
        let folder_id = self.ensure_folder(client_id, client_secret, folder_name).await?;
        let token = self.access_token(client_id, client_secret).await?;
        let escaped = file_name.replace('\\', "\\\\").replace('\'', "\\'");
        let query = format!("name = '{escaped}' and '{folder_id}' in parents and trashed=false");
        let resp = self.http.get(format!("{API}/files"))
            .query(&[("q", query.as_str()), ("fields", "files(id)"), ("pageSize", "1")])
            .bearer_auth(&token).send().await?;
        if !resp.status().is_success() {
            bail!("Drive file search failed: {}", resp.text().await.unwrap_or_default());
        }
        #[derive(Deserialize)]
        struct F { id: String }
        #[derive(Deserialize)]
        struct L { files: Vec<F> }
        let l: L = resp.json().await?;
        Ok(l.files.into_iter().next().map(|f| f.id))
    }

    pub async fn thumbnail(
        &self, client_id: &str, client_secret: &str, file_id: &str, size: u32,
    ) -> Result<Vec<u8>> {
        let token = self.access_token(client_id, client_secret).await?;
        let resp = self.http
            .get(format!("{API}/files/{file_id}?fields=thumbnailLink"))
            .bearer_auth(&token).send().await?;
        #[derive(Deserialize)]
        struct M { #[serde(rename = "thumbnailLink")] thumbnail_link: Option<String> }
        let m: M = resp.json().await?;
        let mut link = m.thumbnail_link.ok_or_else(|| anyhow!("thumbnail link not available"))?;
        if let Some(pos) = link.rfind("=s") { link.truncate(pos); }
        link.push_str(&format!("=s{size}"));
        let resp = self.http.get(&link).bearer_auth(&token).send().await?;
        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            bail!("failed to download thumbnail ({status}): {text}");
        }
        Ok(resp.bytes().await?.to_vec())
    }

    pub async fn storage_quota(&self, client_id: &str, client_secret: &str) -> Result<(Option<u64>, u64)> {
        #[derive(Deserialize)]
        struct Quota { limit: Option<String>, usage: Option<String> }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AboutResp { storage_quota: Quota }
        let token = self.access_token(client_id, client_secret).await?;
        let resp = self.http.get(format!("{API}/about?fields=storageQuota")).bearer_auth(&token).send().await?;
        let about: AboutResp = resp.json().await?;
        let limit = about.storage_quota.limit.as_deref().and_then(|s| s.parse().ok());
        let usage = about.storage_quota.usage.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0);
        Ok((limit, usage))
    }

    pub async fn delete_file(&self, client_id: &str, client_secret: &str, file_id: &str) -> Result<()> {
        let token = self.access_token(client_id, client_secret).await?;
        let resp = self.http.delete(format!("{API}/files/{file_id}")).bearer_auth(&token).send().await?;
        // 404 = the file is already gone from Drive. Deletion is idempotent, so
        // treat "not found" as success rather than surfacing a scary error.
        if resp.status().as_u16() == 404 {
            return Ok(());
        }
        if !resp.status().is_success() {
            bail!("failed to delete file: {}", resp.text().await.unwrap_or_default());
        }
        Ok(())
    }

    pub async fn download_file(&self, client_id: &str, client_secret: &str, file_id: &str) -> Result<Vec<u8>> {
        self.download_file_with_progress(client_id, client_secret, file_id, |_, _, _| {}).await
    }

    pub async fn download_file_with_progress<F>(
        &self, client_id: &str, client_secret: &str, file_id: &str, mut on_progress: F,
    ) -> Result<Vec<u8>>
    where F: FnMut(u64, u64, u64) {
        use futures::StreamExt;
        let token = self.access_token(client_id, client_secret).await?;
        let resp = self.http.get(format!("{API}/files/{file_id}?alt=media")).bearer_auth(&token).send().await?;
        if !resp.status().is_success() {
            bail!("failed to download file: {}", resp.text().await.unwrap_or_default());
        }
        let total = resp.content_length().unwrap_or(0);
        let mut received: u64 = 0;
        let mut buf: Vec<u8> = Vec::with_capacity(total as usize);
        let start = std::time::Instant::now();
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            received += chunk.len() as u64;
            buf.extend_from_slice(&chunk);
            let elapsed = start.elapsed().as_secs_f64().max(0.001);
            let bps = (received as f64 / elapsed) as u64;
            on_progress(received, total, bps);
        }
        Ok(buf)
    }

    pub async fn get_file_modified_time(
        &self, client_id: &str, client_secret: &str, file_id: &str,
    ) -> Result<Option<i64>> {
        let token = self.access_token(client_id, client_secret).await?;
        let resp = self.http.get(format!("{API}/files/{file_id}")).query(&[("fields", "modifiedTime")]).bearer_auth(&token).send().await?;
        if !resp.status().is_success() { return Ok(None); }
        let json: serde_json::Value = resp.json().await?;
        let ts = json["modifiedTime"].as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp());
        Ok(ts)
    }

    pub async fn file_exists(&self, client_id: &str, client_secret: &str, file_id: &str) -> Result<bool> {
        let token = self.access_token(client_id, client_secret).await?;
        let resp = self.http.get(format!("{API}/files/{file_id}")).query(&[("fields", "id,trashed")]).bearer_auth(&token).send().await?;
        if resp.status().is_success() {
            #[derive(Deserialize)]
            struct F { #[serde(default)] trashed: bool }
            let f: F = resp.json().await?;
            Ok(!f.trashed)
        } else if resp.status() == reqwest::StatusCode::NOT_FOUND {
            Ok(false)
        } else {
            bail!("file check failed: {}", resp.text().await.unwrap_or_default());
        }
    }

    pub async fn find_item_in_folder(
        &self, client_id: &str, client_secret: &str, parent_id: &str, name: &str,
    ) -> Result<Option<String>> {
        let token = self.access_token(client_id, client_secret).await?;
        let query = format!("'{}' in parents and name='{}' and trashed=false", parent_id, name.replace('\'', "\\'"));
        let resp = self.http.get(format!("{API}/files"))
            .query(&[("q", query.as_str()), ("fields", "files(id)")])
            .bearer_auth(&token).send().await?;
        #[derive(Deserialize)]
        struct FileList { files: Vec<FileMeta> }
        #[derive(Deserialize)]
        struct FileMeta { id: String }
        if resp.status().is_success() {
            let list: FileList = resp.json().await?;
            if let Some(f) = list.files.into_iter().next() {
                return Ok(Some(f.id));
            }
        }
        Ok(None)
    }

    pub async fn ensure_subfolder(
        &self, client_id: &str, client_secret: &str, parent_id: &str, name: &str,
    ) -> Result<String> {
        if let Some(id) = self.find_item_in_folder(client_id, client_secret, parent_id, name).await? {
            return Ok(id);
        }
        let token = self.access_token(client_id, client_secret).await?;
        let resp = self.http.post(format!("{API}/files"))
            .bearer_auth(&token)
            .json(&serde_json::json!({
                "name": name,
                "mimeType": "application/vnd.google-apps.folder",
                "parents": [parent_id],
            }))
            .send().await?;
        if !resp.status().is_success() {
            bail!("failed to create subfolder: {}", resp.text().await.unwrap_or_default());
        }
        #[derive(Deserialize)]
        struct FileMeta { id: String }
        let meta: FileMeta = resp.json().await?;
        Ok(meta.id)
    }

    pub async fn list_files_in_folder(
        &self, client_id: &str, client_secret: &str, folder_id: &str,
    ) -> Result<Vec<DriveFile>> {
        let token = self.access_token(client_id, client_secret).await?;
        let query = format!("'{}' in parents and trashed=false", folder_id);
        let resp = self.http.get(format!("{API}/files"))
            .query(&[("q", query.as_str()), ("fields", "files(id,name,createdTime,webViewLink,size,mimeType)"), ("pageSize", "1000")])
            .bearer_auth(&token).send().await?;
        if !resp.status().is_success() {
            bail!("failed to list folder files: {}", resp.text().await.unwrap_or_default());
        }
        #[derive(Deserialize)]
        struct L { files: Vec<DriveFile> }
        let l: L = resp.json().await?;
        Ok(l.files)
    }

    pub async fn upload_bytes(
        &self, client_id: &str, client_secret: &str, parent_id: &str,
        file_name: &str, mime_type: &str, bytes: Vec<u8>,
    ) -> Result<String> {
        let token = self.access_token(client_id, client_secret).await?;
        let metadata = serde_json::json!({ "name": file_name, "parents": [parent_id] });
        #[derive(Deserialize)]
        struct Uploaded { id: String }
        let mut backoff = std::time::Duration::from_millis(800);
        for attempt in 0u8..6 {
            let meta_part = reqwest::multipart::Part::text(metadata.to_string()).mime_str("application/json; charset=UTF-8")?;
            let file_part = reqwest::multipart::Part::bytes(bytes.clone()).mime_str(mime_type)?;
            let form = reqwest::multipart::Form::new().part("metadata", meta_part).part("file", file_part);
            let resp = self.http
                .post(format!("{UPLOAD_API}/files?uploadType=multipart&fields=id"))
                .bearer_auth(&token).multipart(form).send().await?;
            if resp.status().as_u16() == 429 {
                if attempt < 5 {
                    let wait = resp.headers().get("Retry-After")
                        .and_then(|v| v.to_str().ok()).and_then(|s| s.parse::<u64>().ok())
                        .map(std::time::Duration::from_secs).unwrap_or(backoff);
                    tokio::time::sleep(wait).await;
                    backoff = (backoff * 2).min(std::time::Duration::from_secs(30));
                    continue;
                }
                bail!("Drive rate limit: failed after 5 attempts");
            }
            if !resp.status().is_success() {
                bail!("upload failed: {}", resp.text().await.unwrap_or_default());
            }
            let up: Uploaded = resp.json().await?;
            return Ok(up.id);
        }
        bail!("upload: maximum retry count reached")
    }

    pub async fn list_root_folders(&self, client_id: &str, client_secret: &str) -> Result<Vec<(String, String)>> {
        let token = self.access_token(client_id, client_secret).await?;
        let query = "mimeType='application/vnd.google-apps.folder' and 'root' in parents and trashed=false";
        let params = vec![
            ("q", query.to_string()),
            ("fields", "files(id,name)".to_string()),
            ("pageSize", "100".to_string()),
            ("orderBy", "name".to_string()),
        ];
        let resp = self.http.get(format!("{API}/files")).query(&params).bearer_auth(&token).send().await?;
        #[derive(Deserialize)]
        struct Folder { id: String, name: String }
        #[derive(Deserialize)]
        struct Resp { files: Vec<Folder> }
        let body: Resp = resp.json().await?;
        Ok(body.files.into_iter().map(|f| (f.id, f.name)).collect())
    }

    pub async fn list_folder_file_names(
        &self, client_id: &str, client_secret: &str, folder_id: &str, limit: u32,
    ) -> Result<Vec<String>> {
        let token = self.access_token(client_id, client_secret).await?;
        let query = format!("'{folder_id}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'");
        let params = vec![
            ("q", query),
            ("fields", "files(name)".to_string()),
            ("pageSize", limit.to_string()),
        ];
        let resp = self.http.get(format!("{API}/files")).query(&params).bearer_auth(&token).send().await?;
        #[derive(Deserialize)]
        struct F { name: String }
        #[derive(Deserialize)]
        struct Resp { files: Vec<F> }
        let body: Resp = resp.json().await?;
        Ok(body.files.into_iter().map(|f| f.name).collect())
    }

    pub async fn update_bytes(
        &self, client_id: &str, client_secret: &str, file_id: &str, bytes: Vec<u8>,
    ) -> Result<()> {
        let token = self.access_token(client_id, client_secret).await?;
        let resp = self.http
            .patch(format!("{UPLOAD_API}/files/{file_id}?uploadType=media"))
            .bearer_auth(&token).body(bytes).send().await?;
        if !resp.status().is_success() {
            bail!("update failed: {}", resp.text().await.unwrap_or_default());
        }
        Ok(())
    }
}

fn mime_for_ext(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("png")  => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("bmp")  => "image/bmp",
        _ => "application/octet-stream",
    }
}

async fn modified_rfc3339(path: &std::path::Path) -> Option<String> {
    tokio::fs::metadata(path).await.ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| {
            chrono::DateTime::<chrono::Utc>::from_timestamp(d.as_secs() as i64, 0)
                .unwrap_or_default()
                .to_rfc3339()
        })
}
