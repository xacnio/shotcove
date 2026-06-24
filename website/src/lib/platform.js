export function detectPlatform() {
  if (typeof navigator === "undefined") return "windows";
  const ua = navigator.userAgent;
  if (/Mac/.test(ua)) return "macos";
  if (/Linux/.test(ua) && !/Android/.test(ua)) return "linux";
  return "windows";
}

export function formatBytes(bytes) {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

const ASSET_LABELS = {
  ".exe": "Installer (.exe)",
  ".msi": "MSI (.msi)",
  ".dmg": "Disk image (.dmg)",
  ".deb": "Debian package (.deb)",
  ".rpm": "RPM package (.rpm)",
  ".appimage": "AppImage",
};

export function assetLabel(name) {
  const lower = name.toLowerCase();
  for (const [ext, label] of Object.entries(ASSET_LABELS)) {
    if (lower.endsWith(ext)) return label;
  }
  return name;
}
