# Privacy Policy

**Shotcove** values your privacy. The application does not collect, store on a central server, or share any personal user data with the developer or any third party we control.

## 1. Data Collection and Storage

Shotcove is a desktop client. Screenshots, settings, tags, and upload history are stored exclusively on your own device — in your chosen screenshots folder and in `%APPDATA%\dev.xacnio.shotcove\`. Neither the developer nor any server we operate can access this data, because no such server exists; Shotcove has no backend.

## 2. Third-Party Services

The application can communicate directly with the following external services, only for features you enable:

- **Google Drive:** If you connect a Google account, Shotcove requests OAuth access to Google Drive using only the `drive.file` scope, which limits access strictly to files and folders created by the app itself. Shotcove cannot read or access any other content in your Drive. The connection uses OAuth 2.0 (PKCE) directly between your device and Google — no Shotcove server is involved. Access tokens are stored only in your OS credential store (Windows Credential Manager, macOS Keychain, or Linux Secret Service), never transmitted elsewhere. By default, Shotcove uses its own OAuth client; you can supply your own Google Cloud OAuth client instead in Settings → Advanced.
- **Direct Link providers (prnt.sc, ImgBB, Freeimage.host, Catbox, or a custom HTTP endpoint you configure):** If enabled, a captured image is uploaded directly from your device to the provider you've configured, using the API key/credentials you provide. Shotcove does not see or store the uploaded image once it leaves your device. Each built-in provider has its own privacy policy: [prnt.sc](https://app.prntscr.com/en/privacy.html), [ImgBB](https://imgbb.com/privacy), [Freeimage.host](https://freeimage.host/privacy), [Catbox](https://catbox.moe/legal.php).
- **GitHub:** Shotcove checks `github.com` for release information to power the in-app update checker and updater. This is an anonymous, unauthenticated request — no personal data is sent.
- **Google Translate:** If you open the in-app Terms of Service or Privacy Policy viewer and the app isn't in English, you can request a machine-translated view. This sends the document text (not personal data) to Google's public translation endpoint and is only triggered by your explicit click — it never happens automatically. The translation is for convenience only; the English text remains authoritative.

Shotcove is not affiliated with or endorsed by Google, prnt.sc/Lightshot, ImgBB, Freeimage.host, Catbox, or GitHub. Use of these services is also subject to their own privacy policies and terms.

## 3. Automatic Updates

The application periodically checks GitHub for new releases (if enabled in Settings). This request contains no personal data and is used solely to determine whether a newer version is available for download.

## 4. Data Protection

All sensitive data handled by Shotcove is protected as follows:

- **OAuth tokens:** Google OAuth access and refresh tokens are stored exclusively in your operating system's secure credential store (Windows Credential Manager, macOS Keychain, or Linux Secret Service). They are never written to plain text files, logs, or transmitted to any server other than Google's own OAuth endpoints.
- **API keys and credentials:** Any API keys you provide for Direct Link providers are stored locally in the app's configuration directory (`%APPDATA%\dev.xacnio.shotcove\` on Windows) on your own device and are never sent anywhere other than the provider you configured.
- **Network connections:** All connections to Google APIs and third-party upload providers use HTTPS/TLS. No Shotcove-operated server sits between your device and these services.
- **No developer access:** Because Shotcove has no backend server, the developer has no technical ability to access, intercept, or read any of your data.

## 5. Google User Data Retention and Deletion

Shotcove stores the following Google-related data locally on your device:

- **OAuth tokens** (access token and refresh token) in your OS credential store.
- **Uploaded file records** (`uploaded.json`) — a map of local file names to their Google Drive file IDs, used to avoid re-uploading the same file.
- **Metadata and icon cache** — synced copies of screenshot metadata and app icons stored in the Shotcove subfolder on your Drive.

**Retention:** This data is kept for as long as your Google account remains connected in Shotcove.

**Deletion:** You can remove all locally stored Google user data at any time by disconnecting your Google account in Settings → Google Drive → Disconnect. This action deletes the OAuth tokens from your OS credential store and clears the local upload records. Files already uploaded to your Google Drive are not deleted by this action — you can remove them directly from Google Drive. Uninstalling the application also removes all locally stored app data including tokens and records. You can also revoke Shotcove's access to your Google account at any time from [Google's app permissions page](https://myaccount.google.com/permissions).

## 6. Analytics and Telemetry

Shotcove does not include any analytics, telemetry, crash reporting, or tracking code. The developer has no visibility into how you use the app, what you capture, or which accounts you connect.

## 7. Contact

If you have any questions about this policy or the app's privacy practices, please open an [Issue](https://github.com/xacnio/shotcove/issues) on the GitHub repository.

---
*Last updated: June 30, 2026*

