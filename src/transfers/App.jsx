import { useState, useEffect, useRef, useCallback } from "react";
import { invoke, listen, convertFileSrc } from "../lib/tauri.js";
import { useT } from "../lib/i18n.js";

// Inline icons
const Ic = ({ size = 14, children, ...p }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {children}
  </svg>
);
const IcGear    = (p) => <Ic {...p}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></Ic>;
const IcFolder  = (p) => <Ic {...p}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></Ic>;
const IcRefresh = (p) => <Ic {...p}><path d="M23 4v6h-6"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></Ic>;
const IcPause   = (p) => <Ic {...p}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></Ic>;
const IcPlay    = (p) => <Ic {...p}><polygon points="5 3 19 12 5 21 5 3"/></Ic>;
const IcCloud   = (p) => <Ic {...p}><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.5 1.5A4 4 0 0 0 6.5 19h11z"/></Ic>;
const IcCheck   = (p) => <Ic {...p}><polyline points="20 6 9 17 4 12"/></Ic>;
const IcUser    = (p) => <Ic {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></Ic>;
const IcGallery = (p) => <Ic {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></Ic>;

// Helpers
function formatBps(bps) {
  if (!bps || bps <= 0) return "";
  if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + " MB/s";
  if (bps >= 1024) return (bps / 1024).toFixed(0) + " KB/s";
  return bps + " B/s";
}

function basename(path) {
  return path.split(/[\\/]/).pop();
}

// Context menu
function CtxMenu({ x, y, item, onClose, t }) {
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  // Adjust so menu stays inside window
  const style = {
    position: "fixed",
    left: Math.min(x, window.innerWidth - 180),
    top: Math.min(y, window.innerHeight - 80),
    zIndex: 9999,
  };

  const action = (fn) => { fn(); onClose(); };

  return (
    <div ref={ref} style={style}
      className="bg-stone-900 border border-stone-700/80 rounded-lg shadow-2xl py-1 min-w-[160px]">
      {item.local_path && (
        <>
          <button
            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-stone-200 hover:bg-stone-700/60 transition-colors text-left"
            onClick={() => action(() => invoke("open_item", { path: item.local_path }))}>
            <IcGallery size={12} /> {t("common.open")}
          </button>
          <button
            className="flex items-center gap-2 w-full px-3 py-2 text-xs text-stone-200 hover:bg-stone-700/60 transition-colors text-left"
            onClick={() => action(() => invoke("reveal_item", { path: item.local_path }))}>
            <IcFolder size={12} /> {t("gallery.context.showInFolder")}
          </button>
        </>
      )}
      {!item.local_path && (
        <div className="px-3 py-2 text-xs text-stone-500">{t("transfers.cloudOnly")}</div>
      )}
    </div>
  );
}

// Screenshot thumbnail
function Thumb({ item, onCtx, t }) {
  const isLocal = !!item.local_path;
  const isSync  = !!(item.drive_id && item.local_path);

  // AVIF files cannot be reliably rendered via the asset protocol in WebView2
  // (MIME type mismatch / missing codec). Always load them via the Rust decoder.
  const isAvif = item.local_path?.toLowerCase().endsWith('.avif');

  const [src, setSrc] = useState(() => {
    if (item.thumb_b64) return `data:image/jpeg;base64,${item.thumb_b64}`;
    if (item.local_path && !isAvif) return convertFileSrc(item.local_path);
    return null;
  });
  const [loading, setLoading] = useState(() => {
    if (item.thumb_b64) return false;
    if (item.local_path) return !!isAvif;
    return !!item.drive_id;
  });

  useEffect(() => {
    if (item.local_path) {
      // AVIF with no pre-encoded thumbnail: decode via Rust (WIC on Windows)
      if (isAvif && !item.thumb_b64) {
        invoke("read_thumbnail", { path: item.local_path, max: 160 })
          .then(b64 => { setSrc(`data:image/jpeg;base64,${b64}`); setLoading(false); })
          .catch(() => setLoading(false));
      } else {
        setLoading(false);
      }
      return;
    }
    if (item.drive_id) {
      setLoading(true);
      invoke("read_drive_thumbnail", { id: item.drive_id, size: 160 })
        .then(b64 => { setSrc(`data:image/jpeg;base64,${b64}`); setLoading(false); })
        .catch(() => {
          if (item.thumb_b64) setSrc(`data:image/jpeg;base64,${item.thumb_b64}`);
          setLoading(false);
        });
    } else if (item.thumb_b64) {
      setSrc(`data:image/jpeg;base64,${item.thumb_b64}`);
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [item.local_path, item.drive_id]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      className="relative bg-stone-900 rounded overflow-hidden cursor-pointer group"
      style={{ aspectRatio: "16/9" }}
      onClick={() => isLocal && invoke("open_item", { path: item.local_path })}
      onContextMenu={(e) => { e.preventDefault(); onCtx(e, item); }}>
      {src ? (
        <img src={src} className="w-full h-full object-cover" draggable={false}
          onError={() => {
            if (item.thumb_b64) setSrc(`data:image/jpeg;base64,${item.thumb_b64}`);
            else setSrc(null);
          }} />
      ) : loading ? (
        <div className="w-full h-full bg-stone-800 animate-pulse" />
      ) : (
        <div className="w-full h-full bg-stone-800 flex items-center justify-center">
          <IcCloud size={16} className="text-stone-600" />
        </div>
      )}
      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-colors" />
      {/* Status badge */}
      {item.drive_id && (
        <span
          title={isSync ? t("transfers.synced") : t("transfers.cloudOnly")}
          className={`absolute bottom-1 right-1 w-4 h-4 rounded-full flex items-center justify-center shadow
            ${isSync ? "bg-emerald-500 text-stone-950" : "bg-stone-800/90 text-amber-400"}`}>
          {isSync ? <IcCheck size={8} /> : <IcCloud size={8} />}
        </span>
      )}
    </div>
  );
}

// Transfer row
function TransferRow({ tr }) {
  const pct  = tr.total > 0 ? Math.round((tr.sent / tr.total) * 100) : 0;
  const name = basename(tr.file);
  const speed = formatBps(tr.bps);

  return (
    <div className="px-3 py-1.5 border-b border-stone-800/40 last:border-0">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          tr.status === "uploading" ? "bg-sky-400 animate-pulse" :
          tr.status === "done"     ? "bg-emerald-400" :
          tr.status === "error"    ? "bg-red-400" : "bg-stone-600"
        }`} />
        <span className="truncate text-[11px] text-stone-300 flex-1 min-w-0">{name}</span>
        {tr.status === "uploading" && tr.total > 0 && (
          <span className="text-[10px] text-stone-500 shrink-0">{pct}%{speed ? ` · ${speed}` : ""}</span>
        )}
        {tr.status === "done"  && <span className="text-[10px] text-emerald-500 shrink-0">✓</span>}
        {tr.status === "error" && <span className="text-[10px] text-red-400 shrink-0">✗</span>}
      </div>
      {tr.status === "uploading" && tr.total > 0 && (
        <div className="mt-1 ml-3.5 h-0.5 bg-stone-700 rounded-full overflow-hidden">
          <div className="h-full bg-sky-500 rounded-full transition-all duration-200" style={{ width: `${pct}%` }} />
        </div>
      )}
      {tr.status === "error" && tr.message && (
        <p className="text-[10px] text-red-400 mt-0.5 ml-3.5 truncate">{tr.message}</p>
      )}
    </div>
  );
}

export default function App() {
  const [driveStatus, setDriveStatus] = useState(null);
  const [transfers,   setTransfers]   = useState(null);
  const [recent,      setRecent]      = useState([]);
  const [ctxMenu,     setCtxMenu]     = useState(null);
  const [lang,        setLang]        = useState("en");

  const t = useT(lang);
  useEffect(() => { document.title = `Shotcove — ${t("transfers.title")}`; }, [lang]);
  const closeCtx = useCallback(() => setCtxMenu(null), []);

  const refreshRecent = useCallback(() => {
    invoke("list_recent_local", { n: 6 })
      .then(setRecent)
      .catch(() => {});
  }, []);

  useEffect(() => { invoke("window_ready").catch(() => {}); }, []);

  useEffect(() => {
    invoke("get_drive_status").then(setDriveStatus).catch(() => {});
    invoke("get_transfers").then(setTransfers).catch(() => {});
    invoke("get_settings").then(s => setLang(s.language ?? "en")).catch(() => {});
    refreshRecent();

    const unsubs = [];
    listen("sync-transfers-changed", (e) => setTransfers(e.payload))
      .then((fn) => unsubs.push(fn));
    listen("screenshot-saved", (e) => {
      const item = e.payload;
      setRecent(prev => [item, ...prev.filter(x => x.name !== item.name)].slice(0, 6));
    }).then((fn) => unsubs.push(fn));
    listen("item-synced", (e) => {
      const { name, drive_id } = e.payload;
      setRecent(prev => prev.map(it => it.name === name ? { ...it, drive_id } : it));
    }).then((fn) => unsubs.push(fn));
    listen("library-changed", refreshRecent)
      .then((fn) => unsubs.push(fn));
    listen("settings-changed", async () => {
      const s = await invoke("get_settings").catch(() => null);
      if (s) setLang(s.language ?? "en");
    }).then((fn) => unsubs.push(fn));
    return () => unsubs.forEach(fn => fn?.());
  }, [refreshRecent]);

  const handleSync = () => invoke("sync_now").catch(() => {});
  const handleTogglePause = () => invoke("toggle_sync_pause").catch(() => {});
  const handleFolder = () => invoke("open_screenshots_folder").catch(() => {});
  const handleSettings = () => invoke("open_settings").catch(() => {});

  const connected = driveStatus?.connected;
  const displayName = driveStatus?.name || driveStatus?.email || "Google Drive";
  const photo = driveStatus?.photo;
  const initial = (driveStatus?.name || driveStatus?.email || "G")[0].toUpperCase();

  const allTransfers = transfers
    ? [...(transfers.active ?? []), ...(transfers.queued ?? []), ...(transfers.history ?? []).slice(0, 5)]
    : [];

  const btnBase = "flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-medium transition-colors";

  return (
    <div className="h-screen bg-stone-950 text-stone-100 flex flex-col select-none overflow-hidden"
      style={{ fontSize: 13 }}>

      {/* Header */}
      <div className="flex items-center gap-2 px-3 pt-3 pb-2.5 shrink-0">
        {connected ? (
          <>
            {photo ? (
              <img src={photo} referrerPolicy="no-referrer"
                className="w-7 h-7 rounded-full object-cover shrink-0" />
            ) : (
              <div className="w-7 h-7 rounded-full bg-gradient-to-br from-violet-500 to-blue-600
                flex items-center justify-center text-[11px] font-bold text-white shrink-0">
                {initial}
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-stone-200 truncate font-medium">{displayName}</p>
              <p className="text-[9px] text-emerald-500 font-medium">{t("settings.drive.connected_plain")}</p>
            </div>
          </>
        ) : (
          <>
            <div className="w-7 h-7 rounded-full bg-stone-800 flex items-center justify-center shrink-0">
              <IcUser size={14} className="text-stone-500" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] text-stone-400">{t("settings.nav.drive.disconnected")}</p>
            </div>
          </>
        )}

        {/* Action icon buttons */}
        <div className="flex items-center gap-0.5 shrink-0">
          {connected && (
            <>
              <button title={t("transfers.syncNow")}
                className="p-1.5 rounded-md text-stone-400 hover:text-stone-100 hover:bg-stone-800 transition-colors"
                onClick={handleSync}>
                <IcRefresh size={13} />
              </button>
              <button title={transfers?.is_paused ? t("transfers.resumeSync") : t("transfers.pauseSync")}
                className="p-1.5 rounded-md text-stone-400 hover:text-stone-100 hover:bg-stone-800 transition-colors"
                onClick={handleTogglePause}>
                {transfers?.is_paused ? <IcPlay size={13} /> : <IcPause size={13} />}
              </button>
            </>
          )}
          <button title={t("transfers.screenshotsFolder")}
            className="p-1.5 rounded-md text-stone-400 hover:text-stone-100 hover:bg-stone-800 transition-colors"
            onClick={handleFolder}>
            <IcFolder size={13} />
          </button>
          <button title={t("common.settings")}
            className="p-1.5 rounded-md text-stone-400 hover:text-stone-100 hover:bg-stone-800 transition-colors"
            onClick={handleSettings}>
            <IcGear size={13} />
          </button>
        </div>
      </div>

      <div className="h-px bg-stone-800/60 shrink-0" />

      {/* Recent screenshots */}
      <div className="px-3 py-2.5 shrink-0">
        <p className="text-[9px] font-semibold uppercase tracking-[0.15em] text-stone-600 mb-2">
          {t("transfers.recentScreenshots")}
        </p>
        {recent.length === 0 ? (
          <p className="text-[11px] text-stone-600 py-4 text-center">{t("transfers.noScreenshots")}</p>
        ) : (
          <div className="grid grid-cols-3 gap-1.5">
            {recent.map((it) => (
              <Thumb
                key={it.name}
                item={it}
                t={t}
                onCtx={(e, item) => setCtxMenu({ x: e.clientX, y: e.clientY, item })}
              />
            ))}
          </div>
        )}
      </div>

      <div className="h-px bg-stone-800/60 shrink-0" />

      {/* Transfers */}
      <div className="flex items-center justify-between px-3 py-2 shrink-0">
        <span className="text-[10px] font-semibold uppercase tracking-[0.15em] text-stone-600">
          {t("transfers.title")}
        </span>
        <div className="flex items-center gap-2 text-[10px]">
          {transfers?.is_paused && (
            <span className="text-amber-400">{t("transfers.paused")}</span>
          )}
          {(transfers?.queued_count ?? 0) > 0 && (
            <span className="text-stone-500">{t("transfers.waiting")(transfers.queued_count)}</span>
          )}
          {(transfers?.total_done ?? 0) > 0 && (
            <span className="text-emerald-500">✓ {transfers.total_done}</span>
          )}
          {(transfers?.total_error ?? 0) > 0 && (
            <span className="text-red-400">✗ {transfers.total_error}</span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {allTransfers.length === 0 ? (
          <div className="flex items-center justify-center h-full text-[11px] text-stone-700">
            {t("transfers.empty")}
          </div>
        ) : (
          allTransfers.map((tr, i) => <TransferRow key={tr.file + i} tr={tr} />)
        )}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <CtxMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          item={ctxMenu.item}
          onClose={closeCtx}
          t={t}
        />
      )}
    </div>
  );
}
