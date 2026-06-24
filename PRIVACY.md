# Privacy Policy

**Shotcove** values your privacy. The application does not collect, store on a central server, or share any personal user data with the developer or any third party we control.

## 1. Data Collection and Storage

Shotcove is a desktop client. Screenshots, settings, tags, and upload history are stored exclusively on your own device — in your chosen screenshots folder and in `%APPDATA%\dev.xacnio.shotcove\`. Neither the developer nor any server we operate can access this data, because no such server exists; Shotcove has no backend.

## 2. Third-Party Services

The application can communicate directly with the following external services, only for features you enable:

- **Google Drive:** If you connect a Google account, Shotcove requests OAuth access to Google Drive (the `drive.file` and `drive` scopes) so it can upload, list, and manage files in a dedicated folder. The broader `drive` scope specifically lets Shotcove list your existing Drive folders during setup, so that if you've backed up screenshots from this app before (e.g. on a previous computer, or after reinstalling), you can pick that same existing folder instead of starting a new, disconnected one — `drive.file` alone only grants access to files/folders the app creates itself, which would make that folder unreachable for browsing. In day-to-day use, Shotcove's own code only reads or writes within the folder you've selected or it created, but you should be aware that the OAuth grant itself is technically broad enough to permit access to your whole Drive — that boundary is enforced by your trust in the app, not by the permission. The connection uses OAuth 2.0 (PKCE) directly between your device and Google — no Shotcove server is involved. Access tokens are stored only in your OS credential store (Windows Credential Manager, macOS Keychain, or Linux Secret Service), never transmitted elsewhere. By default, Shotcove uses its own OAuth client; you can supply your own Google Cloud OAuth client instead in Settings → Advanced.
- **Direct Link providers (prnt.sc, ImgBB, Freeimage.host, Catbox, or a custom HTTP endpoint you configure):** If enabled, a captured image is uploaded directly from your device to the provider you've configured, using the API key/credentials you provide. Shotcove does not see or store the uploaded image once it leaves your device. Each built-in provider has its own privacy policy: [prnt.sc](https://app.prntscr.com/en/privacy.html), [ImgBB](https://imgbb.com/privacy), [Freeimage.host](https://freeimage.host/privacy), [Catbox](https://catbox.moe/legal.php).
- **GitHub:** Shotcove checks `github.com` for release information to power the in-app update checker and updater. This is an anonymous, unauthenticated request — no personal data is sent.
- **Google Translate:** If you open the in-app Terms of Service or Privacy Policy viewer and the app isn't in English, you can request a machine-translated view. This sends the document text (not personal data) to Google's public translation endpoint and is only triggered by your explicit click — it never happens automatically. The translation is for convenience only; the English text remains authoritative.

Shotcove is not affiliated with or endorsed by Google, prnt.sc/Lightshot, ImgBB, Freeimage.host, Catbox, or GitHub. Use of these services is also subject to their own privacy policies and terms.

## 3. Automatic Updates

The application periodically checks GitHub for new releases (if enabled in Settings). This request contains no personal data and is used solely to determine whether a newer version is available for download.

## 4. Analytics and Telemetry

Shotcove does not include any analytics, telemetry, crash reporting, or tracking code. The developer has no visibility into how you use the app, what you capture, or which accounts you connect.

## 5. Contact

If you have any questions about this policy or the app's privacy practices, please open an [Issue](https://github.com/xacnio/shotcove/issues) on the GitHub repository.

---
*Last updated: June 25, 2026*
