import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { useVirtualizer, elementScroll } from "@tanstack/react-virtual";
import { invoke, listen, convertFileSrc } from "../lib/tauri.js";
import { useT } from "../lib/i18n.js";
import * as Icon from "./icons.jsx";
import TitleBar from "../components/TitleBar.jsx";
import Onboarding from "../onboarding/Onboarding.jsx";
import LegalUpdateModal from "../onboarding/LegalUpdateModal.jsx";
import WhatsNewModal from "../components/WhatsNewModal.jsx";
import UpdateAvailableModal from "../components/UpdateAvailableModal.jsx";
import { LEGAL_VERSION } from "../lib/legal.js";
import { compareVersions } from "../lib/version.js";
import { SHORTCUT_ICON, CAPTURE_TYPE_ICON, shortcutLabel } from "../components/ShortcutEditor.jsx";

// Helpers

function fmtDate(ms, locale = "en-US") {
  if (!ms) return "";
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}
function fmtDateShort(ms, locale = "en-US") {
  if (!ms) return "";
  return new Intl.DateTimeFormat(locale, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(ms));
}
function fmtSize(bytes) {
  if (!bytes) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function fmtSpeed(bps) {
  if (!bps || bps <= 0) return "";
  if (bps >= 1024 * 1024) return (bps / 1024 / 1024).toFixed(1) + " MB/s";
  if (bps >= 1024) return (bps / 1024).toFixed(0) + " KB/s";
  return bps + " B/s";
}
function parseLocalDate(dateStr) {
  if (!dateStr) return new Date();
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function parseTimestampFromFilename(name) {
  if (!name) return null;
  const stem = name.replace(/\.[^/.]+$/, "");

  // 1. Shotcove: YYYY-MM-DD_HH-MM-SS
  const shotcoveMatch = stem.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (shotcoveMatch) {
    const [_, y, m, d, hh, mm, ss] = shotcoveMatch;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  }

  // 2. macOS: Screenshot YYYY-MM-DD at HH.MM.SS
  const macosMatch = stem.match(/(\d{4})-(\d{2})-(\d{2})\sat\s(\d{2})\.(\d{2})\.(\d{2})/);
  if (macosMatch) {
    const [_, y, m, d, hh, mm, ss] = macosMatch;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  }

  // 3. Android: Screenshot_20260611-163658
  const androidMatch = stem.match(/_(\d{8})-(\d{6})/);
  if (androidMatch) {
    const [_, dateStr, timeStr] = androidMatch;
    const y = dateStr.slice(0, 4);
    const m = dateStr.slice(4, 6);
    const d = dateStr.slice(6, 8);
    const hh = timeStr.slice(0, 2);
    const mm = timeStr.slice(2, 4);
    const ss = timeStr.slice(4, 6);
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  }

  // 3b. Android alt: Screenshot_2026-06-11-16-36-58
  const androidAltMatch = stem.match(/_(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/);
  if (androidAltMatch) {
    const [_, y, m, d, hh, mm, ss] = androidAltMatch;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  }

  // 4. Compact: 20260611_163658
  const compactMatch = stem.match(/^(\d{8})_(\d{6})/);
  if (compactMatch) {
    const [_, dateStr, timeStr] = compactMatch;
    const y = dateStr.slice(0, 4);
    const m = dateStr.slice(4, 6);
    const d = dateStr.slice(6, 8);
    const hh = timeStr.slice(0, 2);
    const mm = timeStr.slice(2, 4);
    const ss = timeStr.slice(4, 6);
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  }

  // 5. Genel tarama: YYYY-MM-DD
  const generalMatch = stem.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (generalMatch) {
    const [_, y, m, d] = generalMatch;
    const rest = stem.slice(generalMatch.index + 10);
    const timeMatch = rest.match(/(\d{2})[-:](\d{2})[-:](\d{2})/) || rest.match(/(\d{6})/);
    if (timeMatch) {
      let hh, mm, ss;
      if (timeMatch[1] && timeMatch[2] && timeMatch[3]) {
        [hh, mm, ss] = [timeMatch[1], timeMatch[2], timeMatch[3]];
      } else {
        const t = timeMatch[1];
        hh = t.slice(0, 2);
        mm = t.slice(2, 4);
        ss = t.slice(4, 6);
      }
      return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    }
  }

  return null;
}

const itemDate = (it) => {
  const nameTs = parseTimestampFromFilename(it.name);
  if (nameTs) return nameTs;
  return it.captured ? it.captured * 1000 : it.modified ? it.modified : it.created ? Date.parse(it.created) : 0;
};
const displayName = (it) => {
  const name = it.title || it.name;
  return name.length > 60 ? `${name.slice(0, 60)}…` : name;
};

// Thumbnail cache (module-level so remounts show instantly)
const thumbCache = new Map();

// Concurrency limiter: at most N simultaneous thumbnail IPC calls.
// Accepts an isCancelled() check so unmounted components don't block the queue.
const thumbQueue = (() => {
  let active = 0;
  const max = 5;
  const pending = [];
  const next = () => {
    while (pending.length > 0 && pending[0].isCancelled()) {
      const { reject } = pending.shift();
      reject(new DOMException("cancelled", "AbortError"));
    }
    if (active >= max || pending.length === 0) return;
    active++;
    const { fn, resolve, reject } = pending.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return {
    run: (fn, isCancelled = () => false) =>
      new Promise((resolve, reject) => { pending.push({ fn, resolve, reject, isCancelled }); next(); }),
  };
})();

// Circular progress ring (transfer queue)

function ProgressRing({ pct, size = 34, stroke = 3 }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // Start at 0 on first mount — CSS transition fills the ring when the real value arrives.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(pct));
    return () => cancelAnimationFrame(raf);
  }, [pct]);
  const clamped = Math.min(100, Math.max(0, shown));
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} className="text-stone-800" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (c * clamped) / 100}
          className={`transition-[stroke-dashoffset] duration-300 ${clamped >= 100 ? "text-blue-400 animate-pulse" : "text-blue-500"}`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center tabular-nums text-[8.5px] font-semibold text-stone-300">
        {Math.round(clamped)}%
      </span>
    </div>
  );
}

// Virtual list for transfer panel

function TransferVirtualList({ rows, renderRow, estimate }) {
  const ref = useRef(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => ref.current,
    estimateSize: estimate,
    overscan: 8,
  });
  return (
    <div ref={ref} className="min-h-0 flex-1 overflow-y-auto">
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((vi) => (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={v.measureElement}
            style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}
          >
            {renderRow(rows[vi.index])}
          </div>
        ))}
      </div>
    </div>
  );
}

// Thumbnail component

function Thumb({ cacheKey, localPath, loader, className, thumb_b64 }) {
  // Seed module-level cache from thumb_b64 (e.g. AVIF sidecar from list_library)
  // so the item renders immediately without going through convertFileSrc or loader.
  if (thumb_b64 && cacheKey && !thumbCache.has(cacheKey)) {
    thumbCache.set(cacheKey, `data:image/jpeg;base64,${thumb_b64}`);
  }

  // AVIF files cannot be rendered via the asset protocol in WebView2 (MIME/codec issue).
  // Detect them here so we skip convertFileSrc and use the loader directly instead.
  const isAvif = localPath?.toLowerCase().endsWith('.avif');

  const initSrc = (() => {
    if (cacheKey && thumbCache.has(cacheKey)) return thumbCache.get(cacheKey);
    if (localPath && !isAvif) return convertFileSrc(localPath);
    return null;
  })();

  const ref = useRef(null);
  const [src, setSrc] = useState(initSrc);
  const [err, setErr] = useState(false);

  // Re-evaluate asset URL when localPath changes (skip AVIF — handled by loader below).
  useEffect(() => {
    if (!localPath || isAvif) return;
    if (cacheKey && thumbCache.has(cacheKey)) return;
    setSrc(convertFileSrc(localPath));
    setErr(false);
  }, [localPath, cacheKey, isAvif]);

  // Load thumbnail via loader() when:
  //   - Drive-only item (no localPath), or
  //   - AVIF local item without a cached thumbnail (convertFileSrc can't render AVIF in WebView2)
  useEffect(() => {
    const avifLocal = localPath?.toLowerCase().endsWith('.avif');
    const alreadyCached = cacheKey && thumbCache.has(cacheKey);
    const needsLoader = !localPath || (avifLocal && !alreadyCached);
    if (!needsLoader || !loader) return;

    // Load immediately on mount. The virtualizer only mounts near-viewport
    // rows, and thumbQueue throttles concurrency (max 5) and cancels work for
    // rows that unmount before their turn. (A per-thumb IntersectionObserver
    // was removed — during a programmatic scrubber jump it could miss its
    // initial callback, leaving thumbnails blank until the user scrolled again.)
    let cancelled = false;
    thumbQueue.run(() => loader(), () => cancelled)
      .then((b64) => {
        const url = "data:image/jpeg;base64," + b64;
        if (cacheKey) thumbCache.set(cacheKey, url);
        if (!cancelled) setSrc(url);
      })
      .catch(() => { if (!cancelled) setErr(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localPath, cacheKey]);

  return (
    <div ref={ref} className={className}>
      {src ? (
        <img src={src} className="h-full w-full object-cover" alt="" draggable="false"
          onError={() => {
            const cached = cacheKey ? thumbCache.get(cacheKey) : null;
            if (cached && cached !== src) {
              setSrc(cached);
            } else if (loader && !isAvif) {
              // Non-AVIF asset URL failed — fall back to Rust decoder
              loader()
                .then(b64 => {
                  const url = "data:image/jpeg;base64," + b64;
                  if (cacheKey) thumbCache.set(cacheKey, url);
                  setSrc(url);
                })
                .catch(() => setErr(true));
            } else {
              setErr(true);
            }
          }} />
      ) : err ? (
        <div className="flex h-full w-full items-center justify-center">
          <Icon.Monitor size={28} className="text-stone-700" />
        </div>
      ) : (
        <div className="h-full w-full animate-pulse bg-stone-800" />
      )}
    </div>
  );
}

function PreviewImage({ cacheKey, localPath, load, t }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setSrc(null); setErr(false);
    if (localPath) { setSrc(convertFileSrc(localPath)); return; }
    load()
      .then((b64) => !cancelled && setSrc("data:image/jpeg;base64," + b64))
      .catch(() => !cancelled && setErr(true));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey, localPath]);
  if (err) return <div className="text-sm text-stone-500">{t("gallery.previewLoadError")}</div>;
  if (!src) return (
    <div className="flex items-center gap-2 text-sm text-stone-500">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-stone-600 border-t-stone-300" />
      {t("common.loading")}
    </div>
  );
  return <img src={src} className="max-h-full max-w-full object-contain" alt="" />;
}

// Virtual Grid & List Elements

const GridCard = memo(function GridCard({ it, isSelected, handleCardClick, handleCardContextMenu, openItem, copyItem, deleteItem, toggleSelectItem, appIcons, t, dateLocale, tagMap }) {
  // Content renders immediately: the virtualizer only mounts rows that are
  // near the viewport, and <Thumb> lazily throttles the actual image decode.
  // (A per-card IntersectionObserver gate was removed — it could get stuck
  // "not in view" after a scrubber jump, leaving cards permanently blank.)

  return (
    <div
      data-card-name={it.name}
      className={`gc group relative cursor-pointer rounded-lg bg-stone-900 transition hover:bg-stone-800/80 ${isSelected ? "ring-2 ring-amber-400 bg-amber-500/10" : ""}`}
      onClick={(e) => handleCardClick(e, it)}
      onContextMenu={(e) => handleCardContextMenu(e, it)}
    >
      <div className={`absolute left-2.5 top-2.5 z-10 flex h-5 w-5 items-center justify-center rounded border transition shadow-md backdrop-blur-[2px] ${isSelected ? "border-amber-400 bg-amber-400 text-stone-950" : "border-stone-500 bg-stone-950/60 text-transparent opacity-0 group-hover:opacity-100"}`}
        onClick={(e) => { e.stopPropagation(); toggleSelectItem(it.name); }}>
        <Icon.Check size={11} className="stroke-[3.5]" />
      </div>
      {/* Image area — gc-img has a fixed aspect-ratio, so the card reserves its
          full height before the thumbnail loads. This keeps the measured row
          height constant and prevents virtual-scroll jumps. */}
      <div className="gc-img relative overflow-hidden rounded-t-lg bg-stone-950">
        <Thumb cacheKey={it.drive_id || it.name} localPath={it.local_path}
          loader={it.local_path
            ? () => invoke("read_thumbnail", { path: it.local_path, max: 360 })
            : () => invoke("read_drive_thumbnail", { id: it.drive_id })}
          thumb_b64={it.thumb_b64}
          className="h-full w-full transition duration-200 group-hover:scale-[1.02] group-hover:brightness-90" />
        {it.drive_id && (it.local_path ? (
          <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-emerald-500 text-stone-950 shadow-md" title={t("gallery.card.synced")}><Icon.Check size={10} className="stroke-[3.5]" /></span>
        ) : (
          <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-stone-950/70 text-amber-400 shadow-md backdrop-blur-[2px]" title={t("gallery.card.cloudOnly")}><Icon.Cloud size={11} /></span>
        ))}
        <div className="absolute inset-x-0 bottom-0 flex justify-end gap-1 bg-gradient-to-t from-black/60 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
          <button title={t("gallery.card.open")} onClick={(e) => { e.stopPropagation(); openItem(it); }} className="flex h-6 w-6 items-center justify-center rounded text-stone-200 hover:text-white"><Icon.External size={12} /></button>
          <button title={t("gallery.card.copy")} onClick={(e) => { e.stopPropagation(); copyItem(it); }} className="flex h-6 w-6 items-center justify-center rounded text-stone-200 hover:text-white"><Icon.Copy size={12} /></button>
          <button title={t("gallery.card.delete")} onClick={(e) => { e.stopPropagation(); deleteItem(it); }} className="flex h-6 w-6 items-center justify-center rounded text-stone-200 hover:text-red-400"><Icon.Trash size={12} /></button>
        </div>
      </div>
      <div className="gc-info">
        <div className="gc-title truncate font-medium text-stone-300" title={it.title || it.name}>{it.title || t("common.screenshot")}</div>
        <div className="gc-filename truncate text-[10px] text-stone-500 mt-0.5" title={it.name}>{it.name}</div>
        <div className="gc-date text-stone-600">{fmtDateShort(itemDate(it), dateLocale)}</div>
        <div className="gc-app items-center gap-1 text-[11px] text-stone-500 truncate">
          {it.app && appIcons[it.app] ? <img src={`data:image/png;base64,${appIcons[it.app]}`} className="h-3 w-3 shrink-0 object-contain" alt="" /> : <Icon.Window size={11} className="shrink-0 text-stone-600" />}
          <span className="truncate">{it.app || t("gallery.sidebar.appGeneral")}</span>
        </div>
        {(it.tags || []).length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {(it.tags || []).map(id => tagMap[id]).filter(Boolean).map(tg => (
              <span key={tg.id} className="flex items-center gap-1 rounded-full px-1.5 py-px text-[9px] font-semibold text-white/90 leading-tight"
                style={{ backgroundColor: tg.color + "cc" }}>
                {tg.name}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

const LIST_COLS = "72px 1fr 1fr 130px 115px 80px 52px";

const ListRow = memo(function ListRow({ it, isSelected, handleCardClick, handleCardContextMenu, toggleSelectItem, appIcons, t, dateLocale }) {
  // Content renders immediately (see GridCard) — <Thumb> still throttles the
  // image decode on its own, and rows have a fixed 48px height.
  return (
    <div
      data-card-name={it.name}
      style={{ display: "grid", gridTemplateColumns: LIST_COLS, height: 48, alignItems: "center" }}
      className={`group cursor-pointer border-b border-stone-800/40 transition hover:bg-stone-900/60 text-[12px] ${isSelected ? "bg-amber-500/8 ring-1 ring-inset ring-amber-500/30" : ""}`}
      onClick={(e) => handleCardClick(e, it)}
      onContextMenu={(e) => handleCardContextMenu(e, it)}
    >
      <div className="py-1.5 pl-1 pr-3">
        <div className="relative h-9 w-14 overflow-hidden rounded bg-stone-900 shrink-0">
          <div className={`absolute left-1 top-1 z-10 flex h-4 w-4 items-center justify-center rounded border transition ${isSelected ? "border-amber-400 bg-amber-400 text-stone-950" : "border-stone-600 bg-stone-950/60 text-transparent opacity-0 group-hover:opacity-100"}`}
            onClick={(e) => { e.stopPropagation(); toggleSelectItem(it.name); }}>
            <Icon.Check size={9} className="stroke-[3.5]" />
          </div>
          <Thumb cacheKey={it.drive_id || it.name} localPath={it.local_path}
            loader={it.local_path
              ? () => invoke("read_thumbnail", { path: it.local_path, max: 360 })
              : () => invoke("read_drive_thumbnail", { id: it.drive_id })}
            thumb_b64={it.thumb_b64}
            className="h-full w-full" />
        </div>
      </div>
      <div className="min-w-0 pr-4"><span className="block truncate font-medium text-stone-200">{it.title || t("common.screenshot")}</span></div>
      <div className="min-w-0 pr-4"><span className="block truncate text-stone-500">{it.name}</span></div>
      <div className="min-w-0 pr-4">
        <div className="flex items-center gap-1.5 text-stone-500">
          {it.app && appIcons[it.app] ? <img src={`data:image/png;base64,${appIcons[it.app]}`} className="h-3.5 w-3.5 shrink-0 object-contain" alt="" /> : <Icon.Window size={12} className="shrink-0 text-stone-700" />}
          <span className="truncate">{it.app || t("gallery.sidebar.appGeneral")}</span>
        </div>
      </div>
      <div className="min-w-0 whitespace-nowrap pr-4 text-stone-600">{fmtDateShort(itemDate(it), dateLocale)}</div>
      <div className="min-w-0 whitespace-nowrap pr-4 text-right text-stone-600">{fmtSize(it.size)}</div>
      <div className="min-w-0 text-center">
        <div className="flex items-center justify-center gap-1">
          {it.local_path && <span title={t("gallery.card.local")} className="text-stone-600"><Icon.Monitor size={11} /></span>}
          {it.drive_id && <span title="Drive" className="text-stone-600"><Icon.Cloud size={11} /></span>}
        </div>
      </div>
    </div>
  );
});

// Main component

const isDirectLinkReady = (s) => {
  if (!s) return false;
  const builtinReady = Array.isArray(s.direct_link_providers) && s.direct_link_providers.some((p) => {
    if (!p.enabled) return false;
    if (p.id === "imgbb") return (s.imgbb_api_key || "").trim().length > 0;
    if (p.id === "freeimage") return (s.freeimage_api_key || "").trim().length > 0;
    return true;
  });
  const customReady = Array.isArray(s.custom_providers) &&
    s.custom_providers.some((p) => p.enabled && (p.url || "").trim().length > 0);
  return builtinReady || customReady;
};

export default function App() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [driveEmail, setDriveEmail] = useState(null);
  const [offlineOpsCount, setOfflineOpsCount] = useState(0);
  const [directLinkReady, setDirectLinkReady] = useState(false);
  const [shortcuts, setShortcuts] = useState([]);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [appFilter, setAppFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [preview, setPreview] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [toast, setToast] = useState(null);
  const [appIcons, setAppIcons] = useState({});
  const [contextMenu, setContextMenu] = useState(null);
  const [selectedNames, setSelectedNames] = useState(new Set());
  const [dragStart, setDragStart] = useState(null);
  const [dragEnd, setDragEnd] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragInitialSelected, setDragInitialSelected] = useState(new Set());
  const [mainScrollTop, setMainScrollTop] = useState(0);
  const dragStartScrollTopRef = useRef(0);
  const scrollTopRef = useRef(0);
  const dragCtrlRef = useRef(false);
  const [transfers, setTransfers] = useState({ active: [], queued: [], history: [], queued_count: 0, is_paused: false });
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTab, setTransferTab] = useState("queue"); // "queue" | "history"
  const [storage, setStorage] = useState(null);
  const [freeUpOpen, setFreeUpOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showLegalUpdate, setShowLegalUpdate] = useState(false);
  const [whatsNewReleases, setWhatsNewReleases] = useState(null);
  const [pendingUpdate, setPendingUpdate] = useState(null);
  const [freeUpProgress, setFreeUpProgress] = useState(null); // {done, total, bytes}
  const [loadProgress, setLoadProgress] = useState(null); // {step, count}
  const [viewMode, setViewMode] = useState("medium"); // "2xl"|"xl"|"large"|"medium"|"small"|"list"
  const [sortBy, setSortBy] = useState("date-desc");
  const [groupBy, setGroupBy] = useState("day");
  const [isPending, startTransition] = useTransition();
  const mainRef = useRef(null);
  const dateBtnRef = useRef(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);

  useEffect(() => {
    setDatePickerOpen(false);
  }, [dateFilter]);
  const [containerWidth, setContainerWidth] = useState(1000);
  const loadedIconsRef = useRef(new Set());
  const loadVersionRef = useRef(0);
  const introCheckedRef = useRef(false);
  const toastTimer = useRef(null);
  const reloadTimer = useRef(null);
  const lastDoneRef = useRef(0);
  const libraryReloadTimer = useRef(null);
  const [scrollRatio, setScrollRatio] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState({ clientH: 1, scrollH: 1 });
  const [scrubDragging, setScrubDragging] = useState(false);
  const [scrubLabelText, setScrubLabelText] = useState("");
  const [lang, setLang] = useState("en");
  const [tags, setTags] = useState([]);
  const [tagFilter, setTagFilter] = useState("all");
  const [tagModal, setTagModal] = useState(false);
  const [tagAssignTarget, setTagAssignTarget] = useState(null); // { item, x, y }
  const [modalLocked, setModalLocked] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const scrubTrackRef = useRef(null);
  const scrubTrackRectRef = useRef(null);
  const scrubberSectionsRef = useRef([]);
  const virtualRowsRef = useRef([]);
  const virtualizerRef = useRef(null);
  const closeCtx = useCallback(() => setContextMenu(null), []);

  const t = useT(lang);
  const dateLocale = lang === "tr" ? "tr-TR" : "en-US";
  useEffect(() => { document.title = `Shotcove — ${t("gallery.title")}`; }, [lang]);

  const toggleSelectItem = useCallback((name) => {
    setSelectedNames((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const showToast = useCallback((msg, type = "success") => {
    setToast({ msg, type });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);
  const showError = useCallback((msg) => showToast(msg, "error"), [showToast]);

  const recheckScreenPermission = useCallback(async () => {
    const granted = await invoke("check_screen_permission").catch(() => false);
    setPermissionDenied(!granted);
  }, []);

  // Shows releases newer than the last one the user has seen, up to the
  // current version — not just the latest, so nothing in between is skipped.
  const checkWhatsNew = useCallback(async (settings) => {
    const lastSeen = settings.last_seen_version;
    const current = await invoke("get_app_version").catch(() => null);
    if (!current) return;
    if (lastSeen && compareVersions(current, lastSeen) > 0) {
      const releases = await invoke("get_release_history").catch(() => []);
      const pending = releases
        .filter((r) => compareVersions(r.version, lastSeen) > 0 && compareVersions(r.version, current) <= 0)
        .sort((a, b) => compareVersions(b.version, a.version));
      if (pending.length > 0) {
        setWhatsNewReleases(pending);
        return true;
      }
    }
    if (lastSeen !== current) {
      invoke("save_settings", { settings: { ...settings, last_seen_version: current } });
    }
    return false;
  }, []);

  // Surfaces an update the startup auto-check already found (see
  // get_pending_update) — once per version, and only when nothing else
  // (onboarding/legal/what's-new) is already claiming the screen.
  const checkPendingUpdate = useCallback(async (settings) => {
    const info = await invoke("get_pending_update").catch(() => null);
    if (info && info.version !== settings.last_notified_update_version) {
      setPendingUpdate(info);
    }
  }, []);

  const load = useCallback(async (forceRefresh = false, isBackground = false) => {
    const version = ++loadVersionRef.current;
    if (!isBackground) setLoading(true);
    try {
      const command = forceRefresh ? "refresh_library" : "list_library";
      const [list, status, s, opsCount] = await Promise.all([
        invoke(command),
        invoke("get_drive_status"),
        invoke("get_settings"),
        invoke("get_offline_ops_count"),
      ]);
      // Show onboarding wizard on first load only when the user has not completed it yet.
      // Otherwise, if Terms/Privacy changed since the user last accepted them, re-prompt.
      // Gated on a dedicated ref (not the version below) since StrictMode's dev-mode
      // double-invoke means the version===1 call is often the one discarded as stale.
      if (!introCheckedRef.current) {
        introCheckedRef.current = true;
        if (!s.onboarded) setShowOnboarding(true);
        else if (s.accepted_legal_version !== LEGAL_VERSION) setShowLegalUpdate(true);
        else checkWhatsNew(s).then((shown) => { if (!shown) checkPendingUpdate(s); });
      }
      // Discard stale response if a newer request has started
      if (version !== loadVersionRef.current) return;
      setItems(list);
      setLoadProgress(null);
      setConnected(status.connected);
      setDriveEmail(status.email ?? null);
      setOfflineOpsCount(opsCount);
      setDirectLinkReady(isDirectLinkReady(s));
      setLang(s.language ?? "en");
      setShortcuts(s.shortcuts || []);
      // Do not touch transfers state here — sync-transfers-changed event is the sole authority.
    } catch (e) {
      if (version !== loadVersionRef.current) return;
      showError(t("gallery.toast.listFailed") + " " + e);
    } finally {
      if (version === loadVersionRef.current) setLoading(false);
    }
    invoke("get_storage_info").then(setStorage).catch(() => { });
  }, [showToast, checkWhatsNew, checkPendingUpdate]);

  const scheduleReload = useCallback(() => {
    clearTimeout(reloadTimer.current);
    reloadTimer.current = setTimeout(() => load(false, true), 600);
  }, [load]);

  const reloadImmediate = useCallback(() => {
    clearTimeout(libraryReloadTimer.current);
    libraryReloadTimer.current = setTimeout(() => load(false, true), 50);
  }, [load]);

  useEffect(() => { invoke("main_ready").catch(() => { }); }, []);
  useEffect(() => { invoke("is_gallery_locked").then(setModalLocked).catch(() => { }); }, []);
  useEffect(() => { invoke("check_screen_permission").then((granted) => setPermissionDenied(!granted)).catch(() => { }); }, []);
  useEffect(() => {
    const unlisten = listen("screen-permission-needed", () => setPermissionDenied(true));
    return () => { unlisten.then((f) => f()); };
  }, []);
  // Fetch transfers state only on first mount; updates come via sync-transfers-changed event.
  useEffect(() => { invoke("get_transfers").then(setTransfers).catch(() => { }); }, []);
  useEffect(() => { invoke("get_tags").then(setTags).catch(() => { }); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let unlisten = [];
    (async () => {
      unlisten.push(await listen("library-changed", reloadImmediate));
      unlisten.push(await listen("screenshot-saved", (e) => {
        const item = { drive_id: null, drive_link: null, tags: [], ...e.payload };
        // Cache JPEG thumbnail so Thumb can fall back to it if the asset URL is not yet accessible
        if (item.thumb_b64) {
          thumbCache.set(item.name, "data:image/jpeg;base64," + item.thumb_b64);
        }
        setItems(prev => prev.some(it => it.name === item.name) ? prev : [item, ...prev]);
      }));
      unlisten.push(await listen("loading-progress", (e) => {
        const { step, count, page } = e.payload;
        setLoadProgress(prev => {
          const p = prev || {};
          return {
            ...p,
            step,
            // real-time scan counters
            ...(step === "local-scan" ? { localScan: count } : {}),
            ...(step === "local" ? { localCount: count, localScan: count } : {}),
            ...(step === "drive-scan" ? { driveScan: count, drivePage: page } : {}),
            ...(step === "drive" ? { driveCount: count, driveScan: count } : {}),
          };
        });
      }));
      unlisten.push(await listen("sync-transfers-changed", (e) => {
        setTransfers(e.payload);
        // Only reload gallery if a genuinely new file completed
        const newDone = e.payload.total_done || 0;
        if (newDone > lastDoneRef.current) {
          lastDoneRef.current = newDone;
          scheduleReload();
        }
      }));
      unlisten.push(await listen("item-synced", (e) => {
        const { name, drive_id } = e.payload;
        // Mirror the cached thumbnail under the drive_id key so Thumb can find it after cacheKey switches
        if (drive_id) {
          const cached = thumbCache.get(name);
          if (cached) thumbCache.set(drive_id, cached);
        }
        setItems(prev => prev.map(it => it.name === name ? { ...it, drive_id } : it));
      }));
      unlisten.push(await listen("settings-changed", async () => {
        const s = await invoke("get_settings");
        setDirectLinkReady(isDirectLinkReady(s));
        setLang(s.language ?? "en");
        setShortcuts(s.shortcuts || []);
      }));
      unlisten.push(await listen("gallery-locked", () => setModalLocked(true)));
      unlisten.push(await listen("gallery-unlocked", () => setModalLocked(false)));
      unlisten.push(await listen("show-onboarding", () => {
        setModalLocked(false);
        setShowOnboarding(true);
      }));
      // The gallery window is hidden, not destroyed, on close (see tray.rs
      // show_main), so this never remounts — re-check on every reopen instead
      // of only at first mount, in case Terms/Privacy changed meanwhile.
      unlisten.push(await listen("gallery-opened", async () => {
        const s = await invoke("get_settings");
        if (!s.onboarded) return;
        if (s.accepted_legal_version !== LEGAL_VERSION) setShowLegalUpdate(true);
        else checkWhatsNew(s).then((shown) => { if (!shown) checkPendingUpdate(s); });
      }));
    })();
    return () => {
      unlisten.forEach((u) => u());
      clearTimeout(reloadTimer.current);
      clearTimeout(libraryReloadTimer.current);
      clearTimeout(toastTimer.current);
    };
  }, [scheduleReload, reloadImmediate]);


  // Actions

  const ensureLocal = async (it) => {
    if (it.local_path) return it.local_path;
    if (!it.drive_id) throw new Error("Item has no local path and no Drive ID");
    showToast(t("gallery.toast.downloading"));
    const localPath = await invoke("download_drive_item", { name: it.name, driveId: it.drive_id });
    showToast(t("gallery.toast.downloaded"));
    return localPath;
  };

  const downloadLocalCopy = async (it) => {
    try {
      const path = await ensureLocal(it);
      // Update items and preview immediately after download completes — no need to wait for reload
      setItems(prev => prev.map(x => x.name === it.name ? { ...x, local_path: path } : x));
      setPreview(p => p?.name === it.name ? { ...p, local_path: path } : p);
    } catch (e) {
      showError(t("gallery.toast.error") + " " + e);
    }
  };

  const deleteLocalCopy = async (it) => {
    if (!it.local_path) return;
    // Optimistic update: strip local_path immediately so UI reflects the change at once
    setItems(prev => prev.map(x => x.name === it.name ? { ...x, local_path: null, size: null, modified: null } : x));
    setPreview(p => p?.name === it.name ? { ...p, local_path: null } : p);
    try {
      await invoke("delete_local_copy", { localPath: it.local_path });
      showToast(t("gallery.toast.localCopyDeleted"));
      // library-changed event from Rust triggers a background reload to confirm
    } catch (e) {
      // Rollback on failure
      setItems(prev => prev.map(x => x.name === it.name ? { ...x, local_path: it.local_path, size: it.size, modified: it.modified } : x));
      setPreview(p => p?.name === it.name ? { ...p, local_path: it.local_path } : p);
      showError(t("gallery.toast.error") + " " + e);
    }
  };

  const openItem = async (it) => {
    try {
      const path = await ensureLocal(it);
      invoke("open_item", { path });
    } catch (e) { showError(t("gallery.toast.error") + " " + e); }
  };

  const editItem = async (it) => {
    try {
      const path = await ensureLocal(it);
      await invoke("open_editor_file", { path });
    } catch (e) { showError(t("gallery.toast.error") + " " + e); }
  };

  const revealItem = async (it) => {
    try {
      const path = await ensureLocal(it);
      invoke("reveal_item", { path });
    } catch (e) { showError(t("gallery.toast.error") + " " + e); }
  };

  const copyItem = async (it) => {
    try {
      const path = await ensureLocal(it);
      await invoke("copy_local_image", { path });
      showToast(t("gallery.toast.copied"));
    } catch (e) { showError(t("gallery.toast.error") + " " + e); }
  };

  const uploadItem = async (it) => {
    try {
      showToast(t("gallery.toast.queuing"));
      await invoke("upload_items", { paths: [it.local_path] });
    } catch (e) { showError(t("gallery.toast.error") + " " + e); }
  };

  const copyDriveLink = async (it) => {
    try { await invoke("drive_copy_link", { id: it.drive_id }); showToast(t("gallery.toast.driveLinkCopied")); }
    catch (e) { showError(t("gallery.toast.error") + " " + e); }
  };

  const copyDirectLink = async (it) => {
    try {
      const path = await ensureLocal(it);
      showToast(t("gallery.toast.uploading"));
      await invoke("direct_link_copy_link", { path });
      showToast(t("gallery.toast.directLinkCopied"));
    } catch (e) { showError(t("gallery.toast.error") + " " + e); }
  };

  const deleteItem = (it) => {
    const from = it.local_path && it.drive_id ? t("gallery.confirm.fromBoth") : it.drive_id ? t("gallery.confirm.fromDrive") : t("gallery.confirm.fromLocal");
    // Captured now (while the confirm dialog blocks everything else) so that
    // deleting from the lightbox advances to the next item instead of closing it.
    const i = sortedFiltered.findIndex((x) => x.name === it.name);
    const next = sortedFiltered[i + 1] ?? sortedFiltered[i - 1] ?? null;
    setConfirm({
      message: t("gallery.confirm.single")(displayName(it), from),
      action: async () => {
        // Optimistic removal: drop it from the gallery immediately so it can't
        // be double-deleted while the request is still in flight.
        setItems(prev => prev.filter(x => x.name !== it.name));
        setSelectedNames(prev => { if (!prev.has(it.name)) return prev; const n = new Set(prev); n.delete(it.name); return n; });
        setPreview(p => (p?.name === it.name ? next : p));
        try {
          await invoke("delete_item", { name: it.name, localPath: it.local_path ?? null, driveId: it.drive_id ?? null });
          showToast(t("gallery.toast.deleted"));
          // Do NOT reload here: Drive's file list is eventually consistent, so an
          // immediate re-fetch can still return the just-deleted item and make it
          // reappear. The optimistic removal above is the source of truth.
        } catch (e) {
          showError(t("gallery.toast.error") + " " + e);
          load(); // delete failed — restore the real library state
        }
      },
    });
  };

  const deleteSelected = useCallback(() => {
    const selectedList = items.filter((it) => selectedNames.has(it.name));
    if (selectedList.length === 0) return;
    const from = selectedList.some(it => it.local_path) && selectedList.some(it => it.drive_id)
      ? t("gallery.confirm.fromBoth")
      : selectedList.some(it => it.drive_id)
        ? t("gallery.confirm.fromDrive")
        : t("gallery.confirm.fromLocal");
    setConfirm({
      message: t("gallery.confirm.multi")(selectedList.length, from),
      action: async () => {
        // Optimistic removal: clear them from the gallery up front so they
        // can't be re-selected/re-deleted while requests are in flight.
        const names = new Set(selectedList.map((it) => it.name));
        setItems(prev => prev.filter(x => !names.has(x.name)));
        setSelectedNames(new Set());
        showToast(t("gallery.toast.deleting"));
        let anyFailed = false;
        for (const it of selectedList) {
          try {
            await invoke("delete_item", {
              name: it.name,
              localPath: it.local_path ?? null,
              driveId: it.drive_id ?? null,
            });
          } catch (e) {
            anyFailed = true;
            console.error("Failed to delete item: " + it.name, e);
          }
        }
        showToast(t("gallery.toast.selectedDeleted"));
        // Only reload if something failed — see deleteItem for why we avoid an
        // immediate reload after a successful delete (Drive eventual consistency).
        if (anyFailed) load();
      },
    });
  }, [items, selectedNames, load, showToast]);

  const uploadSelected = useCallback(async () => {
    const selectedList = items.filter((it) => selectedNames.has(it.name) && it.local_path && !it.drive_id);
    if (selectedList.length === 0) return;
    setSelectedNames(new Set());
    try {
      showToast(t("gallery.toast.queuing"));
      await invoke("upload_items", { paths: selectedList.map(it => it.local_path) });
    } catch (e) {
      showError(t("gallery.toast.error") + " " + e);
    }
  }, [items, selectedNames, showToast, t]);

  const downloadSelected = useCallback(async () => {
    const selectedList = items.filter((it) => selectedNames.has(it.name) && !it.local_path && it.drive_id);
    if (selectedList.length === 0) return;
    setSelectedNames(new Set());
    Promise.all(
      selectedList.map((it) =>
        invoke("download_drive_item", { name: it.name, driveId: it.drive_id }).catch((e) =>
          showError(t("gallery.toast.downloadError") + " " + e)
        )
      )
    ).then(() => load());
  }, [items, selectedNames, load, showToast]);

  const copyBulkDriveLinks = useCallback(async () => {
    const selectedList = items.filter((it) => selectedNames.has(it.name) && it.drive_id);
    if (selectedList.length === 0) return;
    setSelectedNames(new Set());
    showToast(t("gallery.toast.driveLinksGetting")(selectedList.length));
    const urls = [];
    for (const it of selectedList) {
      try { urls.push(await invoke("drive_copy_link", { id: it.drive_id })); }
      catch (_) { }
    }
    if (urls.length > 0) {
      await invoke("copy_text", { text: urls.join("\n") });
      showToast(t("gallery.toast.driveLinksGot")(urls.length));
    }
  }, [items, selectedNames, showToast, t]);

  const copyBulkDirectLinks = useCallback(async () => {
    const selectedList = items.filter((it) => selectedNames.has(it.name));
    if (selectedList.length === 0) return;
    setSelectedNames(new Set());
    showToast(t("gallery.toast.directLinksGetting")(selectedList.length));
    const urls = [];
    for (const it of selectedList) {
      try {
        const path = await ensureLocal(it);
        urls.push(await invoke("direct_link_copy_link", { path }));
      } catch (_) { }
    }
    if (urls.length > 0) {
      await invoke("copy_text", { text: urls.join("\n") });
      showToast(t("gallery.toast.directLinksCopied")(urls.length));
    }
  }, [items, selectedNames, ensureLocal, showToast, t]);

  const removeLocalSelected = useCallback(async () => {
    const selectedList = items.filter((it) => selectedNames.has(it.name) && it.local_path && it.drive_id);
    if (selectedList.length === 0) return;
    setSelectedNames(new Set());
    try {
      for (const it of selectedList) {
        await invoke("delete_local_copy", { localPath: it.local_path });
      }
      showToast(t("gallery.toast.selectedLocalRemoved"));
      load();
    } catch (e) {
      showError(t("gallery.toast.error") + " " + e);
    }
  }, [items, selectedNames, load, showToast, t]);

  // Recomputes the intersected cards for the current drag rectangle. The
  // start corner is anchored to its original content position (it moves
  // opposite to scroll, so the box grows/shrinks as the page scrolls under
  // a stationary cursor) while the end corner follows the live mouse.
  const recomputeDragSelection = useCallback((endPt) => {
    if (!dragStart) return;
    const anchoredStartY = dragStart.y - (scrollTopRef.current - dragStartScrollTopRef.current);
    const end = endPt || dragEnd;
    if (!end) return;

    const rect = {
      left: Math.min(dragStart.x, end.x),
      top: Math.min(anchoredStartY, end.y),
      right: Math.max(dragStart.x, end.x),
      bottom: Math.max(anchoredStartY, end.y),
    };

    const intersected = new Set();
    document.querySelectorAll("[data-card-name]").forEach((el) => {
      const name = el.getAttribute("data-card-name");
      const elRect = el.getBoundingClientRect();
      const intersects = !(
        elRect.right < rect.left ||
        elRect.left > rect.right ||
        elRect.bottom < rect.top ||
        elRect.top > rect.bottom
      );
      if (intersects) intersected.add(name);
    });

    setSelectedNames(() => {
      const next = new Set(dragInitialSelected);
      if (dragCtrlRef.current) {
        intersected.forEach((name) => {
          if (dragInitialSelected.has(name)) next.delete(name);
          else next.add(name);
        });
      } else {
        next.clear();
        intersected.forEach((name) => next.add(name));
      }
      return next;
    });
  }, [dragStart, dragEnd, dragInitialSelected]);

  // Multi-selection via mouse drag
  useEffect(() => {
    if (!dragStart) return;

    const handleMouseMove = (e) => {
      if (!isDragging) {
        const dist = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
        if (dist < 4) return;
        setIsDragging(true);
      }
      const current = { x: e.clientX, y: e.clientY };
      setDragEnd(current);
      recomputeDragSelection(current);
    };

    const handleMouseUp = () => {
      setDragStart(null);
      setDragEnd(null);
      setIsDragging(false);
    };

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [dragStart, isDragging, recomputeDragSelection]);

  const handleMouseDown = (e) => {
    if (e.button !== 0) return;
    if (
      e.target.closest("button") ||
      e.target.closest("input") ||
      e.target.closest("[data-card-name]") ||
      e.target.closest("aside") ||
      e.target.closest(".fixed")
    ) {
      return;
    }
    e.preventDefault();
    const startPos = { x: e.clientX, y: e.clientY };
    dragStartScrollTopRef.current = scrollTopRef.current;
    setMainScrollTop(scrollTopRef.current);
    dragCtrlRef.current = e.ctrlKey;
    setDragStart(startPos);
    setDragEnd(startPos);
    setIsDragging(false);
    setDragInitialSelected(new Set(e.ctrlKey ? selectedNames : []));

    if (!e.ctrlKey) {
      setSelectedNames(new Set());
    }
  };

  // Filters
  const apps = useMemo(
    () => [...new Set(items.map((i) => i.app).filter(Boolean))].sort((a, b) => a.localeCompare(b, dateLocale)),
    [items, dateLocale]
  );

  useEffect(() => {
    apps.forEach((a) => {
      if (loadedIconsRef.current.has(a)) return;
      loadedIconsRef.current.add(a);
      invoke("get_app_icon", { appName: a })
        .then((b64) => setAppIcons((prev) => ({ ...prev, [a]: b64 })))
        .catch(() => { });
    });
  }, [apps]);

  const dateOk = useCallback((ms) => {
    if (dateFilter === "all") return true;
    if (!ms) return false;
    
    const now = new Date();
    
    if (dateFilter === "today") {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return ms >= d.getTime();
    }
    
    if (dateFilter === "yesterday") {
      const dStart = new Date();
      dStart.setDate(dStart.getDate() - 1);
      dStart.setHours(0, 0, 0, 0);
      const dEnd = new Date();
      dEnd.setDate(dEnd.getDate() - 1);
      dEnd.setHours(23, 59, 59, 999);
      return ms >= dStart.getTime() && ms <= dEnd.getTime();
    }
    
    if (dateFilter === "week") {
      const d = new Date();
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
      const startOfWeek = new Date(d.setDate(diff));
      startOfWeek.setHours(0, 0, 0, 0);
      return ms >= startOfWeek.getTime();
    }
    
    if (dateFilter === "month") {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      return ms >= startOfMonth.getTime();
    }
    
    if (dateFilter === "year") {
      const startOfYear = new Date(now.getFullYear(), 0, 1);
      return ms >= startOfYear.getTime();
    }
    
    if (dateFilter === "custom-date") {
      if (!customStartDate) return true;
      const start = parseLocalDate(customStartDate);
      start.setHours(0, 0, 0, 0);
      const end = parseLocalDate(customStartDate);
      end.setHours(23, 59, 59, 999);
      return ms >= start.getTime() && ms <= end.getTime();
    }
    
    if (dateFilter === "custom-range") {
      let ok = true;
      if (customStartDate) {
        const start = parseLocalDate(customStartDate);
        start.setHours(0, 0, 0, 0);
        ok = ok && ms >= start.getTime();
      }
      if (customEndDate) {
        const end = parseLocalDate(customEndDate);
        end.setHours(23, 59, 59, 999);
        ok = ok && ms <= end.getTime();
      }
      return ok;
    }
    
    return ms >= Date.now() - Number(dateFilter) * 86400000;
  }, [dateFilter, customStartDate, customEndDate]);

  const tagMap = useMemo(() => Object.fromEntries(tags.map(tg => [tg.id, tg])), [tags]);

  const saveTags = useCallback(async (newTags) => {
    setTags(newTags);
    await invoke("save_tags", { list: newTags }).catch(() => { });
  }, []);

  const setImageTags = useCallback(async (filename, tagIds) => {
    await invoke("set_image_tags", { filename, tagIds }).catch(() => { });
    setItems(prev => prev.map(it => it.name === filename ? { ...it, tags: tagIds } : it));
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () => items.filter((it) => {
      if (source === "local" && !it.local_path) return false;
      if (source === "drive" && !it.drive_id) return false;
      if (appFilter === "__genel__" && it.app) return false;
      if (appFilter !== "all" && appFilter !== "__genel__" && it.app !== appFilter) return false;
      if (!dateOk(itemDate(it))) return false;
      if (tagFilter === "untagged" && (it.tags || []).length > 0) return false;
      if (tagFilter !== "all" && tagFilter !== "untagged" && !(it.tags || []).includes(tagFilter)) return false;
      if (q && !(it.name + " " + (it.title || "")).toLowerCase().includes(q)) return false;
      return true;
    }),
    [items, source, appFilter, dateOk, tagFilter, q]
  );

  const sortedFiltered = useMemo(() => {
    const arr = [...filtered];
    const byName = (a, b) => a.name.localeCompare(b.name, dateLocale);
    switch (sortBy) {
      case "date-asc": return arr.sort((a, b) => (itemDate(a) - itemDate(b)) || byName(a, b));
      case "name-asc": return arr.sort((a, b) => a.name.localeCompare(b.name, dateLocale));
      case "name-desc": return arr.sort((a, b) => b.name.localeCompare(a.name, dateLocale));
      case "size-asc": return arr.sort((a, b) => ((a.size || 0) - (b.size || 0)) || byName(a, b));
      case "size-desc": return arr.sort((a, b) => ((b.size || 0) - (a.size || 0)) || byName(a, b));
      default: return arr.sort((a, b) => (itemDate(b) - itemDate(a)) || byName(a, b)); // date-desc
    }
  }, [filtered, sortBy]);

  const groups = useMemo(() => {
    if (groupBy === "none") return [{ label: null, items: sortedFiltered }];
    const dayFmt = new Intl.DateTimeFormat(dateLocale, { day: "numeric", month: "long", year: "numeric" });
    const monthFmt = new Intl.DateTimeFormat(dateLocale, { month: "long", year: "numeric" });
    const tagMap = Object.fromEntries(tags.map(tg => [tg.id, tg]));
    const map = new Map();
    for (const it of sortedFiltered) {
      const ms = itemDate(it);
      let keys;
      if (groupBy === "day") keys = [ms ? dayFmt.format(new Date(ms)) : t("gallery.groupLabels.unknown")];
      else if (groupBy === "month") keys = [ms ? monthFmt.format(new Date(ms)) : t("gallery.groupLabels.unknown")];
      else if (groupBy === "year") keys = [ms ? String(new Date(ms).getFullYear()) : t("gallery.groupLabels.unknown")];
      else if (groupBy === "app") keys = [it.app || t("gallery.groupLabels.general")];
      else if (groupBy === "tag") {
        const itTags = (it.tags || []).filter(id => tagMap[id]);
        keys = itTags.length > 0 ? itTags.map(id => tagMap[id].name) : [t("gallery.groupLabels.untagged")];
      }
      else keys = [it.local_path && it.drive_id ? t("gallery.groupLabels.synced") : it.drive_id ? t("gallery.groupLabels.driveOnly") : t("gallery.groupLabels.localOnly")];
      for (const key of keys) {
        if (!map.has(key)) map.set(key, []);
        if (!map.get(key).includes(it)) map.get(key).push(it);
      }
    }
    return [...map.entries()].map(([label, items]) => ({ label, items }));
  }, [sortedFiltered, groupBy, dateLocale, t, tags]);

  // Column count: calculated from container width and viewMode
  const cols = useMemo(() => {
    const minW = { "2xl": 500, "xl": 340, "large": 240, "medium": 170, "small": 110 }[viewMode] ?? 170;
    return Math.max(1, Math.floor((containerWidth + 10) / (minW + 10)));
  }, [viewMode, containerWidth]);

  // Estimated row height — matches actual rendered card geometry as closely as possible
  // to keep ResizeObserver deltas near zero (< 1px per item).
  // gc-img: aspect-ratio 16/10 (10/16) or 16/9 (9/16) for 2xl.
  // gc-info non-small: pad(8+10) + title(12×1.4=16.8) + filename(2+15) + date(3+15) + app(4+16.5) ≈ 90.3px
  // gc-info small:     pad(4+6)  + title(10×1.4=14)   + date(2+13.5) ≈ 39.5px
  const cardRowHeight = useMemo(() => {
    if (!containerWidth || !cols) return 208;
    const gap = 10;
    const cardW = (containerWidth - (cols - 1) * gap) / cols;
    const imgH = cardW * (viewMode === "2xl" ? 9 / 16 : 10 / 16);
    const infoH = viewMode === "small" ? 39.5 : 90.3;
    return imgH + infoH + gap;
  }, [containerWidth, cols, viewMode]);

  // Flatten groups → flat row list for virtual scroll
  const virtualRows = useMemo(() => {
    let firstHeader = true;
    if (viewMode === "list") {
      const rows = [];
      for (const { label, items: gItems } of groups) {
        if (label) { rows.push({ type: "header", label, count: gItems.length, isFirst: firstHeader }); firstHeader = false; }
        for (const it of gItems) rows.push({ type: "list-item", it });
      }
      return rows;
    }
    const rows = [];
    for (const { label, items: gItems } of groups) {
      if (label) { rows.push({ type: "header", label, count: gItems.length, isFirst: firstHeader }); firstHeader = false; }
      for (let i = 0; i < gItems.length; i += cols) {
        rows.push({ type: "grid-row", items: gItems.slice(i, i + cols) });
      }
    }
    return rows;
  }, [groups, viewMode, cols]);

  const gridColsClass =
    viewMode === "2xl" ? "grid-cols-[repeat(auto-fill,minmax(500px,1fr))]" :
      viewMode === "xl" ? "grid-cols-[repeat(auto-fill,minmax(340px,1fr))]" :
        viewMode === "large" ? "grid-cols-[repeat(auto-fill,minmax(240px,1fr))]" :
          viewMode === "small" ? "grid-cols-[repeat(auto-fill,minmax(110px,1fr))]" :
            "grid-cols-[repeat(auto-fill,minmax(170px,1fr))]";

  // Virtual scroll virtualizer
  const virtualizer = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => mainRef.current,
    estimateSize: (i) => {
      const row = virtualRows[i];
      // First header has pt-0 (~27px actual); subsequent headers have pt-5 (~46px actual).
      if (!row || row.type === "header") return row?.isFirst ? 28 : 46;
      if (row.type === "list-item") return 48;
      return cardRowHeight;
    },
    overscan: 2,
    paddingEnd: 20,
    isScrollingResetDelay: 500,
    scrollToFn: elementScroll,
  });

  // Scrubber: section map from virtualRows
  const scrubberSections = useMemo(() => {
    if (groupBy === "none" || !virtualRows.length) return [];
    const sections = [];
    let cur = null;
    for (let i = 0; i < virtualRows.length; i++) {
      const row = virtualRows[i];
      if (row.type === "header") {
        if (cur) { cur.rowCount = i - cur.startIdx; sections.push(cur); }
        cur = { label: row.label, count: row.count, startIdx: i, rowCount: 0 };
      }
    }
    if (cur) { cur.rowCount = virtualRows.length - cur.startIdx; sections.push(cur); }
    return sections;
  }, [virtualRows, groupBy]);

  // Year boundary markers for the scrubber (day/month grouping only)
  const yearMarkers = useMemo(() => {
    if ((groupBy !== "day" && groupBy !== "month" && groupBy !== "year") || scrubberSections.length <= 1) return [];
    const total = virtualRows.length;
    if (total <= 1) return [];
    const markers = [];
    let lastYear = null;
    let lastTopPct = -Infinity;
    for (const sec of scrubberSections) {
      const m = sec.label.match(/\b(19|20)\d{2}\b/);
      if (!m) continue;
      const year = m[0];
      const topPct = (sec.startIdx / (total - 1)) * 100;
      if (year !== lastYear && topPct - lastTopPct >= 4) {
        markers.push({ year, topPct });
        lastYear = year;
        lastTopPct = topPct;
      }
    }
    return markers;
  }, [scrubberSections, groupBy, virtualRows.length]);

  // Keep refs current so drag closures always read latest data
  scrubberSectionsRef.current = scrubberSections;
  virtualRowsRef.current = virtualRows;
  virtualizerRef.current = virtualizer;

  // Adjust scrollTop when an item above the viewport changes size, regardless
  // of scroll direction. TanStack's default suppresses this during backward
  // (upward) scroll, but that causes content to jump when items near the
  // viewport are measured for the first time after a scrubber jump.
  virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) =>
    item.start < instance.getScrollOffset() + instance.scrollAdjustments;

  const handleGalleryScroll = useCallback((e) => {
    const el = e.currentTarget;
    const max = el.scrollHeight - el.clientHeight;
    setScrollRatio(max > 0 ? el.scrollTop / max : 0);
    setScrollMetrics({ clientH: el.clientHeight, scrollH: el.scrollHeight });
    scrollTopRef.current = el.scrollTop;
    if (dragStart) {
      setMainScrollTop(el.scrollTop);
      recomputeDragSelection();
    }
  }, [dragStart, recomputeDragSelection]);

  const handleScrubMouseDown = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    const track = scrubTrackRef.current;
    if (!track) return;
    scrubTrackRectRef.current = track.getBoundingClientRect();
    setScrubDragging(true);

    const updateFromY = (clientY) => {
      const rect = track.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      const vRows = virtualRowsRef.current;
      // scrollToIndex uses getOffsetForIndex which is more accurate than
      // ratio * totalHeight (estimated total drifts as items are measured).
      // Cancel the reconcile loop immediately so it cannot fight wheel scroll.
      const targetIdx = Math.round(ratio * Math.max(0, vRows.length - 1));
      const virt = virtualizerRef.current;
      if (virt) {
        virt.scrollToIndex(targetIdx, { align: "start", behavior: "auto" });
        virt.scrollState = null;
      }
      setScrollRatio(ratio);
      // Find current group label
      const sections = scrubberSectionsRef.current;
      let label = sections.length ? sections[0].label : "";
      for (const sec of sections) {
        if (sec.startIdx <= targetIdx) label = sec.label;
        else break;
      }
      setScrubLabelText(label);
    };

    updateFromY(e.clientY);

    const onMove = (ev) => updateFromY(ev.clientY);
    const onUp = () => {
      setScrubDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // Clear the virtualizer size cache when card dimensions change (window resize
  // or viewMode change) so stale measured heights don't produce scroll jumps.
  useEffect(() => {
    virtualizerRef.current?.measure();
  }, [cardRowHeight]);

  // Scroll to top when filter/mode changes
  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [source, viewMode, sortBy, groupBy, appFilter, dateFilter, customStartDate, customEndDate]);

  // Measure container width and scroll metrics
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    setContainerWidth(el.clientWidth - 40);
    setScrollMetrics({ clientH: el.clientHeight, scrollH: el.scrollHeight });
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth - 40);
      setScrollMetrics({ clientH: el.clientHeight, scrollH: el.scrollHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleCardClick = useCallback((e, it) => {
    if (e.ctrlKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleSelectItem(it.name);
    } else {
      if (selectedNames.size > 0) {
        e.stopPropagation();
        setSelectedNames(new Set([it.name]));
      } else {
        setPreview(it);
      }
    }
  }, [selectedNames, toggleSelectItem]);

  const handleCardContextMenu = useCallback((e, it) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ item: it, x: e.clientX, y: e.clientY });
  }, []);

  const previewIdx = preview ? sortedFiltered.findIndex((x) => x.name === preview.name) : -1;

  // Keyboard: lightbox esc + arrow keys and Ctrl+A select-all
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        if (confirm) {
          setConfirm(null);
        } else if (preview) {
          setPreview(null);
        } else if (selectedNames.size > 0) {
          setSelectedNames(new Set());
        }
        setContextMenu(null);
      }
      if (e.key === "Enter" && confirm) {
        e.preventDefault();
        const fn = confirm.action;
        setConfirm(null);
        Promise.resolve(fn()).catch((err) => showError(t("gallery.toast.error") + " " + err));
      }
      if (preview && !confirm) {
        if (e.key === "ArrowRight") setPreview((p) => {
          const i = filtered.findIndex((x) => x.name === p.name);
          return sortedFiltered[i + 1] ?? p;
        });
        if (e.key === "ArrowLeft") setPreview((p) => {
          const i = filtered.findIndex((x) => x.name === p.name);
          return sortedFiltered[i - 1] ?? p;
        });
        if ((e.key === "Delete" || e.key === "Backspace")
          && document.activeElement?.tagName !== "INPUT" && document.activeElement?.tagName !== "TEXTAREA") {
          e.preventDefault();
          deleteItem(preview);
        }
      }
    };
    const onKeyDownGlobal = (e) => {
      if (e.ctrlKey && (e.key === "a" || e.key === "A")) {
        if (document.activeElement.tagName === "INPUT" || document.activeElement.tagName === "TEXTAREA") {
          return;
        }
        e.preventDefault();
        setSelectedNames(new Set(sortedFiltered.map((it) => it.name)));
      }
    };

    window.addEventListener("keydown", onKey);
    window.addEventListener("keydown", onKeyDownGlobal);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keydown", onKeyDownGlobal);
    };
  }, [preview, filtered, selectedNames, confirm]);

  // JSX

  return (
    <div className="flex h-screen flex-col bg-stone-950 text-stone-100 animate-fade-in">
      <TitleBar lang={lang} />
      <div className="relative flex flex-1 min-h-0">
        {modalLocked && (
          <div
            className="absolute inset-0 z-[9999] cursor-not-allowed bg-black/50"
            onMouseDown={() => invoke("flash_settings")}
          />
        )}

        {/* Onboarding wizard */}
        {showOnboarding && (
          <Onboarding onClose={() => { setShowOnboarding(false); load(); }} />
        )}

        {/* Terms/Privacy re-acceptance after either doc changes */}
        {showLegalUpdate && (
          <LegalUpdateModal t={t} lang={lang} onAccept={async () => {
            setShowLegalUpdate(false);
            const s = await invoke("get_settings");
            const shown = await checkWhatsNew(s);
            if (!shown) checkPendingUpdate(s);
          }} />
        )}

        {/* What's New since the last version the user saw */}
        {whatsNewReleases && (
          <WhatsNewModal releases={whatsNewReleases} lang={lang} t={t} onClose={async () => {
            const s = await invoke("get_settings");
            const current = await invoke("get_app_version").catch(() => null);
            if (current) invoke("save_settings", { settings: { ...s, last_seen_version: current } });
            setWhatsNewReleases(null);
            checkPendingUpdate(s);
          }} />
        )}

        {/* Update found by the startup auto-check */}
        {pendingUpdate && (
          <UpdateAvailableModal info={pendingUpdate} t={t} onClose={async () => {
            const s = await invoke("get_settings");
            invoke("save_settings", { settings: { ...s, last_notified_update_version: pendingUpdate.version } });
            setPendingUpdate(null);
          }} />
        )}

        {/* macOS Screen Recording permission modal */}
        {permissionDenied && (
          <ScreenPermissionModal t={t} onRetry={recheckScreenPermission} />
        )}

        {/* Left sidebar */}
        <aside className="relative flex w-52 shrink-0 flex-col border-r border-stone-800/50 bg-stone-950">

          {/* Scrollable top area */}
          <div className="flex flex-1 flex-col overflow-y-auto min-h-0">

            {/* Gallery header + stats + transfer badge */}
            <div className="flex items-center justify-between px-4 pb-3 pt-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-stone-500">{t("gallery.title")}</p>
                <p className="mt-0.5 text-xs text-stone-600">{t("gallery.imageCount")(items.length)}</p>
              </div>
              {/* Transfer badge button */}
              {(() => {
                const queued = transfers.queued_count || 0;
                const uploading = (transfers.active || []).length;
                const errors = transfers.total_error || 0;
                const active = uploading + queued;
                const isPaused = transfers.is_paused || false;
                const hasBadge = (transfers.active || []).length > 0 || (transfers.queued || []).length > 0 || (transfers.history || []).length > 0 || (transfers.queued_count || 0) > 0 || (transfers.total_done || 0) > 0;
                const badgeCls = isPaused ? "bg-stone-500" : uploading ? "bg-blue-500" : queued ? "bg-amber-500" : errors ? "bg-red-500" : "bg-emerald-600";
                const badgeLabel = isPaused ? "⏸" : active ? (active > 99 ? "99+" : String(active))
                  : errors ? (errors > 99 ? "99+" : String(errors))
                    : "✓";
                return (
                  <button
                    onClick={() => setTransferOpen(o => !o)}
                    className={`relative rounded-lg p-1.5 transition hover:bg-stone-800 ${transferOpen ? "text-stone-200 bg-stone-800" : "text-stone-500 hover:text-stone-300"}`}
                    title={t("gallery.transfer.title")}
                  >
                    <Icon.CloudUpload size={18} />
                    {hasBadge && (
                      <span className={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none text-white ${badgeCls} ${uploading ? "animate-pulse" : ""}`}>
                        {badgeLabel}
                      </span>
                    )}
                  </button>
                );
              })()}
            </div>

            {/* Source nav */}
            <nav className="px-2">
              <p className="mb-1 px-2 text-[9px] font-semibold uppercase tracking-[0.2em] text-stone-700 animate-fade-in-simple" style={{ animationDelay: "40ms" }}>{t("gallery.sidebar.source")}</p>
              {[
                { id: "all", label: t("gallery.sidebar.all"), icon: <Icon.LayoutGrid size={14} /> },
                { id: "local", label: t("gallery.sidebar.local"), icon: <Icon.Monitor size={14} /> },
                { id: "drive", label: t("gallery.sidebar.drive"), icon: <Icon.Cloud size={14} /> },
              ].map(({ id, label, icon }, i) => (
                <div key={id} className="animate-sidebar-item" style={{ animationDelay: `${60 + i * 40}ms` }}>
                  <NavItem active={source === id} onClick={() => startTransition(() => setSource(id))} icon={icon}>
                    {label}
                  </NavItem>
                </div>
              ))}
            </nav>

            <div className="mx-3 my-2 border-t border-stone-800/50" />

            {/* Capture nav — one button per configured shortcut */}
            {shortcuts.length > 0 && (
              <nav className="px-2">
                <p className="mb-1.5 px-2 text-[9px] font-semibold uppercase tracking-[0.2em] text-stone-700 animate-fade-in-simple" style={{ animationDelay: "110ms" }}>{t("gallery.sidebar.capture")}</p>
                <div className="flex items-center gap-1.5 px-2 flex-wrap">
                  {shortcuts.map((s, i) => {
                    const IconComp = SHORTCUT_ICON[s.icon] || SHORTCUT_ICON[CAPTURE_TYPE_ICON[s.capture]] || Icon.Crop;
                    return (
                      <button
                        key={s.id}
                        onClick={() => invoke("take_screenshot", { slotId: s.id }).catch(() => {})}
                        title={shortcutLabel(s, t)}
                        className="animate-sidebar-item flex h-8 w-8 items-center justify-center rounded-lg text-stone-400 transition hover:bg-stone-800 hover:text-stone-200"
                        style={{ animationDelay: `${130 + i * 35}ms` }}
                      >
                        <IconComp size={15} />
                      </button>
                    );
                  })}
                </div>
              </nav>
            )}

            {/* App filter */}
            {(apps.length > 0 || items.some(i => !i.app)) && (
              <>
                <div className="mx-3 my-2 border-t border-stone-800/50" />
                <nav className="px-2 pb-2">
                  <p className="mb-1 px-2 text-[9px] font-semibold uppercase tracking-[0.2em] text-stone-700">{t("gallery.sidebar.app")}</p>
                  <NavItem active={appFilter === "all"} onClick={() => startTransition(() => setAppFilter("all"))}>{t("gallery.sidebar.appAll")}</NavItem>
                  {items.some(i => !i.app) && (
                    <NavItem
                      active={appFilter === "__genel__"}
                      onClick={() => startTransition(() => setAppFilter("__genel__"))}
                      icon={<Icon.Window size={14} />}
                    >
                      <span className="truncate">{t("gallery.sidebar.appGeneral")}</span>
                    </NavItem>
                  )}
                  {apps.map((a) => (
                    <NavItem
                      key={a}
                      active={appFilter === a}
                      onClick={() => startTransition(() => setAppFilter(a))}
                      title={a}
                      icon={
                        appIcons[a]
                          ? <img src={`data:image/png;base64,${appIcons[a]}`} className="h-[14px] w-[14px] shrink-0 object-contain" alt="" />
                          : <Icon.Window size={14} />
                      }
                    >
                      <span className="truncate">{a}</span>
                    </NavItem>
                  ))}
                </nav>
              </>
            )}

            {/* Tags filter */}
            <>
              <div className="mx-3 my-2 border-t border-stone-800/50" />
              <nav className="px-2 pb-2">
                <div className="mb-1 flex items-center justify-between px-2">
                  <p className="text-[9px] font-semibold uppercase tracking-[0.2em] text-stone-700">{t("gallery.tags.title")}</p>
                  <button
                    onClick={() => setTagModal(true)}
                    className="flex h-4 w-4 items-center justify-center rounded text-stone-600 hover:bg-stone-800 hover:text-stone-300 transition"
                    title={t("gallery.tags.manage")}
                  >
                    <Icon.Gear size={11} />
                  </button>
                </div>
                <NavItem active={tagFilter === "all"} onClick={() => startTransition(() => setTagFilter("all"))}>{t("gallery.tags.allTags")}</NavItem>
                <NavItem active={tagFilter === "untagged"} onClick={() => startTransition(() => setTagFilter("untagged"))}>{t("gallery.tags.untagged")}</NavItem>
                {tags.map((tg) => (
                  <NavItem
                    key={tg.id}
                    active={tagFilter === tg.id}
                    onClick={() => startTransition(() => setTagFilter(tg.id))}
                    barColor={tg.color}
                  >
                    <span className="truncate">{tg.name}</span>
                  </NavItem>
                ))}
                {tags.length === 0 && (
                  <button
                    onClick={() => setTagModal(true)}
                    className="mt-1 w-full rounded-lg border border-dashed border-stone-700 py-1.5 text-[11px] text-stone-600 transition hover:border-stone-600 hover:text-stone-500"
                  >
                    + {t("gallery.tags.createTag")}
                  </button>
                )}
              </nav>
            </>

          </div>{/* /scrollable */}

          {/* Bottom nav — fixed, outside scroll */}
          <nav className="shrink-0 border-t border-stone-800/50 px-2 py-2 animate-fade-in-simple" style={{ animationDelay: "280ms" }}>
            {connected ? (
              <div className="mb-1 flex items-center gap-2 px-2 py-1 text-[11px] text-emerald-500">
                <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                {t("gallery.sidebar.driveConnected")}
              </div>
            ) : driveEmail && (
              <div className="mb-1 flex items-center gap-2 px-2 py-1 text-[11px] text-amber-400/80" title={driveEmail}>
                <svg className="shrink-0" width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <circle cx="4" cy="4" r="3.5" stroke="currentColor" strokeWidth="1" />
                  <rect x="3.5" y="2" width="1" height="2.5" rx="0.5" fill="currentColor" />
                  <rect x="3.5" y="5.5" width="1" height="1" rx="0.5" fill="currentColor" />
                </svg>
                {offlineOpsCount > 0
                  ? t("gallery.sidebar.driveOfflinePending")(offlineOpsCount)
                  : t("gallery.sidebar.driveOffline")}
              </div>
            )}

            {/* Refresh row with inline sync controls */}
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => load(true)}
                disabled={loading}
                title={t("gallery.sidebar.refresh")}
                className="group relative flex flex-1 items-center gap-2.5 rounded-lg px-2 py-2 text-[13px] font-medium transition-all duration-150 text-stone-400 hover:bg-stone-800/60 hover:text-stone-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none"
              >
                <span className={`shrink-0 ${loading ? "animate-spin" : "transition-transform duration-150 group-hover:scale-110"}`}>
                  <Icon.Refresh size={14} />
                </span>
                <span className="truncate">{t("gallery.sidebar.refresh")}</span>
              </button>

              {connected && (() => {
                const isPaused = transfers.is_paused || false;
                const hasQueue = ((transfers.active || []).length + (transfers.queued_count || 0)) > 0;
                return (
                  <>
                    <button
                      onClick={() => invoke("toggle_sync_pause")}
                      title={isPaused ? t("transfers.resumeSync") : t("transfers.pauseSync")}
                      className="shrink-0 rounded-lg p-1.5 text-stone-500 hover:bg-stone-800/60 hover:text-stone-200 transition-colors"
                    >
                      {isPaused ? <Icon.Play size={13} /> : <Icon.Pause size={13} />}
                    </button>
                    {hasQueue && (
                      <button
                        onClick={() => invoke("clear_sync_queue")}
                        title={t("transfers.stopSync")}
                        className="shrink-0 rounded-lg p-1.5 text-stone-500 hover:bg-stone-800/60 hover:text-red-400 transition-colors"
                      >
                        <Icon.Square size={13} />
                      </button>
                    )}
                  </>
                );
              })()}
            </div>

            <NavItem onClick={() => invoke("open_screenshots_folder")} icon={<Icon.Folder size={14} />}>{t("gallery.sidebar.openFolder")}</NavItem>
            <NavItem onClick={() => invoke("open_settings")} icon={<Icon.Gear size={14} />}>{t("gallery.sidebar.settings")}</NavItem>
          </nav>

          {/* Transfer panel */}
          {transferOpen && (() => {
            const activeList = transfers.active || [];
            const queuedList = transfers.queued || [];
            const historyList = transfers.history || [];
            const totalQueued = transfers.queued_count || 0;
            const isPaused = transfers.is_paused || false;
            const queueCount = activeList.length + totalQueued;
            const hasActivity = queueCount > 0 || historyList.length > 0;

            return (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setTransferOpen(false)} />
                <div
                  className="animate-panel-in absolute z-40 flex flex-col overflow-hidden rounded-xl border border-stone-800 bg-stone-950 shadow-2xl shadow-black/70"
                  style={{ top: "68px", left: "8px", width: "340px", maxHeight: "480px" }}
                >
                  {/* Header */}
                  <div className="flex shrink-0 items-center justify-between px-3 pt-3 pb-2">
                    <div className="flex items-center gap-2">
                      {/* Tabs */}
                      <button
                        onClick={() => setTransferTab("queue")}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${transferTab === "queue" ? "bg-stone-800 text-stone-100" : "text-stone-600 hover:text-stone-400"}`}
                      >
                        {t("gallery.transfer.queue")(queueCount)}
                      </button>
                      <button
                        onClick={() => setTransferTab("history")}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition ${transferTab === "history" ? "bg-stone-800 text-stone-100" : "text-stone-600 hover:text-stone-400"}`}
                      >
                        {t("gallery.transfer.completed")((transfers.total_done || 0) + (transfers.total_error || 0))}
                      </button>
                    </div>
                    <div className="flex items-center gap-1">
                      {(activeList.length > 0 || totalQueued > 0) && (
                        <button
                          onClick={() => invoke("toggle_sync_pause")}
                          className={`flex h-6 w-6 items-center justify-center rounded transition ${isPaused ? "text-emerald-500 hover:bg-stone-800" : "text-stone-500 hover:bg-stone-800 hover:text-stone-300"}`}
                          title={isPaused ? t("gallery.transfer.resume") : t("gallery.transfer.pause")}
                        >
                          {isPaused ? <Icon.Play size={11} /> : <Icon.Pause size={11} />}
                        </button>
                      )}
                      {transferTab === "history" && historyList.length > 0 && (
                        <button
                          onClick={() => setTransfers(prev => ({ ...prev, history: [] }))}
                          className="flex h-6 items-center rounded px-1.5 text-[10px] text-stone-700 transition hover:bg-stone-800 hover:text-stone-400"
                        >
                          {t("gallery.transfer.clear")}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Content */}
                  {!hasActivity ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-stone-500">
                      <Icon.CloudUpload size={28} />
                      <p className="text-[11px]">{t("gallery.transfer.queueEmpty")}</p>
                    </div>
                  ) : transferTab === "queue" ? (
                    /* Queue tab (virtual scroll) */
                    activeList.length === 0 && queuedList.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-2 py-10 text-stone-500">
                        <p className="text-[11px]">{t("gallery.transfer.noQueued")}</p>
                      </div>
                    ) : (
                      <TransferVirtualList
                        rows={[
                          ...activeList.map((t) => ({ kind: "active", t })),
                          ...(activeList.length > 0 && queuedList.length > 0 ? [{ kind: "sep" }] : []),
                          ...queuedList.map((t) => ({ kind: "queued", t })),
                        ]}
                        estimate={(i) => (i < activeList.length ? 53 : 28)}
                        renderRow={(row) => {
                          if (row.kind === "sep") return <div className="mx-3 my-0.5 border-t border-stone-800/60" />;
                          if (row.kind === "active") {
                            const tr = row.t;
                            const pct = tr.total > 0 ? (tr.sent / tr.total * 100) : 0;
                            const isScan = tr.file === "Dosya İnceleme";
                            const isDownload = (tr.message || "").startsWith("İndiril");
                            const verb = isScan ? t("gallery.transfer.scanning") : isDownload ? t("gallery.transfer.downloading") : t("gallery.transfer.uploading");
                            return (
                              <div className="flex items-center gap-2.5 border-b border-stone-800/40 px-3 py-2">
                                <ProgressRing pct={pct} />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-[11.5px] font-medium text-stone-300">{tr.file}</p>
                                  <p className="mt-0.5 truncate tabular-nums text-[10px] text-stone-500">
                                    {verb}
                                    {tr.total > 0 && (isScan
                                      ? t("gallery.transfer.filesOf")(tr.total)
                                      : t("gallery.transfer.sizeOf")(fmtSize(tr.sent), fmtSize(tr.total)))}
                                    {tr.bps > 0 && !isScan && ` · ${fmtSpeed(tr.bps)}`}
                                  </p>
                                </div>
                              </div>
                            );
                          }
                          return (
                            <div className="flex items-center gap-2 px-3 py-1.5">
                              <div className={`h-1 w-1 shrink-0 rounded-full ${isPaused ? "bg-stone-600" : "bg-stone-500"}`} />
                              <p className="min-w-0 flex-1 truncate text-[11px] text-stone-400">{row.t?.file}</p>
                            </div>
                          );
                        }}
                      />
                    )
                  ) : (
                    /* Completed tab (virtual scroll) */
                    historyList.length === 0 ? (
                      <div className="flex flex-col items-center justify-center gap-2 py-10 text-stone-500">
                        <p className="text-[11px]">{t("gallery.transfer.noCompleted")}</p>
                      </div>
                    ) : (
                      <TransferVirtualList
                        rows={historyList}
                        estimate={() => 34}
                        renderRow={(t) => (
                          <div className="flex items-center gap-2.5 border-b border-stone-800/40 px-3 py-2">
                            {t.status === "done"
                              ? <span className="shrink-0 text-[11px] text-emerald-600">✓</span>
                              : <span className="shrink-0 text-[11px] text-red-500">✗</span>
                            }
                            <p className="min-w-0 flex-1 truncate text-[11.5px] text-stone-400">{t.file}</p>
                            {t.status !== "done" && t.message && (
                              <span className="shrink-0 max-w-[100px] truncate text-[10px] text-red-500/60" title={t.message}>{t.message}</span>
                            )}
                            <span className="shrink-0 text-[10px] text-stone-500">
                              {new Date(t.time).toLocaleTimeString(dateLocale, { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          </div>
                        )}
                      />
                    )
                  )}

                  {/* Bottom bar */}
                  {hasActivity && (
                    <div className="flex shrink-0 items-center gap-2 border-t border-stone-800/60 px-3 py-1.5 text-[10px]">
                      {isPaused && <span className="text-stone-400">{t("gallery.transfer.paused")}</span>}
                      {queueCount > 0 && <span className={isPaused ? "text-stone-500" : "text-amber-500/80"}>{t("gallery.transfer.waiting")(queueCount)}</span>}
                      {(transfers.total_done || 0) > 0 && <span className="text-emerald-500">{t("gallery.transfer.done")(transfers.total_done)}</span>}
                      {(transfers.total_error || 0) > 0 && <span className="text-red-500">{t("gallery.transfer.error")(transfers.total_error)}</span>}
                    </div>
                  )}
                </div>
              </>
            );
          })()}
        </aside>

        {/* Main content */}
        <div className="flex flex-1 flex-col min-w-0 animate-fade-in-simple" style={{ animationDelay: "60ms" }}>

          {/* Search + Storage bar */}
          <div className="flex shrink-0 items-center gap-3 border-b border-stone-800/50 bg-stone-950 px-4 py-2.5">
            <div className="relative flex-1 max-w-lg">
              <Icon.Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-600" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("gallery.search")}
                className="w-full rounded-lg bg-stone-900 py-1.5 pl-8 pr-3 text-sm text-stone-200 outline-none transition focus:ring-1 focus:ring-amber-500/40 placeholder:text-stone-700"
              />
            </div>
            <span className="shrink-0 text-[11px] text-stone-700">
              {loading ? t("gallery.loading") : t("gallery.filteredCount")(filtered.length)}
            </span>

            {/* Storage summary — right-aligned. All pills share a fixed h-9 height
              and center their content, so the readouts and button line up. */}
            {storage && (
              <div className="ml-auto flex shrink-0 items-center gap-2">
                {/* Local storage + Free Up (Free Up reclaims local disk space) */}
                <div className="flex h-9 items-center gap-2.5 rounded-xl bg-stone-900 border border-stone-800 pl-3 pr-1.5">
                  <Icon.HardDrive size={13} className="text-stone-500 shrink-0" />
                  <div>
                    <p className="text-[10px] text-stone-500 leading-none">{t("gallery.storage.local")}</p>
                    <p className="text-[12px] font-semibold text-stone-200 mt-0.5 leading-none">{fmtSize(storage.local_bytes)}</p>
                  </div>
                  <button
                    onClick={() => setFreeUpOpen(true)}
                    className="flex h-7 items-center gap-1 rounded-lg bg-amber-500/10 px-2.5 text-[11px] font-medium text-amber-400 transition hover:bg-amber-500/20 hover:text-amber-300"
                  >
                    <Icon.Trash size={11} />
                    {t("gallery.storage.freeUp")}
                  </button>
                </div>

                {/* Drive — usage bar sits inline (vertically centered) so the box
                  keeps the same two-line height as the Local box. */}
                {storage.drive_limit != null ? (
                  <div className="flex h-9 items-center gap-2.5 rounded-xl bg-stone-900 border border-stone-800 px-3">
                    <Icon.Cloud size={13} className="text-stone-500 shrink-0" />
                    <div>
                      <p className="text-[10px] text-stone-500 leading-none">Drive</p>
                      <p className="text-[12px] font-semibold text-stone-200 mt-0.5 leading-none">
                        {fmtSize(storage.drive_usage)}
                        <span className="text-stone-600 font-normal"> / {fmtSize(storage.drive_limit)}</span>
                      </p>
                    </div>
                    <div className="h-1 w-16 shrink-0 rounded-full bg-stone-800 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${storage.drive_usage / storage.drive_limit > 0.9 ? "bg-red-500" :
                          storage.drive_usage / storage.drive_limit > 0.7 ? "bg-amber-500" : "bg-emerald-500"
                          }`}
                        style={{ width: `${Math.min(100, storage.drive_usage / storage.drive_limit * 100).toFixed(1)}%` }}
                      />
                    </div>
                  </div>
                ) : storage.drive_usage > 0 && (
                  <div className="flex h-9 items-center gap-2.5 rounded-xl bg-stone-900 border border-stone-800 px-3">
                    <Icon.Cloud size={13} className="text-stone-500 shrink-0" />
                    <div>
                      <p className="text-[10px] text-stone-500 leading-none">Drive</p>
                      <p className="text-[12px] font-semibold text-stone-200 mt-0.5 leading-none">{fmtSize(storage.drive_usage)}</p>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* View / Sort / Group bar */}
          <div className="relative z-10 flex flex-wrap shrink-0 items-center gap-x-3 gap-y-1.5 border-b border-stone-800/30 bg-stone-950 px-4 py-1.5">
            {/* View mode */}
            <div className="flex items-center gap-0.5 rounded-lg bg-stone-900 p-0.5">
              {[
                { id: "2xl", icon: <Icon.GridXXL size={13} /> },
                { id: "xl", icon: <Icon.GridXL size={13} /> },
                { id: "large", icon: <Icon.GridLarge size={13} /> },
                { id: "medium", icon: <Icon.LayoutGrid size={13} /> },
                { id: "small", icon: <Icon.GridSmall size={13} /> },
                { id: "list", icon: <Icon.Rows size={13} /> },
              ].map(({ id, icon }) => (
                <button key={id} title={t("gallery.viewModes." + id)} onClick={() => startTransition(() => setViewMode(id))}
                  className={`flex h-6 w-6 items-center justify-center rounded transition ${viewMode === id ? "bg-stone-700 text-stone-100" : "text-stone-600 hover:text-stone-400"}`}>
                  {icon}
                </button>
              ))}
            </div>

            <div className="h-3.5 w-px bg-stone-800" />

            {/* Sort */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-stone-400">{t("gallery.sort")}</span>
              <select value={sortBy} onChange={e => startTransition(() => setSortBy(e.target.value))}
                className="rounded bg-stone-900 border border-stone-800 px-1.5 py-0.5 text-[11px] text-stone-300 outline-none cursor-pointer hover:border-stone-700 focus:border-amber-500/40 appearance-none pr-4"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center" }}>
                <option value="date-desc">{t("gallery.sortOptions.dateDesc")}</option>
                <option value="date-asc">{t("gallery.sortOptions.dateAsc")}</option>
                <option value="name-asc">{t("gallery.sortOptions.nameAsc")}</option>
                <option value="name-desc">{t("gallery.sortOptions.nameDesc")}</option>
                <option value="size-desc">{t("gallery.sortOptions.sizeDesc")}</option>
                <option value="size-asc">{t("gallery.sortOptions.sizeAsc")}</option>
              </select>
            </div>

            <div className="h-3.5 w-px bg-stone-800" />

            {/* Group */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-stone-400">{t("gallery.group")}</span>
              <select value={groupBy} onChange={e => startTransition(() => setGroupBy(e.target.value))}
                className="rounded bg-stone-900 border border-stone-800 px-1.5 py-0.5 text-[11px] text-stone-300 outline-none cursor-pointer hover:border-stone-700 focus:border-amber-500/40 appearance-none pr-4"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center" }}>
                <option value="none">{t("gallery.groupOptions.none")}</option>
                <option value="day">{t("gallery.groupOptions.day")}</option>
                <option value="month">{t("gallery.groupOptions.month")}</option>
                <option value="year">{t("gallery.groupOptions.year")}</option>
                <option value="app">{t("gallery.groupOptions.app")}</option>
                <option value="source">{t("gallery.groupOptions.source")}</option>
                <option value="tag">{t("gallery.groupOptions.tag")}</option>
              </select>
            </div>

            <div className="h-3.5 w-px bg-stone-800" />

            {/* Date filter */}
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-widest text-stone-400">{t("gallery.sidebar.date")}</span>
              <select value={dateFilter} onChange={e => startTransition(() => setDateFilter(e.target.value))}
                className="rounded bg-stone-900 border border-stone-800 px-1.5 py-0.5 text-[11px] text-stone-300 outline-none cursor-pointer hover:border-stone-700 focus:border-amber-500/40 appearance-none pr-4"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23666' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: "no-repeat", backgroundPosition: "right 4px center" }}>
                <option value="all">{t("gallery.sidebar.dateAll")}</option>
                <option value="today">{t("gallery.sidebar.dateToday")}</option>
                <option value="yesterday">{t("gallery.sidebar.dateYesterday")}</option>
                <option value="7">{t("gallery.sidebar.date7")}</option>
                <option value="30">{t("gallery.sidebar.date30")}</option>
                <option value="week">{t("gallery.sidebar.dateThisWeek")}</option>
                <option value="month">{t("gallery.sidebar.dateThisMonth")}</option>
                <option value="year">{t("gallery.sidebar.dateThisYear")}</option>
                <option value="custom-date">{t("gallery.sidebar.dateCustomDate")}</option>
                <option value="custom-range">{t("gallery.sidebar.dateCustomRange")}</option>
              </select>

              {dateFilter === "custom-date" && (
                <div className="relative flex items-center gap-1 animate-fade-in">
                  <button
                    ref={dateBtnRef}
                    onClick={() => setDatePickerOpen(!datePickerOpen)}
                    className="flex items-center gap-1.5 rounded bg-stone-900 border border-stone-800 px-2.5 py-0.5 text-[11px] text-stone-300 hover:border-stone-700 hover:text-stone-200 transition focus:border-amber-500/40 cursor-pointer"
                  >
                    <Icon.Calendar size={12} className="text-amber-500 shrink-0" />
                    {customStartDate ? parseLocalDate(customStartDate).toLocaleDateString(dateLocale, { day: "numeric", month: "short", year: "numeric" }) : t("gallery.sidebar.dateCustomDate") || "Choose date..."}
                  </button>

                  {datePickerOpen && (
                    <CalendarPopover
                      mode="date"
                      startDate={customStartDate}
                      endDate={customEndDate}
                      onChange={(start, end) => {
                        setCustomStartDate(start);
                        setCustomEndDate(end);
                      }}
                      onClose={() => setDatePickerOpen(false)}
                      targetRef={dateBtnRef}
                      lang={lang}
                      dateLocale={dateLocale}
                      items={items}
                    />
                  )}
                </div>
              )}

              {dateFilter === "custom-range" && (
                <div className="relative flex items-center gap-1 animate-fade-in">
                  <button
                    ref={dateBtnRef}
                    onClick={() => setDatePickerOpen(!datePickerOpen)}
                    className="flex items-center gap-1.5 rounded bg-stone-900 border border-stone-800 px-2.5 py-0.5 text-[11px] text-stone-300 hover:border-stone-700 hover:text-stone-200 transition focus:border-amber-500/40 cursor-pointer"
                  >
                    <Icon.CalendarRange size={12} className="text-amber-500 shrink-0" />
                    {customStartDate || customEndDate ? (
                      <span className="flex items-center gap-1">
                        {customStartDate ? parseLocalDate(customStartDate).toLocaleDateString(dateLocale, { day: "numeric", month: "short" }) : "..."}
                        <span className="text-stone-600">-</span>
                        {customEndDate ? parseLocalDate(customEndDate).toLocaleDateString(dateLocale, { day: "numeric", month: "short" }) : "..."}
                      </span>
                    ) : (
                      t("gallery.sidebar.dateCustomRange") || "Choose range..."
                    )}
                  </button>

                  {datePickerOpen && (
                    <CalendarPopover
                      mode="range"
                      startDate={customStartDate}
                      endDate={customEndDate}
                      onChange={(start, end) => {
                        setCustomStartDate(start);
                        setCustomEndDate(end);
                      }}
                      onClose={() => setDatePickerOpen(false)}
                      targetRef={dateBtnRef}
                      lang={lang}
                      dateLocale={dateLocale}
                      items={items}
                    />
                  )}
                </div>
              )}
            </div>

            <span className="ml-auto text-[10px] text-stone-400">
              {t("gallery.itemCount")(sortedFiltered.length, groupBy !== "none" ? groups.length : null)}
            </span>
          </div>

          {/* Grid + Scrubber */}
          <div className="flex flex-1 overflow-hidden">
            <main
              ref={mainRef}
              className={`gallery-main flex-1 overflow-auto p-5 relative select-none transition-opacity duration-150 ${groupBy !== "none" && scrubberSections.length > 1 ? "no-scrollbar" : ""} ${isPending ? "opacity-60" : ""}`}
              style={{ overflowAnchor: "none" }}
              onMouseDown={handleMouseDown}
              onScroll={handleGalleryScroll}
            >
              {loading && items.length === 0 ? (() => {
                const lp = loadProgress || {};
                const step = lp.step ?? null;
                // Step order
                const localDone = ["local", "drive-start", "drive-scan", "drive"].includes(step);
                const driveActive = ["drive-start", "drive-scan", "drive"].includes(step);
                const driveDone = step === "drive";
                // Real-time counters
                const localDisplay = lp.localCount ?? lp.localScan ?? null;
                const driveDisplay = lp.driveCount ?? lp.driveScan ?? null;
                const drivePage = lp.drivePage ?? null;
                return (
                  <div className="flex h-full items-center justify-center animate-fade-in">
                    <div className="flex flex-col items-center gap-7 w-72">
                      {/* Main spinner */}
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-800 border-t-stone-400" />

                      {/* Step list */}
                      <div className="w-full space-y-4">

                        {/* Local */}
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2.5">
                            <div className={`h-4 w-4 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold
                          ${localDone ? "bg-emerald-500/20 text-emerald-400" : "bg-amber-500/15 text-amber-400"}`}>
                              {localDone ? "✓" : "·"}
                            </div>
                            <span className={`text-[12px] font-medium flex-1 ${localDone ? "text-stone-300" : "text-stone-200"}`}>
                              {t("gallery.loadingSteps.local")}
                            </span>
                            <span className="text-[11px] text-stone-500 tabular-nums">
                              {localDisplay != null ? t("gallery.loadingSteps.items")(localDisplay, dateLocale) : t("gallery.loadingSteps.scanning")}
                            </span>
                          </div>
                          {/* Local progress bar — fills while scanning */}
                          {!localDone && (
                            <div className="ml-6 h-1 w-full rounded-full bg-stone-800 overflow-hidden">
                              <div className="h-full bg-amber-500/60 rounded-full animate-[scan_1.2s_ease-in-out_infinite]"
                                style={{ width: "40%" }} />
                            </div>
                          )}
                        </div>

                        {/* Drive */}
                        <div className="space-y-1.5">
                          <div className="flex items-center gap-2.5">
                            <div className={`h-4 w-4 rounded-full flex-shrink-0 flex items-center justify-center text-[9px] font-bold
                          ${driveDone ? "bg-emerald-500/20 text-emerald-400"
                                : driveActive ? "bg-amber-500/15 text-amber-400"
                                  : "bg-stone-800/60 text-stone-600"}`}>
                              {driveDone ? "✓" : driveActive ? "·" : "○"}
                            </div>
                            <span className={`text-[12px] font-medium flex-1
                          ${driveDone ? "text-stone-300" : driveActive ? "text-stone-200" : "text-stone-700"}`}>
                              Google Drive
                            </span>
                            <span className="text-[11px] text-stone-500 tabular-nums">
                              {driveDone && driveDisplay != null
                                ? t("gallery.loadingSteps.items")(driveDisplay, dateLocale)
                                : driveActive && driveDisplay != null
                                  ? t("gallery.loadingSteps.items")(driveDisplay, dateLocale) + (drivePage ? t("gallery.loadingSteps.page")(drivePage) : "") + "…"
                                  : driveActive ? t("gallery.loadingSteps.connecting") : t("gallery.loadingSteps.waiting")}
                            </span>
                          </div>
                          {/* Drive progress bar — fills as pages are fetched */}
                          {driveActive && !driveDone && (
                            <div className="ml-6 h-1 w-full rounded-full bg-stone-800 overflow-hidden">
                              <div className="h-full bg-amber-500/60 rounded-full transition-all duration-500"
                                style={{
                                  width: driveDisplay
                                    ? `${Math.min(95, (driveDisplay / Math.max(driveDisplay, 1000)) * 100 * (drivePage || 1) / (drivePage || 1))}%`
                                    : "8%"
                                }} />
                            </div>
                          )}
                        </div>

                      </div>
                    </div>
                  </div>
                );
              })() : sortedFiltered.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-stone-600 animate-fade-in">
                  <Icon.Monitor size={48} />
                  <p className="text-sm">{items.length === 0 ? t("gallery.empty") : t("gallery.noMatch")}</p>
                </div>
              ) : (
                <div className="animate-fade-in-simple">
                  {/* Sticky header row in list mode */}
                  {viewMode === "list" && (
                    <div
                      style={{ display: "grid", gridTemplateColumns: LIST_COLS }}
                      className="sticky top-0 z-10 border-b border-stone-800 bg-stone-950/95 backdrop-blur-sm py-2 text-[10px] font-semibold uppercase tracking-widest text-stone-600"
                    >
                      <div className="pl-1 pr-3" />
                      <div className="pr-4">{t("gallery.listHeader.title")}</div>
                      <div className="pr-4">{t("gallery.listHeader.filename")}</div>
                      <div className="pr-4">{t("gallery.listHeader.app")}</div>
                      <div className="pr-4">{t("gallery.listHeader.date")}</div>
                      <div className="pr-4 text-right">{t("gallery.listHeader.size")}</div>
                      <div className="text-center">{t("gallery.listHeader.source")}</div>
                    </div>
                  )}

                  {/* Virtual scroll container */}
                  <div ref={virtualizer.containerRef} style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
                    {virtualizer.getVirtualItems().map((vItem) => {
                      const row = virtualRows[vItem.index];
                      return (
                        <div
                          key={vItem.key}
                          data-index={vItem.index}
                          ref={virtualizer.measureElement}
                          style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${vItem.start}px)` }}
                        >
                          {row.type === "header" && (
                            <div className={`flex items-center gap-3 px-0.5 pb-3 ${row.isFirst ? "pt-0" : "pt-5"}`}>
                              <span className="text-[11px] font-bold uppercase tracking-widest text-stone-400">{row.label}</span>
                              <div className="flex-1 border-t border-stone-800/60" />
                              <span className="text-[10px] text-stone-400">{viewMode !== "list" ? t("gallery.itemCount")(row.count, null) : row.count}</span>
                            </div>
                          )}
                          {row.type === "grid-row" && (
                            <div data-vm={viewMode} className={`grid gap-2.5 pb-2.5 ${gridColsClass}`}>
                              {row.items.map((it) => (
                                <GridCard
                                  key={it.name}
                                  it={it}
                                  isSelected={selectedNames.has(it.name)}
                                  handleCardClick={handleCardClick}
                                  handleCardContextMenu={handleCardContextMenu}
                                  openItem={openItem}
                                  copyItem={copyItem}
                                  deleteItem={deleteItem}
                                  toggleSelectItem={toggleSelectItem}
                                  appIcons={appIcons}
                                  t={t}
                                  dateLocale={dateLocale}
                                  tagMap={tagMap}
                                />
                              ))}
                            </div>
                          )}
                          {row.type === "list-item" && (
                            <ListRow
                              it={row.it}
                              isSelected={selectedNames.has(row.it.name)}
                              handleCardClick={handleCardClick}
                              handleCardContextMenu={handleCardContextMenu}
                              toggleSelectItem={toggleSelectItem}
                              appIcons={appIcons}
                              t={t}
                              dateLocale={dateLocale}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Drag selection box overlay — portaled to escape the root wrapper's
                  animate-fade-in transform, which would otherwise make this fixed box
                  scroll along with <main> (transform on an ancestor creates a new
                  containing block for position:fixed descendants). */}
              {isDragging && dragStart && dragEnd && createPortal(
                (() => {
                  const anchoredStartY = dragStart.y - (mainScrollTop - dragStartScrollTopRef.current);
                  const bounds = mainRef.current?.getBoundingClientRect();
                  let left = Math.min(dragStart.x, dragEnd.x);
                  let right = Math.max(dragStart.x, dragEnd.x);
                  let top = Math.min(anchoredStartY, dragEnd.y);
                  let bottom = Math.max(anchoredStartY, dragEnd.y);
                  if (bounds) {
                    left = Math.max(left, bounds.left);
                    right = Math.min(right, bounds.right);
                    top = Math.max(top, bounds.top);
                    bottom = Math.min(bottom, bounds.bottom);
                  }
                  return (
                    <div
                      className="pointer-events-none fixed border border-amber-500/85 bg-amber-500/15 z-[60] rounded"
                      style={{
                        left,
                        top,
                        width: Math.max(0, right - left),
                        height: Math.max(0, bottom - top),
                      }}
                    />
                  );
                })(),
                document.body
              )}
            </main>

            {/* Group scrubber — drag like a phone gallery */}
            {groupBy !== "none" && scrubberSections.length > 1 && (() => {
              const viewFrac = scrollMetrics.scrollH > scrollMetrics.clientH
                ? scrollMetrics.clientH / scrollMetrics.scrollH : 1;
              const thumbPct = Math.max(4, viewFrac * 100);
              const thumbTopPct = scrollRatio * (100 - thumbPct);
              return (
                <div
                  ref={scrubTrackRef}
                  className="relative w-5 shrink-0 cursor-pointer select-none"
                  onMouseDown={handleScrubMouseDown}
                >
                  {/* Track */}
                  <div className="absolute inset-y-2 left-1/2 -translate-x-1/2 w-[3px] bg-stone-800/60 rounded-full" />
                  {/* Year markers — fixed, float left, visible only while scrubbing */}
                  {scrubDragging && scrubTrackRectRef.current && yearMarkers.map(({ year, topPct }) => {
                    const tr = scrubTrackRectRef.current;
                    return (
                      <div
                        key={year}
                        className="pointer-events-none rounded-md bg-stone-800/95 border border-stone-700 px-2.5 py-0.5 text-[11px] font-bold text-stone-200 whitespace-nowrap shadow-lg"
                        style={{
                          position: "fixed",
                          top: tr.top + (topPct / 100) * tr.height,
                          right: window.innerWidth - tr.left + 10,
                          transform: "translateY(-50%)",
                          zIndex: 200,
                        }}
                      >
                        {year}
                      </div>
                    );
                  })}
                  {/* Thumb */}
                  <div
                    className={`absolute left-1/2 -translate-x-1/2 rounded-full pointer-events-none transition-[width,background-color]
                    ${scrubDragging ? "bg-amber-400 w-[8px]" : "bg-stone-600 w-[6px]"}`}
                    style={{ top: `${thumbTopPct}%`, height: `${thumbPct}%` }}
                  />
                  {/* Label bubble — visible only while scrubbing */}
                  {scrubDragging && scrubLabelText && scrubTrackRectRef.current && (() => {
                    const tr = scrubTrackRectRef.current;
                    const thumbMidPct = thumbTopPct + thumbPct / 2;
                    return (
                      <div
                        className="pointer-events-none rounded-lg bg-stone-900 border border-stone-600 px-3 py-1.5 text-[12px] font-semibold text-stone-100 whitespace-nowrap shadow-xl"
                        style={{
                          position: "fixed",
                          top: tr.top + (thumbMidPct / 100) * tr.height - 14,
                          right: window.innerWidth - tr.left + 10,
                          zIndex: 300,
                        }}
                      >
                        {scrubLabelText}
                      </div>
                    );
                  })()}
                </div>
              );
            })()}
          </div>{/* /flex overflow-hidden */}
        </div>{/* /flex flex-col min-w-0 */}

        {/* Lightbox */}
        {preview && (
          <div className="fixed inset-0 z-40 flex flex-col bg-black/92 backdrop-blur-md">
            {/* Top info bar */}
            <div className="flex shrink-0 items-center gap-4 px-5 py-3 border-b border-white/8">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-stone-100">{preview.title || t("common.screenshot")}</div>
                <div className="truncate text-xs text-stone-400 mt-0.5" title={preview.name}>{preview.name}</div>
                <div className="flex items-center gap-2 mt-1 text-xs text-stone-500">
                  <span>{fmtDate(itemDate(preview))}</span>
                  {preview.size && <><span>·</span><span>{fmtSize(preview.size)}</span></>}
                  <span className="rounded bg-white/10 px-1.5 py-px text-[10px] font-bold text-stone-400 uppercase tracking-wide">{preview.name?.split('.').pop()}</span>
                  {preview.app && <span className="rounded bg-white/10 px-1.5 py-px text-stone-400">{preview.app}</span>}
                  <span className="text-stone-600">{previewIdx + 1} / {filtered.length}</span>
                  {(preview.tags || []).map(id => tagMap[id]).filter(Boolean).map(tg => (
                    <span key={tg.id} className="flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-semibold text-white/90 leading-tight"
                      style={{ backgroundColor: tg.color + "cc" }}>
                      {tg.name}
                    </span>
                  ))}
                </div>
              </div>
              <button
                onClick={() => setPreview(null)}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-stone-400 transition hover:bg-white/10 hover:text-white"
              >
                <Icon.X size={18} />
              </button>
            </div>

            {/* Image + navigation */}
            <div className="relative flex flex-1 items-center justify-center overflow-hidden px-16">
              {/* Left arrow */}
              {previewIdx > 0 && (
                <button
                  onClick={() => setPreview(sortedFiltered[previewIdx - 1])}
                  className="absolute left-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/8 text-stone-300 backdrop-blur-sm transition hover:bg-white/15 hover:text-white"
                >
                  <Icon.ChevronLeft size={22} />
                </button>
              )}
              <div
                className="flex h-full w-full items-center justify-center p-4"
                onContextMenu={(e) => { e.preventDefault(); setContextMenu({ item: preview, x: e.clientX, y: e.clientY }); }}
              >
                <PreviewImage
                  cacheKey={preview.name}
                  localPath={preview.local_path}
                  load={() => invoke("read_drive_thumbnail", { id: preview.drive_id, size: 1600 })}
                  t={t}
                />
              </div>
              {/* Right arrow */}
              {previewIdx < filtered.length - 1 && (
                <button
                  onClick={() => setPreview(sortedFiltered[previewIdx + 1])}
                  className="absolute right-3 flex h-10 w-10 items-center justify-center rounded-full bg-white/8 text-stone-300 backdrop-blur-sm transition hover:bg-white/15 hover:text-white"
                >
                  <Icon.ChevronRight size={22} />
                </button>
              )}
            </div>

            {/* Bottom action bar */}
            <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 border-t border-white/8 px-5 py-3">
              <ActionBtn onClick={() => openItem(preview)} icon={<Icon.External size={14} />}>{t("gallery.preview.open")}</ActionBtn>
              <ActionBtn onClick={() => revealItem(preview)} icon={<Icon.Folder size={14} />}>{t("gallery.preview.showInFolder")}</ActionBtn>
              <ActionBtn onClick={() => copyItem(preview)} icon={<Icon.Copy size={14} />}>{t("gallery.preview.copy")}</ActionBtn>

              {preview.drive_link && (
                <ActionBtn onClick={() => invoke("open_url", { url: preview.drive_link })} icon={<Icon.Cloud size={14} />}>{t("gallery.preview.openInDrive")}</ActionBtn>
              )}
              {directLinkReady && (
                <ActionBtn variant="primary" onClick={() => copyDirectLink(preview)} icon={<Icon.Link size={14} />}>{t("gallery.preview.directLink")}</ActionBtn>
              )}
              {preview.drive_id && (
                <ActionBtn onClick={() => copyDriveLink(preview)} icon={<Icon.Link size={14} />}>{t("gallery.preview.driveLinkCopy")}</ActionBtn>
              )}
              {connected && preview.local_path && !preview.drive_id && (
                <ActionBtn variant="primary" onClick={() => uploadItem(preview)} icon={<Icon.Upload size={14} />}>{t("gallery.preview.uploadToDrive")}</ActionBtn>
              )}
              {preview.drive_id && !preview.local_path && (
                <ActionBtn variant="primary" onClick={() => downloadLocalCopy(preview)} icon={<Icon.Check size={14} />}>{t("gallery.preview.downloadLocal")}</ActionBtn>
              )}
              {preview.drive_id && preview.local_path && (
                <ActionBtn onClick={() => deleteLocalCopy(preview)} icon={<Icon.Cloud size={14} />}>{t("gallery.preview.removeLocal")}</ActionBtn>
              )}
              <ActionBtn variant="danger" onClick={() => deleteItem(preview)} icon={<Icon.Trash size={14} />}>{t("gallery.preview.delete")}</ActionBtn>
            </div>
          </div>
        )}

        {/* Free Up panel */}
        {freeUpOpen && (() => {
          const synced = items.filter(it => it.local_path && it.drive_id);
          const localOnlyBytes = synced.reduce((s, it) => s + (it.size || 0), 0);
          const clearAll = async () => {
            const total = synced.length;
            setFreeUpProgress({ done: 0, total, bytes: 0 });
            let freedBytes = 0;
            let doneCount = 0;
            for (const it of synced) {
              try { await invoke("delete_local_copy", { localPath: it.local_path }); } catch (_) { }
              freedBytes += it.size || 0;
              doneCount += 1;
              setFreeUpProgress({ done: doneCount, total, bytes: freedBytes });
            }
            await invoke("get_storage_info").then(setStorage).catch(() => { });
            await load();
            setFreeUpProgress(null);
            setFreeUpOpen(false);
            showToast(t("gallery.freeUp.allRemovedToast")(total, fmtSize(localOnlyBytes)));
          };
          return (
            <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setFreeUpOpen(false)}>
              <div className="w-full max-w-md rounded-2xl border border-stone-700/60 bg-stone-950 shadow-2xl mb-4" onClick={e => e.stopPropagation()}>
                {/* Title */}
                <div className="flex items-center justify-between border-b border-stone-800 px-5 py-4">
                  <div>
                    <h3 className="text-sm font-semibold text-stone-100">{t("gallery.freeUp.title")}</h3>
                    <p className="mt-0.5 text-[11px] text-stone-500">{t("gallery.freeUp.subtitle")}</p>
                  </div>
                  <button onClick={() => setFreeUpOpen(false)} className="text-stone-600 hover:text-stone-400 transition">
                    <Icon.X size={16} />
                  </button>
                </div>

                {/* Storage indicator */}
                {storage && (
                  <div className="grid grid-cols-2 gap-3 border-b border-stone-800 px-5 py-4">
                    <div className="rounded-lg bg-stone-900 px-3 py-2.5">
                      <p className="text-[10px] text-stone-600 uppercase tracking-wide">{t("gallery.freeUp.localUsage")}</p>
                      <p className="mt-1 text-lg font-semibold text-stone-200">{fmtSize(storage.local_bytes)}</p>
                      {localOnlyBytes > 0 && (
                        <p className="mt-0.5 text-[11px] text-emerald-500">{t("gallery.freeUp.canFree")(fmtSize(localOnlyBytes))}</p>
                      )}
                    </div>
                    {storage.drive_limit != null ? (
                      <div className="rounded-lg bg-stone-900 px-3 py-2.5">
                        <p className="text-[10px] text-stone-600 uppercase tracking-wide">{t("gallery.freeUp.driveLabel")}</p>
                        <p className="mt-1 text-lg font-semibold text-stone-200">{fmtSize(storage.drive_usage)}</p>
                        <div className="mt-1.5 h-1.5 rounded-full bg-stone-800">
                          <div className="h-full rounded-full bg-amber-500 transition-all"
                            style={{ width: `${Math.min(100, storage.drive_usage / storage.drive_limit * 100).toFixed(1)}%` }} />
                        </div>
                        <p className="mt-0.5 text-[10px] text-stone-600">{t("gallery.freeUp.driveTotal")(fmtSize(storage.drive_limit))}</p>
                      </div>
                    ) : (
                      <div className="rounded-lg bg-stone-900 px-3 py-2.5">
                        <p className="text-[10px] text-stone-600 uppercase tracking-wide">{t("gallery.freeUp.driveLabel")}</p>
                        <p className="mt-1 text-lg font-semibold text-stone-200">{fmtSize(storage.drive_usage)}</p>
                        <p className="mt-0.5 text-[11px] text-stone-600">{t("gallery.freeUp.unlimited")}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* Cache */}
                {storage && (
                  <div className="flex items-center justify-between gap-3 border-b border-stone-800 px-5 py-3">
                    <div className="min-w-0">
                      <p className="text-[12px] font-medium text-stone-300">{t("gallery.freeUp.cacheLabel")} · {fmtSize(storage.cache_bytes)}</p>
                      <p className="truncate text-[10px] text-stone-600">{t("gallery.freeUp.cacheHint")}</p>
                    </div>
                    <button
                      disabled={!storage.cache_bytes}
                      onClick={async () => {
                        const freed = await invoke("clear_app_cache").catch(() => 0);
                        await invoke("get_storage_info").then(setStorage).catch(() => { });
                        showToast(t("gallery.freeUp.cacheClearedToast")(fmtSize(freed)));
                      }}
                      className="shrink-0 rounded-md px-2.5 py-1 text-[11px] text-stone-400 transition hover:bg-stone-800 hover:text-stone-200 disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      {t("gallery.freeUp.clearCache")}
                    </button>
                  </div>
                )}

                {/* Senkronize dosya listesi */}
                <div className="max-h-52 overflow-y-auto">
                  {synced.length === 0 ? (
                    <p className="px-5 py-6 text-center text-sm text-stone-600">{t("gallery.freeUp.noLocal")}</p>
                  ) : (
                    synced.map(it => (
                      <div key={it.name} className="flex items-center justify-between gap-3 border-b border-stone-800/50 px-5 py-2.5 last:border-0">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[12px] font-medium text-stone-300">{it.name}</p>
                          {it.title && <p className="truncate text-[10px] text-stone-600 mt-0.5">{it.title}</p>}
                          <p className="text-[10px] text-stone-600">{fmtSize(it.size)}</p>
                        </div>
                        <button
                          onClick={async () => {
                            await invoke("delete_local_copy", { localPath: it.local_path });
                            invoke("get_storage_info").then(setStorage).catch(() => { });
                            load();
                          }}
                          className="shrink-0 rounded-md px-2 py-1 text-[11px] text-stone-500 hover:bg-stone-800 hover:text-stone-300 transition"
                        >
                          {t("gallery.freeUp.remove")}
                        </button>
                      </div>
                    ))
                  )}
                </div>

                {/* Alt butonlar / Progress */}
                {synced.length > 0 && (
                  <div className="border-t border-stone-800 px-5 py-3">
                    {freeUpProgress ? (
                      <div className="space-y-2">
                        <div className="flex items-center justify-between text-[11px]">
                          <span className="text-stone-400 font-medium">{t("gallery.freeUp.deleting")(freeUpProgress.done, freeUpProgress.total)}</span>
                          <span className="text-emerald-500">{t("gallery.freeUp.freed")(fmtSize(freeUpProgress.bytes))}</span>
                        </div>
                        <div className="h-1.5 w-full rounded-full bg-stone-800">
                          <div
                            className="h-full rounded-full bg-amber-500 transition-all duration-200"
                            style={{ width: `${(freeUpProgress.done / freeUpProgress.total) * 100}%` }}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-between">
                        <p className="text-[11px] text-stone-600">{t("gallery.freeUp.fileCount")(synced.length, fmtSize(localOnlyBytes))}</p>
                        <button
                          onClick={clearAll}
                          className="rounded-lg bg-amber-500 px-3 py-1.5 text-[12px] font-semibold text-stone-950 transition hover:bg-amber-400"
                        >
                          {t("gallery.freeUp.removeAll")}
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {/* Confirm dialog */}
        {confirm && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4" onClick={() => setConfirm(null)}>
            <div className="w-full max-w-sm rounded-2xl border border-stone-700/60 bg-stone-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <h3 className="mb-2 text-sm font-semibold text-stone-100">{t("gallery.confirm.title")}</h3>
              <p className="text-sm text-stone-400 leading-relaxed">{confirm.message}</p>
              <div className="mt-5 flex justify-end gap-2">
                <ActionBtn onClick={() => setConfirm(null)}>{t("gallery.confirm.cancel")}</ActionBtn>
                <ActionBtn variant="danger" onClick={async () => {
                  const fn = confirm.action;
                  setConfirm(null);
                  try { await fn(); } catch (e) { showError(t("gallery.toast.error") + " " + e); }
                }}>{t("gallery.confirm.delete")}</ActionBtn>
              </div>
            </div>
          </div>
        )}

        {/* Context menu */}
        {contextMenu && (() => {
          const it = contextMenu.item;
          const isMulti = selectedNames.size > 1 && selectedNames.has(it.name);
          const run = (fn) => () => { fn(it); closeCtx(); };

          let raw;
          if (isMulti) {
            const selectedList = items.filter((x) => selectedNames.has(x.name));
            const hasLocalOnly = selectedList.some(x => x.local_path && !x.drive_id);
            const hasCloudOnly = selectedList.some(x => !x.local_path && x.drive_id);
            const hasSynced = selectedList.some(x => x.local_path && x.drive_id);

            const hasDriveId = selectedList.some(x => x.drive_id);
            raw = [
              { label: t("gallery.context.selectedN")(selectedNames.size), fn: () => { }, disabled: true },
              null,
              hasLocalOnly && connected
                ? { icon: <Icon.Upload size={13} />, label: t("gallery.context.uploadToDrive"), fn: () => { uploadSelected(); closeCtx(); } }
                : null,
              hasCloudOnly
                ? { icon: <Icon.Check size={13} className="text-emerald-500 stroke-[3]" />, label: t("gallery.context.downloadLocal"), fn: () => { downloadSelected(); closeCtx(); } }
                : null,
              hasSynced
                ? { icon: <Icon.Cloud size={13} className="text-amber-500" />, label: t("gallery.context.removeLocalCloud"), fn: () => { removeLocalSelected(); closeCtx(); } }
                : null,
              null,
              hasDriveId
                ? { icon: <Icon.Link size={13} />, label: t("gallery.context.copyDriveLinks"), fn: () => { copyBulkDriveLinks(); closeCtx(); } }
                : null,
              directLinkReady
                ? { icon: <Icon.Link size={13} />, label: t("gallery.context.copyDirectLinks"), fn: () => { copyBulkDirectLinks(); closeCtx(); } }
                : null,
              null,
              { icon: <Icon.Trash size={13} />, label: t("gallery.context.delete"), danger: true, fn: () => { deleteSelected(); closeCtx(); } }
            ];
          } else {
            raw = [
              { icon: <Icon.External size={13} />, label: t("gallery.context.open"), fn: run(openItem) },
              { icon: <Icon.Pencil size={13} />, label: t("gallery.context.edit"), fn: run(editItem) },
              { icon: <Icon.Folder size={13} />, label: t("gallery.context.showInFolder"), fn: run(revealItem) },
              tags.length > 0
                ? { icon: <Icon.Tag size={13} />, label: t("gallery.tags.assignTags"), fn: () => { setTagAssignTarget({ item: it, x: contextMenu.x, y: contextMenu.y }); closeCtx(); } }
                : null,
              null,
              { icon: <Icon.Copy size={13} />, label: t("gallery.context.copyImage"), fn: run(copyItem) },
              connected && it.local_path && !it.drive_id
                ? { icon: <Icon.Upload size={13} />, label: t("gallery.context.uploadToDrive"), fn: run(uploadItem) }
                : null,
              it.drive_id
                ? { icon: <Icon.Link size={13} />, label: t("gallery.context.copyDriveLink"), fn: run(copyDriveLink) }
                : null,
              directLinkReady
                ? { icon: <Icon.Link size={13} />, label: t("gallery.context.copyDirectLink"), fn: run(copyDirectLink) }
                : null,
              null,
              it.drive_id && !it.local_path
                ? { icon: <Icon.Check size={13} className="text-emerald-500 stroke-[3]" />, label: t("gallery.context.downloadLocal"), fn: run(downloadLocalCopy) }
                : null,
              it.drive_id && it.local_path
                ? { icon: <Icon.Cloud size={13} className="text-amber-500" />, label: t("gallery.context.removeLocalCloud"), fn: run(deleteLocalCopy) }
                : null,
              it.drive_id ? null : null,
              { icon: <Icon.Trash size={13} />, label: t("gallery.context.delete"), danger: true, fn: run(deleteItem) },
            ];
          }

          // Remove null separators and consecutive separators
          const actions = raw.filter((a, i, arr) => {
            if (a !== null) return true;
            if (i === 0 || i === arr.length - 1) return false;
            return arr[i - 1] !== null && arr.slice(i + 1).some((x) => x !== null);
          });
          return <ContextMenu key={isMulti ? "multi" : it.name} x={contextMenu.x} y={contextMenu.y} actions={actions} onClose={closeCtx} />;
        })()}

        {/* Floating multi-selection action bar */}
        {selectedNames.size > 0 && (
          <div className="fixed bottom-6 left-1/2 z-30 -translate-x-1/2 flex items-center gap-4 rounded-full border border-stone-700/60 bg-stone-900/95 px-6 py-2.5 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-bottom-4 duration-200">
            <div className="flex items-center gap-2 border-r border-stone-850 pr-4">
              <button
                onClick={() => setSelectedNames(new Set())}
                className="flex h-5 w-5 items-center justify-center rounded-full text-stone-400 hover:bg-stone-800 hover:text-white transition"
                title={t("gallery.selection.clearTitle")}
              >
                <Icon.X size={12} />
              </button>
              <span className="text-xs font-semibold text-stone-200">
                {t("gallery.selection.selected")(selectedNames.size)}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {items.some((it) => selectedNames.has(it.name) && it.local_path && !it.drive_id) && connected && (
                <ActionBtn onClick={uploadSelected} icon={<Icon.Upload size={14} />}>{t("gallery.selection.uploadToDrive")}</ActionBtn>
              )}
              {items.some((it) => selectedNames.has(it.name) && !it.local_path && it.drive_id) && (
                <ActionBtn variant="primary" onClick={downloadSelected} icon={<Icon.Check size={14} />}>{t("gallery.selection.download")}</ActionBtn>
              )}
              {items.some((it) => selectedNames.has(it.name) && it.local_path && it.drive_id) && (
                <ActionBtn onClick={removeLocalSelected} icon={<Icon.Cloud size={14} />}>{t("gallery.selection.removeLocal")}</ActionBtn>
              )}
              {items.some((it) => selectedNames.has(it.name) && it.drive_id) && (
                <ActionBtn onClick={copyBulkDriveLinks} icon={<Icon.Link size={14} />}>{t("gallery.selection.driveLink")}</ActionBtn>
              )}
              {directLinkReady && (
                <ActionBtn onClick={copyBulkDirectLinks} icon={<Icon.Link size={14} />}>{t("gallery.selection.directLink")}</ActionBtn>
              )}
              <ActionBtn variant="danger" onClick={deleteSelected} icon={<Icon.Trash size={14} />}>{t("gallery.selection.delete")}</ActionBtn>
            </div>
          </div>
        )}

        {/* Tag assign popover */}
        {tagAssignTarget && (
          <TagAssignPopover
            item={tagAssignTarget.item}
            x={tagAssignTarget.x}
            y={tagAssignTarget.y}
            tags={tags}
            onClose={() => setTagAssignTarget(null)}
            onSave={(tagIds) => { setImageTags(tagAssignTarget.item.name, tagIds); setTagAssignTarget(null); }}
          />
        )}

        {/* Tag management modal */}
        {tagModal && (
          <TagManageModal
            tags={tags}
            t={t}
            onClose={() => setTagModal(false)}
            onSave={saveTags}
          />
        )}

        {/* Toast */}
        {toast && (
          <div
            title={toast.msg}
            className={`pointer-events-auto fixed bottom-6 left-1/2 z-[60] flex max-w-sm items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium shadow-2xl backdrop-blur-md ring-1 animate-toast-in
            ${toast.type === "error"
                ? "bg-red-950/90 text-red-100 ring-red-500/30"
                : "bg-stone-800/95 text-stone-100 ring-white/10"}`}
          >
            {toast.type === "error"
              ? <svg className="shrink-0 text-red-400" width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" /><path d="M8 4.5v4M8 10.5v1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
              : <svg className="shrink-0 text-emerald-400" width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" /><path d="M5 8.5l2 2 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            }
            <span className="truncate">{toast.msg}</span>
          </div>
        )}
      </div>{/* flex flex-1 min-h-0 */}
    </div>
  );
}

// Context menu

function ContextMenu({ x, y, actions, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });

  useLayoutEffect(() => {
    if (!ref.current) return;
    const W = window.innerWidth, H = window.innerHeight;
    const w = ref.current.offsetWidth, h = ref.current.offsetHeight;
    setPos({
      left: x + w + 8 > W ? x - w : x + 2,
      top: y + h + 8 > H ? y - h : y + 2,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 200 }}
      className="min-w-[200px] select-none overflow-hidden rounded-xl border border-stone-700/50 bg-stone-900 py-1 shadow-2xl ring-1 ring-black/40"
      onContextMenu={(e) => e.preventDefault()}
    >
      {actions.map((a, i) =>
        a === null ? (
          <div key={i} className="my-1 border-t border-stone-800/60" />
        ) : (
          <button
            key={i}
            onClick={a.fn}
            disabled={a.disabled}
            className={[
              "flex w-full items-center gap-2.5 px-3 py-[7px] text-left text-[13px] leading-none transition-colors",
              a.disabled
                ? "opacity-50 pointer-events-none font-semibold text-stone-500 text-xs py-[9px]"
                : a.danger
                  ? "text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  : "text-stone-300 hover:bg-stone-800 hover:text-stone-100",
            ].join(" ")}
          >
            {a.icon && <span className="shrink-0 opacity-50">{a.icon}</span>}
            {a.label}
          </button>
        )
      )}
    </div>
  );
}

// Sidebar nav item
function NavItem({ onClick, active, accent, icon, title, barColor, children }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={[
        "group relative flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-[13px] font-medium transition-all duration-150 outline-none focus-visible:ring-1 focus-visible:ring-amber-400/40",
        active
          ? barColor ? "bg-stone-800/70 text-stone-100" : "bg-amber-400/10 text-amber-400"
          : accent
            ? "text-stone-300 hover:bg-stone-800/70 hover:text-stone-100"
            : "text-stone-400 hover:bg-stone-800/60 hover:text-stone-200",
      ].join(" ")}
    >
      {/* Indicator bar — colored & always visible for tags, amber & active-only otherwise */}
      <span
        className={`pointer-events-none absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-full transition-all duration-200 ${barColor
          ? active ? "h-4 opacity-100" : "h-2.5 opacity-60 group-hover:opacity-100"
          : active ? "h-4 bg-amber-400 opacity-100" : "h-0 bg-amber-400 opacity-0"
          }`}
        style={barColor ? { backgroundColor: barColor } : undefined}
      />
      {icon && (
        <span className={`shrink-0 transition-transform duration-150 ${active ? "text-amber-400" : "group-hover:scale-110"}`}>
          {icon}
        </span>
      )}
      <span className="truncate">{children}</span>
    </button>
  );
}

function ActionBtn({ onClick, variant = "default", icon, children }) {
  const cls = {
    default: "bg-stone-800 text-stone-200 hover:bg-stone-700 hover:text-white",
    primary: "bg-amber-400 text-stone-950 hover:bg-amber-300",
    danger: "bg-red-500/20 text-red-400 hover:bg-red-500/30 hover:text-red-300",
  }[variant];
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${cls}`}>
      {icon}{children}
    </button>
  );
}

// Tag assign popover

function TagAssignPopover({ item, x, y, tags, onClose, onSave }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  const [selected, setSelected] = useState(new Set(item.tags || []));

  useLayoutEffect(() => {
    if (!ref.current) return;
    const W = window.innerWidth, H = window.innerHeight;
    const w = ref.current.offsetWidth, h = ref.current.offsetHeight;
    setPos({
      left: x + w + 8 > W ? x - w : x + 2,
      top: y + h + 8 > H ? y - h : y + 2,
    });
  }, [x, y]);

  useEffect(() => {
    const onDown = (e) => { if (!ref.current?.contains(e.target)) { onSave([...selected]); onClose(); } };
    const onKey = (e) => { if (e.key === "Escape") { onSave([...selected]); onClose(); } };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, onSave, selected]);

  const toggle = (id) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div
      ref={ref}
      style={{ position: "fixed", left: pos.left, top: pos.top, zIndex: 210 }}
      className="animate-panel-in min-w-[200px] select-none overflow-hidden rounded-xl border border-stone-700/50 bg-stone-900 py-2 shadow-2xl ring-1 ring-black/40"
    >
      <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-stone-500">Tags</p>
      {tags.map(tg => (
        <button
          key={tg.id}
          onClick={() => toggle(tg.id)}
          className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-stone-300 hover:bg-stone-800 transition-colors"
        >
          <span className="h-3 w-3 shrink-0 rounded-full border-2" style={{ backgroundColor: selected.has(tg.id) ? tg.color : "transparent", borderColor: tg.color }} />
          <span className="flex-1 truncate">{tg.name}</span>
          {selected.has(tg.id) && <Icon.Check size={12} className="shrink-0 text-amber-400" />}
        </button>
      ))}
    </div>
  );
}

// macOS Screen Recording permission modal

function ScreenPermissionModal({ t, onRetry }) {
  const [checking, setChecking] = useState(false);

  const handleRetry = async () => {
    setChecking(true);
    await onRetry();
    setChecking(false);
  };

  return (
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="animate-fade-in w-[420px] rounded-2xl border border-stone-700/50 bg-stone-900 p-6 shadow-2xl">
        <h2 className="text-sm font-bold text-stone-100">{t("gallery.screenPermission.title")}</h2>
        <p className="mt-2 text-[13px] leading-relaxed text-stone-400">
          {t("gallery.screenPermission.body")}
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={handleRetry}
            disabled={checking}
            className="rounded-lg px-3 py-1.5 text-[12px] font-medium text-stone-400 hover:bg-stone-800 hover:text-white transition disabled:opacity-50"
          >
            {checking ? t("gallery.screenPermission.checking") : t("gallery.screenPermission.retry")}
          </button>
          <button
            onClick={() => invoke("open_screen_recording_settings")}
            className="rounded-lg bg-amber-500 px-3 py-1.5 text-[12px] font-bold text-stone-950 hover:bg-amber-400 transition"
          >
            {t("gallery.screenPermission.openSettings")}
          </button>
        </div>
      </div>
    </div>
  );
}

// Tag manage modal

const TAG_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#14b8a6", "#3b82f6", "#8b5cf6", "#ec4899",
  "#78716c", "#d97706",
];

function TagManageModal({ tags, t, onClose, onSave }) {
  const [list, setList] = useState(tags);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(TAG_COLORS[0]);
  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState("");
  const [editColor, setEditColor] = useState("");

  const createTag = () => {
    if (!newName.trim()) return;
    const tag = { id: crypto.randomUUID(), name: newName.trim(), color: newColor };
    setList(prev => [...prev, tag]);
    setNewName("");
    setNewColor(TAG_COLORS[0]);
  };

  const startEdit = (tg) => { setEditId(tg.id); setEditName(tg.name); setEditColor(tg.color); };
  const saveEdit = () => {
    setList(prev => prev.map(tg => tg.id === editId ? { ...tg, name: editName.trim() || tg.name, color: editColor } : tg));
    setEditId(null);
  };
  const deleteTag = (id) => setList(prev => prev.filter(tg => tg.id !== id));

  const handleSave = () => { onSave(list); onClose(); };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="animate-fade-in w-[420px] max-h-[80vh] flex flex-col rounded-2xl border border-stone-700/50 bg-stone-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-stone-800 px-5 py-4">
          <h2 className="text-sm font-bold text-stone-100">{t("gallery.tags.manage")}</h2>
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-500 hover:bg-stone-800 hover:text-white transition">
            <Icon.X size={16} />
          </button>
        </div>

        {/* Tag list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 space-y-1">
          {list.length === 0 && (
            <p className="py-4 text-center text-[12px] text-stone-600">{t("gallery.tags.noTags")}</p>
          )}
          {list.map(tg => (
            <div key={tg.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-stone-800/50 group">
              {editId === tg.id ? (
                <>
                  <div className="flex flex-wrap gap-1 shrink-0">
                    {TAG_COLORS.map(c => (
                      <button key={c} onClick={() => setEditColor(c)} className="h-4 w-4 rounded-full border-2 transition" style={{ backgroundColor: c, borderColor: editColor === c ? "white" : "transparent" }} />
                    ))}
                  </div>
                  <input
                    autoFocus
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") saveEdit(); if (e.key === "Escape") setEditId(null); }}
                    className="flex-1 rounded bg-stone-800 px-2 py-0.5 text-[12px] text-stone-100 outline-none focus:ring-1 focus:ring-amber-500/40"
                  />
                  <button onClick={saveEdit} className="shrink-0 rounded px-2 py-0.5 text-[11px] font-semibold text-amber-400 hover:bg-amber-400/10 transition">{t("gallery.tags.save")}</button>
                </>
              ) : (
                <>
                  <span className="h-3.5 w-3.5 shrink-0 rounded-full" style={{ backgroundColor: tg.color }} />
                  <span className="flex-1 text-[13px] text-stone-300 truncate">{tg.name}</span>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => startEdit(tg)} className="h-6 w-6 flex items-center justify-center rounded text-stone-500 hover:bg-stone-700 hover:text-stone-200 transition">
                      <Icon.Pencil size={11} />
                    </button>
                    <button onClick={() => deleteTag(tg.id)} className="h-6 w-6 flex items-center justify-center rounded text-stone-500 hover:bg-red-500/20 hover:text-red-400 transition">
                      <Icon.Trash size={11} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {/* New tag form */}
        <div className="border-t border-stone-800 px-5 py-4">
          <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-stone-600">{t("gallery.tags.createTag")}</p>
          <div className="flex flex-wrap gap-1 mb-2">
            {TAG_COLORS.map(c => (
              <button key={c} onClick={() => setNewColor(c)} className="h-5 w-5 rounded-full border-2 transition" style={{ backgroundColor: c, borderColor: newColor === c ? "white" : "transparent" }} />
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") createTag(); }}
              placeholder={t("gallery.tags.tagName")}
              className="flex-1 rounded-lg bg-stone-800 px-3 py-1.5 text-[13px] text-stone-100 outline-none focus:ring-1 focus:ring-amber-500/40 placeholder:text-stone-600"
            />
            <button onClick={createTag} disabled={!newName.trim()} className="rounded-lg bg-stone-700 px-3 py-1.5 text-[12px] font-semibold text-stone-200 transition hover:bg-stone-600 disabled:opacity-40">
              +
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 border-t border-stone-800 px-5 py-3">
          <button onClick={onClose} className="rounded-lg px-4 py-1.5 text-[13px] text-stone-400 transition hover:bg-stone-800 hover:text-stone-200">{t("gallery.tags.cancel")}</button>
          <button onClick={handleSave} className="rounded-lg bg-amber-500 px-4 py-1.5 text-[13px] font-semibold text-stone-950 transition hover:bg-amber-400">{t("gallery.tags.save")}</button>
        </div>
      </div>
    </div>
  );
}

function CalendarPopover({ mode, startDate, endDate, onChange, onClose, targetRef, lang, dateLocale, items }) {
  const popoverRef = useRef(null);
  
  // Initialize view to startDate or today
  const initDate = startDate ? parseLocalDate(startDate) : new Date();
  const [viewYear, setViewYear] = useState(initDate.getFullYear());
  const [viewMonth, setViewMonth] = useState(initDate.getMonth()); // 0-indexed
  const [hoveredDate, setHoveredDate] = useState(null);
  const [pickerView, setPickerView] = useState("days"); // "days" | "months" | "years"

  // Precompute screenshots dates/months/years
  const screenshotDates = useMemo(() => {
    if (!items) return new Set();
    const dates = new Set();
    for (const it of items) {
      const ms = itemDate(it);
      if (ms) {
        const d = new Date(ms);
        const yStr = d.getFullYear();
        const mStr = String(d.getMonth() + 1).padStart(2, '0');
        const dStr = String(d.getDate()).padStart(2, '0');
        dates.add(`${yStr}-${mStr}-${dStr}`);
      }
    }
    return dates;
  }, [items]);

  const screenshotMonths = useMemo(() => {
    if (!items) return new Set();
    const months = new Set();
    for (const it of items) {
      const ms = itemDate(it);
      if (ms) {
        const d = new Date(ms);
        const yStr = d.getFullYear();
        const mStr = String(d.getMonth() + 1).padStart(2, '0');
        months.add(`${yStr}-${mStr}`);
      }
    }
    return months;
  }, [items]);

  const screenshotYears = useMemo(() => {
    if (!items) return new Set();
    const years = new Set();
    for (const it of items) {
      const ms = itemDate(it);
      if (ms) {
        const d = new Date(ms);
        years.add(d.getFullYear());
      }
    }
    return years;
  }, [items]);

  // Close when clicking outside
  useEffect(() => {
    const onDown = (e) => {
      // If clicked element is inside the calendar popover, do nothing
      if (popoverRef.current && popoverRef.current.contains(e.target)) {
        return;
      }
      // If clicked element is the toggle button, let the toggle button handle it
      if (targetRef && targetRef.current && targetRef.current.contains(e.target)) {
        return;
      }
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose, targetRef]);

  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const firstDay = new Date(viewYear, viewMonth, 1).getDay();
  const offset = firstDay === 0 ? 6 : firstDay - 1; // Mon = 0, Sun = 6

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(prev => prev - 1);
    } else {
      setViewMonth(prev => prev - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(prev => prev + 1);
    } else {
      setViewMonth(prev => prev + 1);
    }
  };

  const monthName = useMemo(() => {
    return new Intl.DateTimeFormat(dateLocale, { month: "long" }).format(new Date(viewYear, viewMonth, 1));
  }, [viewYear, viewMonth, dateLocale]);

  const monthNames = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(dateLocale, { month: "short" });
    return Array.from({ length: 12 }, (_, i) => {
      const date = new Date(2026, i, 15);
      return formatter.format(date);
    });
  }, [dateLocale]);

  const decadeStart = Math.floor(viewYear / 10) * 10;
  const yearsArray = Array.from({ length: 12 }, (_, i) => decadeStart - 1 + i);
  
  const dayNames = lang === "tr" ? ["P", "S", "Ç", "P", "C", "C", "P"] : ["M", "T", "W", "T", "F", "S", "S"];

  const handleDayClick = (day) => {
    const mStr = String(viewMonth + 1).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    const dateStr = `${viewYear}-${mStr}-${dStr}`;

    if (mode === "date") {
      onChange(dateStr, dateStr);
      onClose();
    } else {
      // Range mode
      if (!startDate || (startDate && endDate)) {
        onChange(dateStr, "");
      } else {
        if (dateStr < startDate) {
          onChange(dateStr, "");
        } else {
          onChange(startDate, dateStr);
          onClose();
        }
      }
    }
  };

  const getDayStatus = (day) => {
    const mStr = String(viewMonth + 1).padStart(2, '0');
    const dStr = String(day).padStart(2, '0');
    const dateStr = `${viewYear}-${mStr}-${dStr}`;

    if (mode === "date") {
      return startDate === dateStr ? "selected" : "none";
    }

    if (startDate === dateStr) return "start";
    if (endDate === dateStr) return "end";

    if (startDate && endDate && dateStr > startDate && dateStr < endDate) {
      return "in-range";
    }

    if (startDate && !endDate && hoveredDate && dateStr > startDate && dateStr <= hoveredDate) {
      return dateStr === hoveredDate ? "hover-end" : "in-range-hover";
    }

    return "none";
  };

  return (
    <div
      ref={popoverRef}
      className="absolute top-full mt-1.5 right-0 z-50 w-64 select-none rounded-xl border border-stone-800 bg-stone-950 p-3 shadow-2xl ring-1 ring-black/40 animate-fade-in"
    >
      {pickerView === "days" && (
        <>
          <div className="flex items-center justify-between mb-2">
            <button onClick={prevMonth} className="p-1 hover:bg-stone-900 rounded transition text-stone-400 hover:text-stone-200">
              <Icon.ChevronLeft size={14} />
            </button>
            <button
              onClick={() => setPickerView("months")}
              className="text-[11px] font-semibold text-stone-200 uppercase tracking-wider hover:text-amber-400 transition"
            >
              {monthName} {viewYear}
            </button>
            <button onClick={nextMonth} className="p-1 hover:bg-stone-900 rounded transition text-stone-400 hover:text-stone-200">
              <Icon.ChevronRight size={14} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-y-1 text-center text-[9px] font-bold text-stone-500 mb-1.5">
            {dayNames.map((n, i) => <div key={i}>{n}</div>)}
          </div>

          <div className="grid grid-cols-7 gap-y-0.5 text-center">
            {Array.from({ length: offset }).map((_, i) => (
              <div key={`empty-${i}`} />
            ))}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const status = getDayStatus(day);
              
              const mStr = String(viewMonth + 1).padStart(2, '0');
              const dStr = String(day).padStart(2, '0');
              const dateStr = `${viewYear}-${mStr}-${dStr}`;
              const hasScreenshot = screenshotDates.has(dateStr);

              let btnClass = "text-[11px] font-medium h-7 w-7 flex items-center justify-center rounded-lg transition relative ";
              if (status === "selected" || status === "start" || status === "end" || status === "hover-end") {
                btnClass += "bg-amber-500 text-stone-950 font-semibold shadow-md shadow-amber-500/10";
              } else if (status === "in-range") {
                btnClass += "bg-amber-500/10 text-amber-300 rounded-none";
              } else if (status === "in-range-hover") {
                btnClass += "bg-stone-800/50 text-stone-300 rounded-none";
              } else {
                if (hasScreenshot) {
                  btnClass += "text-amber-400/90 font-bold hover:bg-stone-900 hover:text-amber-300";
                } else {
                  btnClass += "text-stone-400 hover:bg-stone-900 hover:text-stone-200";
                }
              }

              let containerClass = "flex justify-center ";
              if (status === "start" && endDate) {
                containerClass += "bg-amber-500/10 rounded-l-lg";
              } else if (status === "end") {
                containerClass += "bg-amber-500/10 rounded-r-lg";
              } else if (status === "in-range") {
                containerClass += "bg-amber-500/10";
              }

              return (
                <div key={day} className={containerClass}>
                  <button
                    onClick={() => handleDayClick(day)}
                    onMouseEnter={() => setHoveredDate(dateStr)}
                    className={btnClass}
                  >
                    {day}
                    {hasScreenshot && (
                      <span className={`absolute bottom-[2px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${
                        (status === "selected" || status === "start" || status === "end" || status === "hover-end") ? "bg-stone-950" : "bg-amber-500/60"
                      }`} />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        </>
      )}

      {pickerView === "months" && (
        <>
          <div className="flex items-center justify-between mb-3 border-b border-stone-800 pb-2">
            <button onClick={() => setViewYear(y => y - 1)} className="p-1 hover:bg-stone-900 rounded transition text-stone-400 hover:text-stone-200">
              <Icon.ChevronLeft size={14} />
            </button>
            <button
              onClick={() => setPickerView("years")}
              className="text-[11px] font-semibold text-stone-200 uppercase tracking-wider hover:text-amber-400 transition"
            >
              {viewYear}
            </button>
            <button onClick={() => setViewYear(y => y + 1)} className="p-1 hover:bg-stone-900 rounded transition text-stone-400 hover:text-stone-200">
              <Icon.ChevronRight size={14} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            {monthNames.map((name, idx) => {
              const mStr = String(idx + 1).padStart(2, '0');
              const hasScreenshot = screenshotMonths.has(`${viewYear}-${mStr}`);
              const isSelected = viewMonth === idx;

              let btnClass = "text-[12px] font-medium py-3 px-1 rounded-lg transition relative ";
              if (isSelected) {
                btnClass += "bg-amber-500 text-stone-950 font-semibold shadow-md shadow-amber-500/10";
              } else {
                if (hasScreenshot) {
                  btnClass += "text-amber-400/90 font-bold hover:bg-stone-900 hover:text-amber-300";
                } else {
                  btnClass += "text-stone-400 hover:bg-stone-900 hover:text-stone-200";
                }
              }

              return (
                <button
                  key={idx}
                  onClick={() => {
                    setViewMonth(idx);
                    setPickerView("days");
                  }}
                  className={btnClass}
                >
                  {name}
                  {hasScreenshot && (
                    <span className={`absolute bottom-[4px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${isSelected ? "bg-stone-950" : "bg-amber-500/60"}`} />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}

      {pickerView === "years" && (
        <>
          <div className="flex items-center justify-between mb-3 border-b border-stone-800 pb-2">
            <button onClick={() => setViewYear(y => y - 12)} className="p-1 hover:bg-stone-900 rounded transition text-stone-400 hover:text-stone-200">
              <Icon.ChevronLeft size={14} />
            </button>
            <span className="text-[11px] font-semibold text-stone-200 uppercase tracking-wider">
              {decadeStart - 1} - {decadeStart + 10}
            </span>
            <button onClick={() => setViewYear(y => y + 12)} className="p-1 hover:bg-stone-900 rounded transition text-stone-400 hover:text-stone-200">
              <Icon.ChevronRight size={14} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            {yearsArray.map((year) => {
              const hasScreenshot = screenshotYears.has(year);
              const isSelected = viewYear === year;

              let btnClass = "text-[12px] font-medium py-3 px-1 rounded-lg transition relative ";
              if (isSelected) {
                btnClass += "bg-amber-500 text-stone-950 font-semibold shadow-md shadow-amber-500/10";
              } else {
                if (hasScreenshot) {
                  btnClass += "text-amber-400/90 font-bold hover:bg-stone-900 hover:text-amber-300";
                } else {
                  btnClass += "text-stone-400 hover:bg-stone-900 hover:text-stone-200";
                }
              }

              return (
                <button
                  key={year}
                  onClick={() => {
                    setViewYear(year);
                    setPickerView("months");
                  }}
                  className={btnClass}
                >
                  {year}
                  {hasScreenshot && (
                    <span className={`absolute bottom-[4px] left-1/2 -translate-x-1/2 w-1 h-1 rounded-full ${isSelected ? "bg-stone-950" : "bg-amber-500/60"}`} />
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
