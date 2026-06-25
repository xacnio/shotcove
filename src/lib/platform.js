// Side-effect import: tags <html> with `is-macos` as early as possible so
// global CSS (see styles.css) can disable backdrop-filter there. WKWebView's
// backdrop-filter combined with this app's transparent/layered NSWindow is
// unstable on macOS (the WebContent process renders garbage or crashes under
// any sustained blur), so it's switched off entirely on that platform only.
export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

if (isMac && typeof document !== "undefined") {
  document.documentElement.classList.add("is-macos");
}
