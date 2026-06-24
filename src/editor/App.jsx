import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke, listen } from "../lib/tauri.js";
import { useT } from "../lib/i18n.js";
import { CanvasEditor, SIZES } from "./canvas-editor.js";
import * as Icon from "./icons.jsx";
import TitleBar from "../components/TitleBar.jsx";

// Constants

const TOOLS = [
  { id: "select", icon: Icon.Select     },
  { id: "arrow",  icon: Icon.Arrow      },
  { id: "text",   icon: Icon.Text       },
  { id: "shape",  icon: Icon.Shape      },
  { id: "marker", icon: Icon.Pen        },
  { id: "blur",   icon: Icon.Blur       },
  { id: "crop",   icon: Icon.Crop       },
  { id: "bg",     icon: Icon.Background },
];

const BG_PRESETS = [
  // Colorful
  { color1: "#6366f1", color2: "#a855f7" },
  { color1: "#f97316", color2: "#ef4444" },
  { color1: "#06b6d4", color2: "#3b82f6" },
  { color1: "#10b981", color2: "#14b8a6" },
  { color1: "#f59e0b", color2: "#f97316" },
  { color1: "#ec4899", color2: "#f43f5e" },
  { color1: "#8b5cf6", color2: "#06b6d4" },
  { color1: "#22d3ee", color2: "#818cf8" },
  { color1: "#a3e635", color2: "#06b6d4" },
  { color1: "#fb7185", color2: "#c084fc" },
  { color1: "#f472b6", color2: "#fb923c" },
  { color1: "#34d399", color2: "#6366f1" },
  // Dark
  { color1: "#1e293b", color2: "#0f172a" },
  { color1: "#111827", color2: "#030712" },
  { color1: "#1e1b4b", color2: "#0f0a2e" },
  { color1: "#042f2e", color2: "#022c22" },
  { color1: "#312e81", color2: "#1e1b4b" },
  { color1: "#3b0764", color2: "#1a0533" },
  { color1: "#450a0a", color2: "#1c0000" },
  { color1: "#1c1917", color2: "#0c0a09" },
  // White / Gray / Light
  { color1: "#ffffff", color2: "#f1f5f9" },
  { color1: "#f8fafc", color2: "#e2e8f0" },
  { color1: "#e2e8f0", color2: "#94a3b8" },
  { color1: "#ffffff", color2: "#dbeafe" },
  { color1: "#ffffff", color2: "#ede9fe" },
  { color1: "#ffffff", color2: "#d1fae5" },
  { color1: "#fff7ed", color2: "#fed7aa" },
  // Pastel
  { color1: "#fce7f3", color2: "#ede9fe" },
  { color1: "#dbeafe", color2: "#e0e7ff" },
  { color1: "#d1fae5", color2: "#cffafe" },
  { color1: "#fef9c3", color2: "#fde68a" },
  { color1: "#fda4af", color2: "#c4b5fd" },
  // 3-color
  { color1: "#f97316", color3: "#ec4899", color2: "#8b5cf6" },
  { color1: "#0891b2", color3: "#0284c7", color2: "#6366f1" },
  { color1: "#dc2626", color3: "#ea580c", color2: "#facc15" },
  { color1: "#4ade80", color3: "#06b6d4", color2: "#8b5cf6" },
  { color1: "#fbbf24", color3: "#f472b6", color2: "#c084fc" },
  { color1: "#ffffff", color3: "#e0e7ff", color2: "#c7d2fe" },
  { color1: "#f0fdf4", color3: "#d1fae5", color2: "#a7f3d0" },
  { color1: "#0f172a", color3: "#1e1b4b", color2: "#312e81" },
];

const ARROW_KINDS = ["classic", "open", "dots"];
const FONTS = [
  { id: "Arial, sans-serif",              label: "Arial" },
  { id: "'Segoe UI', sans-serif",         label: "Segoe UI" },
  { id: "Verdana, sans-serif",            label: "Verdana" },
  { id: "Tahoma, sans-serif",             label: "Tahoma" },
  { id: "'Trebuchet MS', sans-serif",     label: "Trebuchet MS" },
  { id: "Calibri, sans-serif",            label: "Calibri" },
  { id: "Impact, Haettenschweiler, sans-serif", label: "Impact" },
  { id: "Georgia, serif",                 label: "Georgia" },
  { id: "'Times New Roman', serif",       label: "Times New Roman" },
  { id: "'Palatino Linotype', serif",     label: "Palatino" },
  { id: "'Courier New', monospace",       label: "Courier New" },
  { id: "Consolas, monospace",            label: "Consolas" },
  { id: "'Comic Sans MS', cursive",       label: "Comic Sans" },
];

// Popular Google Fonts — grouped by category for the picker
const GOOGLE_FONTS = [
  // Sans-serif
  "Inter","Roboto","Open Sans","Lato","Montserrat","Poppins","Nunito","Raleway","Oswald",
  "Ubuntu","Barlow","DM Sans","Outfit","Manrope","Karla","Quicksand","Cabin","Fira Sans",
  "Exo 2","Kanit","Titillium Web","Oxygen","Dosis","Mulish","Rubik","Cairo","Comfortaa",
  "Nunito Sans","Jost","Urbanist","Plus Jakarta Sans","Sora","Lexend","Figtree","Albert Sans",
  "Space Grotesk","Encode Sans","Josefin Sans","Varela Round","Catamaran","Signika",
  "Yanone Kaffeesatz","Hind","Noto Sans",
  // Serif
  "Merriweather","Playfair Display","Lora","Libre Baskerville","PT Serif","Arvo","Bitter",
  "Crimson Text","Spectral","Alegreya","Cormorant Garamond","Cinzel","Zilla Slab",
  "Domine","Noto Serif","IM Fell English",
  // Monospace
  "Inconsolata","Source Code Pro","Fira Code","JetBrains Mono","Space Mono",
  "Share Tech Mono","Courier Prime",
  // Display
  "Anton","Bebas Neue","Righteous","Fredoka One","Boogaloo","Lilita One","Russo One",
  "Orbitron","Press Start 2P","Abril Fatface","Patua One","Francois One","Black Han Sans",
  // Handwriting / Script
  "Dancing Script","Pacifico","Lobster","Shadows Into Light","Indie Flower","Sacramento",
  "Great Vibes","Caveat","Satisfy","Kaushan Script","Courgette","Permanent Marker",
  "Amatic SC","Cookie","Tangerine","Pinyon Script","Alex Brush","Italianno","Clicker Script",
];

function gFontId(name) {
  return name.includes(" ") ? `'${name}', sans-serif` : `${name}, sans-serif`;
}

function loadGoogleFont(name) {
  const family = encodeURIComponent(name).replace(/%20/g, "+");
  const href = `https://fonts.googleapis.com/css2?family=${family}:ital,wght@0,400;0,700;1,400;1,700&display=swap`;
  if (document.querySelector(`link[href="${href}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.onload  = () => resolve();
    link.onerror = () => reject(new Error(name));
    document.head.appendChild(link);
  });
}

// Font picker sub-components

function FontPickerRow({ label, fontFamily, selected, onSelect, onRemove, lazy }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!lazy) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { loadGoogleFont(label).catch(() => {}); obs.disconnect(); }
    }, { rootMargin: "200px" });
    obs.observe(el);
    return () => obs.disconnect();
  }, [label, lazy]);

  return (
    <div
      ref={ref}
      onClick={onSelect}
      className={`group flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-stone-800/70 ${selected ? "bg-accent-400/10" : ""}`}
    >
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1">
          <p className="truncate text-[10px] text-stone-500">{label}</p>
          {lazy && (
            <svg className="shrink-0 text-stone-600" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          )}
        </div>
        <p style={{ fontFamily, fontSize: 14, lineHeight: 1.4 }} className="truncate text-stone-200">
          Shotcove
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {selected && <span className="text-[11px] text-accent-400">✓</span>}
        {onRemove && (
          <button
            onClick={e => { e.stopPropagation(); onRemove(); }}
            className="hidden h-4 w-4 items-center justify-center rounded text-stone-500 hover:bg-red-500/20 hover:text-red-400 group-hover:flex"
          >×</button>
        )}
      </div>
    </div>
  );
}

function PickerSection({ label }) {
  return (
    <p className="sticky top-0 z-10 bg-stone-950/95 px-3 py-1 text-[9px] font-bold uppercase tracking-widest text-stone-500 backdrop-blur-sm">
      {label}
    </p>
  );
}

function FontPickerPopup({ anchor, value, customFonts, onPickSystem, onPickGoogle, onRemove, onClose }) {
  const [search, setSearch] = useState("");
  const popupRef  = useRef(null);
  const inputRef  = useRef(null);
  const q = search.toLowerCase();

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    const h = e => { if (popupRef.current && !popupRef.current.contains(e.target)) onClose(); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onClose]);

  const addedIds  = new Set(customFonts.map(f => f.id));
  const sysMatch  = FONTS.filter(f => !q || f.label.toLowerCase().includes(q));
  const addMatch  = customFonts.filter(f => !q || f.label.toLowerCase().includes(q));
  const gMatch    = GOOGLE_FONTS.filter(n => !addedIds.has(gFontId(n)) && (!q || n.toLowerCase().includes(q)));
  const anyMatch  = sysMatch.length + addMatch.length + gMatch.length > 0;

  const left = Math.min(anchor.left, window.innerWidth - 292);

  return createPortal(
    <div
      ref={popupRef}
      style={{ position: "fixed", top: anchor.bottom + 6, left, width: 284, zIndex: 9999 }}
      className="flex flex-col rounded-xl border border-stone-700/60 bg-stone-950 shadow-2xl ring-1 ring-black/60"
    >
      <div className="p-2 border-b border-stone-800/80">
        <input
          ref={inputRef}
          type="text"
          placeholder="Search fonts…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => { e.stopPropagation(); if (e.key === "Escape") onClose(); }}
          className="w-full rounded-md bg-stone-800 px-2.5 py-1.5 text-xs text-stone-200 border border-stone-700 outline-none focus:ring-1 focus:ring-accent-400 placeholder:text-stone-600"
        />
      </div>

      <div className="overflow-y-auto divide-y divide-stone-800/30" style={{ maxHeight: 360 }}>
        {!anyMatch && <p className="py-5 text-center text-xs text-stone-500">No fonts found</p>}

        {sysMatch.length > 0 && (
          <>
            <PickerSection label="System" />
            {sysMatch.map(f => (
              <FontPickerRow key={f.id} label={f.label} fontFamily={f.id}
                selected={value === f.id}
                onSelect={() => { onPickSystem(f.id); onClose(); }} />
            ))}
          </>
        )}

        {addMatch.length > 0 && (
          <>
            <PickerSection label="Added" />
            {addMatch.map(f => (
              <FontPickerRow key={f.id} label={f.label} fontFamily={f.id}
                selected={value === f.id}
                onSelect={() => { onPickSystem(f.id); onClose(); }}
                onRemove={() => onRemove(f.id)} />
            ))}
          </>
        )}

        {gMatch.length > 0 && (
          <>
            <PickerSection label="Google Fonts" />
            {gMatch.map(name => (
              <FontPickerRow key={name} label={name} fontFamily={`'${name}', sans-serif`}
                selected={gFontId(name) === value}
                onSelect={() => { onPickGoogle(name); onClose(); }}
                lazy />
            ))}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
const TEXT_BGS = ["none", "white", "black"];
const SHAPES = [
  { id: "rect",     label: "▭" },
  { id: "ellipse",  label: "○" },
  { id: "triangle", label: "△" },
  { id: "diamond",  label: "◇" },
  { id: "pentagon", label: "⬠" },
  { id: "hexagon",  label: "⬡" },
  { id: "star",     label: "☆" },
  { id: "line",     label: "╱" },
];
const BLURS = ["rect", "brush"];
const FORMATS = ["png", "jpg", "webp", "avif", "bmp"];

const DRAW_COLORS = [
  "#ef4444", "#f97316", "#f59e0b", "#eab308",
  "#84cc16", "#22c55e", "#10b981", "#06b6d4",
  "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899",
  "#ffffff", "#cbd5e1", "#57534e", "#1c1917",
];

const FONT_SIZES = [14, 20, 28, 38, 52, 72];

// Small UI components

function ToolBtn({ active, onClick, icon: I, label }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`flex h-9 w-9 items-center justify-center rounded-lg transition-all ${
        active
          ? "bg-accent-400 text-stone-950 shadow-sm"
          : "text-stone-500 hover:bg-stone-800 hover:text-stone-100"
      }`}
    >
      <I size={18} />
    </button>
  );
}

function IconBtn({ onClick, disabled, title, children }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex h-8 w-8 items-center justify-center rounded-md text-stone-500 transition hover:bg-stone-800 hover:text-stone-200 disabled:pointer-events-none disabled:opacity-25 @max-[1319px]:h-7 @max-[1319px]:w-7"
    >
      {children}
    </button>
  );
}

function Chip({ active, onClick, onContextMenu, title, children }) {
  return (
    <button
      title={title}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`flex h-7 min-w-[2rem] items-center justify-center rounded-md px-2.5 text-xs font-medium transition ${
        active
          ? "bg-accent-400 text-stone-950"
          : "bg-stone-800/80 text-stone-300 hover:bg-stone-700 hover:text-stone-100"
      }`}
    >
      {children}
    </button>
  );
}

const VDivider = () => <div className="h-4 w-px shrink-0 bg-stone-700/60" />;

function ColorCircle({ value, onChange, title }) {
  return (
    <label title={title} className="shrink-0 cursor-pointer">
      <div
        className="h-6 w-6 rounded-full border-2 border-stone-700 hover:border-stone-400 transition"
        style={{ background: value }}
      />
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="sr-only"
      />
    </label>
  );
}

function SplitBtn({ label, icon: I, onClick, disabled, menuOpen, onMenuToggle, menuRef, formats, onFormat, menuTitle, compact, measure }) {
  const [menuPos, setMenuPos] = useState({ bottom: 0, right: 0 });
  return (
    <div className="relative flex shrink-0" ref={measure ? null : menuRef}>
      <button
        onClick={measure ? undefined : onClick}
        disabled={disabled}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-l-lg border-r border-stone-950/40 bg-stone-800 px-3 py-1.5 text-sm text-stone-200 transition hover:bg-stone-700 disabled:opacity-40"
      >
        <I size={15} />
        {!compact && <span>{label}</span>}
      </button>
      <button
        onClick={measure ? undefined : () => {
          if (menuRef.current) {
            const rect = menuRef.current.getBoundingClientRect();
            setMenuPos({ bottom: window.innerHeight - rect.top + 8, right: window.innerWidth - rect.right });
          }
          onMenuToggle();
        }}
        disabled={disabled}
        title={menuTitle}
        className="flex shrink-0 items-center justify-center rounded-r-lg bg-stone-800 px-1.5 text-stone-400 transition hover:bg-stone-700 hover:text-stone-200 disabled:opacity-40"
      >
        <Icon.ChevronDown size={13} />
      </button>
      {!measure && menuOpen && createPortal(
        <div
          data-portal-menu
          style={{ position: "fixed", bottom: menuPos.bottom, right: menuPos.right, zIndex: 9999 }}
          className="flex items-center gap-1 rounded-xl border border-stone-700/50 bg-stone-900 p-1 shadow-2xl ring-1 ring-black/30"
        >
          {formats.map((f) => (
            <button
              key={f}
              onClick={() => onFormat(f)}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium uppercase tracking-wide text-stone-300 transition hover:bg-stone-800 hover:text-stone-100"
            >
              {f}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

const isDirectLinkReady = (s) => {
  if (!s || !Array.isArray(s.direct_link_providers)) return false;
  return s.direct_link_providers.some((p) => {
    if (!p.enabled) return false;
    if (p.id === "imgbb") return (s.imgbb_api_key || "").trim().length > 0;
    if (p.id === "freeimage") return (s.freeimage_api_key || "").trim().length > 0;
    return true; // prntscr, catbox
  });
};

export default function App() {
  const canvasRef     = useRef(null);
  const viewportRef   = useRef(null);
  const gridRef       = useRef(null);
  const textInputRef  = useRef(null);
  const cropConfRef   = useRef(null);
  const edRef         = useRef(null);
  const toastTimer    = useRef(null);
  const saveMenuRef   = useRef(null);
  const copyMenuRef   = useRef(null);
  const footerRightRef    = useRef(null);
  const footerRightMeasureRef = useRef(null);
  const tagBtnRef      = useRef(null);
  const gradPopupRef  = useRef(null);
  const swatchBtnRef  = useRef(null);

  const [customPresets, setCustomPresets] = useState(() => {
    try { return JSON.parse(localStorage.getItem("shotcove_grad_presets") || "[]"); } catch { return []; }
  });
  const [customFonts, setCustomFonts] = useState(() => {
    try { return JSON.parse(localStorage.getItem("shotcove_custom_fonts") || "[]"); } catch { return []; }
  });
  const [fontPickerOpen,   setFontPickerOpen]   = useState(false);
  const [fontPickerAnchor, setFontPickerAnchor] = useState(null);
  const fontPickerBtnRef = useRef(null);
  const [gradPopupOpen, setGradPopupOpen] = useState(false);
  const [gradPopupPos,  setGradPopupPos]  = useState({ top: 0, left: 0 });
  const [s,            setS]            = useState(null);
  const [toast,        setToast]        = useState(null);
  const [busy,         setBusy]         = useState(false);
  const [directLinkReady, setDirectLinkReady] = useState(false);
  const [driveConnected, setDriveConnected] = useState(false);
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [copyMenuOpen, setCopyMenuOpen] = useState(false);
  const [ctxMenu,      setCtxMenu]      = useState(null);
  const [padLocked,    setPadLocked]    = useState(false);
  const [lang,         setLang]         = useState("en");
  const [editorMeta,   setEditorMeta]   = useState(null); // { filename, tags }
  const [allTags,      setAllTags]      = useState([]);
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [tagMenuPos, setTagMenuPos] = useState({ bottom: 0, right: 0 });
  const [footerCompact, setFooterCompact] = useState(false);
  const [windowOverlayOpen, setWindowOverlayOpen] = useState(false);
  const originalCanvasSize = useRef(null); // { w, h } — set once on first emit
  const originalMetaRef = useRef(null);
  const padDragRef    = useRef(null);
  const padLockedRef  = useRef(false);
  const panRef        = useRef(null);
  const autoBgParam   = new URLSearchParams(window.location.search).has("auto_bg");
  const autoBgDone    = useRef(false);
  const templateForSlot = new URLSearchParams(window.location.search).get("template_for");
  const existingTemplate = (() => {
    const b64 = new URLSearchParams(window.location.search).get("template_data");
    if (!b64) { console.log("[bg-template-debug] no template_data param. search=", window.location.search); return null; }
    try {
      const parsed = JSON.parse(atob(b64.replace(/-/g, "+").replace(/_/g, "/")));
      console.log("[bg-template-debug] decoded template_data:", parsed);
      return parsed;
    } catch (e) {
      console.log("[bg-template-debug] failed to decode template_data:", b64, e);
      return null;
    }
  })();

  const t = useT(lang);
  useEffect(() => { document.title = `Shotcove — ${t("editor.title")}`; }, [lang]);

  // Show the window immediately (with a loading spinner) instead of waiting for the
  // image to decode and render — avoids a long blank/hidden period followed by a sudden pop-in.
  useEffect(() => { invoke("editor_ready").catch(() => {}); }, []);

  // Close menus on outside click
  useEffect(() => {
    const h = (e) => {
      // Portaled dropdowns (format menus, tag panel) live outside their trigger's DOM
      // subtree in document.body, so a click inside them must not be treated as "outside".
      if (e.target.closest?.("[data-portal-menu]")) return;
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target)) setSaveMenuOpen(false);
      if (copyMenuRef.current && !copyMenuRef.current.contains(e.target)) setCopyMenuOpen(false);
      if (!swatchBtnRef.current?.contains(e.target) && !gradPopupRef.current?.contains(e.target)) setGradPopupOpen(false);
      if (tagBtnRef.current && !tagBtnRef.current.contains(e.target)) setTagPanelOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  // Footer right-side group (zoom/copy/save/drive/tags) switches to icon-only once its
  // full-label width (measured via a hidden clone) no longer fits the space the flex
  // layout actually grants it — adapts to any locale/font without a guessed pixel breakpoint.
  useEffect(() => {
    const visible = footerRightRef.current;
    const measureEl = footerRightMeasureRef.current;
    if (!visible || !measureEl) return;
    // Going compact shrinks the footer's own gaps/padding, which grows `visible.clientWidth`
    // right at the threshold — without a buffer that growth flips it back to non-compact,
    // which un-shrinks the gaps, which flips it again, forever. The buffer absorbs that swing.
    const recalc = () => {
      const overflow = measureEl.scrollWidth - visible.clientWidth;
      setFooterCompact((prev) => {
        if (!prev && overflow > 0) return true;
        if (prev && overflow < -24) return false;
        return prev;
      });
    };
    recalc();
    const ro1 = new ResizeObserver(recalc);
    const ro2 = new ResizeObserver(recalc);
    ro1.observe(visible);
    ro2.observe(measureEl);
    return () => { ro1.disconnect(); ro2.disconnect(); };
  }, []);

  // Close context menu on outside click
  useEffect(() => {
    const h = () => setCtxMenu(null);
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const renderFooterRight = ({ compact, measure = false }) => (
    <>
      {/* Zoom */}
      <div className="flex shrink-0 items-center gap-0.5">
        <IconBtn title={t("editor.actions.fitScreen")} onClick={measure ? undefined : () => ed().fitZoom()}>
          <Icon.Maximize2 size={14} />
        </IconBtn>
        <IconBtn title={t("editor.actions.actualSize")} onClick={measure ? undefined : () => ed().setZoom(1, true)}>
          <span className="text-[10px] font-bold tabular-nums leading-none">1:1</span>
        </IconBtn>
        <VDivider />
        <IconBtn title={t("editor.actions.zoomOut")} onClick={measure ? undefined : () => ed()._zoomCenter(ed().zoom / 1.15)}>
          <Icon.Minus size={14} />
        </IconBtn>
        <button
          onClick={measure ? undefined : () => ed().fitZoom()}
          title={t("editor.actions.fitScreen")}
          className="w-12 shrink-0 rounded-md py-1 text-center text-xs tabular-nums text-stone-500 transition hover:bg-stone-800 hover:text-stone-200"
        >
          {zoomPct}%
        </button>
        <IconBtn title={t("editor.actions.zoomIn")} onClick={measure ? undefined : () => ed()._zoomCenter(ed().zoom * 1.15)}>
          <Icon.Plus size={14} />
        </IconBtn>
      </div>

      <VDivider />

      {/* Actions */}
      <div className={`flex shrink-0 items-center ${compact ? "gap-1" : "gap-1.5"}`}>
        {templateForSlot ? (
          <button
            onClick={measure ? undefined : saveAsTemplate}
            disabled={busy}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent-400 px-3 py-1.5 text-sm font-semibold text-stone-950 transition hover:bg-accent-300 disabled:opacity-40"
          >
            <Icon.Download size={15} /> {!compact && <span>{t("editor.saveAsTemplate")}</span>}
          </button>
        ) : (
        <>
        <SplitBtn
          label={t("editor.copy")}
          icon={Icon.Copy}
          onClick={doCopy}
          disabled={busy}
          menuOpen={copyMenuOpen}
          onMenuToggle={() => setCopyMenuOpen((v) => !v)}
          menuRef={copyMenuRef}
          formats={FORMATS}
          onFormat={(f) => { doCopyFmt(f); setCopyMenuOpen(false); }}
          menuTitle={t("editor.formatSelect")}
          compact={compact}
          measure={measure}
        />
        <button
          onClick={measure ? undefined : () => doCopyAndSave()}
          disabled={busy}
          title={t("editor.copyAndSave")}
          className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm font-medium text-stone-300 transition hover:border-stone-500 hover:text-stone-100 disabled:opacity-40"
        >
          <Icon.CopySave size={15} /> {!compact && <span>{t("editor.copyAndSave")}</span>}
        </button>
        <SplitBtn
          label={t("editor.save")}
          icon={Icon.Download}
          onClick={() => doSave()}
          disabled={busy}
          menuOpen={saveMenuOpen}
          onMenuToggle={() => setSaveMenuOpen((v) => !v)}
          menuRef={saveMenuRef}
          formats={FORMATS}
          onFormat={(f) => { doSave(f); setSaveMenuOpen(false); }}
          menuTitle={t("editor.formatSelect")}
          compact={compact}
          measure={measure}
        />
        {driveConnected && (
          <button
            onClick={measure ? undefined : doShare}
            disabled={busy}
            title={t("editor.driveTitle")}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-accent-400 px-3 py-1.5 text-sm font-semibold text-stone-950 transition hover:bg-accent-300 disabled:opacity-40"
          >
            <Icon.DriveCopy size={15} /> {!compact && <span>{t("editor.drive")}</span>}
          </button>
        )}
        {directLinkReady && (
          <button
            onClick={measure ? undefined : doDirectLink}
            disabled={busy}
            title={t("editor.directLinkTitle")}
            className="flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg border border-stone-700 bg-stone-900 px-3 py-1.5 text-sm font-medium text-stone-300 transition hover:border-stone-500 hover:text-stone-100 disabled:opacity-40"
          >
            <Icon.ExternalLink size={15} /> {!compact && <span>{t("editor.directLink")}</span>}
          </button>
        )}
        </>
        )}
      </div>

      {/* Tag panel button — irrelevant in template mode, there's no real saved file to tag */}
      {!templateForSlot && allTags.length > 0 && (
        <>
          <VDivider />
          <button
            ref={measure ? null : tagBtnRef}
            onClick={measure ? undefined : () => {
              if (tagBtnRef.current) {
                const rect = tagBtnRef.current.getBoundingClientRect();
                setTagMenuPos({ bottom: window.innerHeight - rect.top + 8, right: window.innerWidth - rect.right });
              }
              setTagPanelOpen(v => !v);
            }}
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-[12px] transition ${tagPanelOpen ? "bg-stone-700 text-stone-100" : "text-stone-500 hover:bg-stone-800 hover:text-stone-300"}`}
            title={t("editor.tags") || "Tags"}
          >
            {(editorMeta?.tags || []).length > 0
              ? <span className="flex gap-0.5">{(editorMeta.tags || []).map(id => { const tg = allTags.find(t => t.id === id); return tg ? <span key={id} className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: tg.color }} /> : null; })}</span>
              : <span className="h-2.5 w-2.5 rounded-full border border-stone-600" />
            }
            {!compact && <span>{t("gallery.tags.title")}</span>}
          </button>
          {!measure && tagPanelOpen && createPortal(
            <div
              data-portal-menu
              style={{ position: "fixed", bottom: tagMenuPos.bottom, right: tagMenuPos.right, zIndex: 9999 }}
              className="animate-panel-in min-w-[200px] overflow-hidden rounded-xl border border-stone-700/50 bg-stone-900 py-2 shadow-2xl"
            >
              <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-stone-500">{t("gallery.tags.assignTags")}</p>
              {allTags.map(tg => {
                const active = (editorMeta?.tags || []).includes(tg.id);
                const toggle = async () => {
                  const newTags = active
                    ? (editorMeta?.tags || []).filter(id => id !== tg.id)
                    : [...(editorMeta?.tags || []), tg.id];
                  setEditorMeta(prev => ({ ...prev, tags: newTags }));
                  // For already-saved files, persist immediately; for fresh captures, tags are sent on save
                  if (editorMeta?.filename) {
                    await invoke("set_image_tags", { filename: editorMeta.filename, tagIds: newTags }).catch(() => {});
                  }
                };
                return (
                  <button key={tg.id} onClick={toggle}
                    className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-stone-300 hover:bg-stone-800 transition-colors">
                    <span className="h-3 w-3 shrink-0 rounded-full border-2 transition-colors" style={{ backgroundColor: active ? tg.color : "transparent", borderColor: tg.color }} />
                    <span className="flex-1 truncate">{tg.name}</span>
                    {active && <span className="text-amber-400 text-[11px]">✓</span>}
                  </button>
                );
              })}
            </div>,
            document.body
          )}
        </>
      )}
    </>
  );

  // Re-inject Google Font <link> tags for any custom fonts saved from a previous session.
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("shotcove_custom_fonts") || "[]");
      saved.forEach(f => loadGoogleFont(f.label));
    } catch {}
  }, []);

  async function handlePickGoogleFont(name) {
    try {
      await loadGoogleFont(name);
    } catch {
      showToast(t("editor.toast.fontLoadError"));
      return;
    }
    const id = gFontId(name);
    if (!customFonts.some(f => f.id === id)) {
      const updated = [...customFonts, { id, label: name }];
      setCustomFonts(updated);
      localStorage.setItem("shotcove_custom_fonts", JSON.stringify(updated));
    }
    edRef.current?.setFontKind(id);
  }

  function handleRemoveCustomFont(id) {
    const updated = customFonts.filter(f => f.id !== id);
    setCustomFonts(updated);
    localStorage.setItem("shotcove_custom_fonts", JSON.stringify(updated));
    if (s?.fontKind === id) edRef.current?.setFontKind(FONTS[0].id);
  }

  // Initialize canvas editor
  useEffect(() => {
    const ed = new CanvasEditor({
      canvas:      canvasRef.current,
      viewport:    viewportRef.current,
      grid:        gridRef.current,
      textInput:   textInputRef.current,
      cropConfirm: cropConfRef.current,
      onState: (st) => {
        if (!originalCanvasSize.current && st.canvasW && st.canvasH) {
          originalCanvasSize.current = { w: st.canvasW, h: st.canvasH };
          if (autoBgParam && !autoBgDone.current) {
            autoBgDone.current = true;
            const applyBg = () => {
              ed.setTool("bg");
              if (existingTemplate) {
                const tpl = existingTemplate;
                ed.updateBg({
                  enabled: true,
                  type: tpl.bg_type,
                  color1: tpl.color1,
                  color2: tpl.color2,
                  angle: tpl.angle,
                  paddingTop: tpl.padding, paddingRight: tpl.padding, paddingBottom: tpl.padding, paddingLeft: tpl.padding,
                  borderRadius: tpl.border_radius,
                  shadowEnabled: tpl.shadow,
                });
              } else {
                // No specific template — keep whatever the user last used
                // (canvas-editor's own remembered prefs), just turn it on.
                ed.updateBg({ enabled: true });
              }
            };
            applyBg();
            // loadImage()'s own post-ready continuation (editor_ready +
            // rAF) re-touches tool/bg state right after this fires, racing
            // with it — reapply once more after that settles so our values
            // are the ones left standing.
            setTimeout(applyBg, 300);
          }
        }
        if (originalCanvasSize.current && st.canvasW && st.canvasH) {
          const isCropped = st.canvasW < originalCanvasSize.current.w || st.canvasH < originalCanvasSize.current.h;
          setEditorMeta(prev => {
            if (!prev) return prev;
            if (isCropped) {
              if (prev.monitorRects.length > 0 || prev.windowCrops.length > 0) {
                return { ...prev, monitorRects: [], monitorNames: [], windowCrops: [] };
              }
            } else {
              const orig = originalMetaRef.current;
              if (orig && prev.monitorRects.length === 0 && (orig.monitorRects.length > 0 || orig.windowCrops.length > 0)) {
                return { ...prev, monitorRects: orig.monitorRects, monitorNames: orig.monitorNames, windowCrops: orig.windowCrops };
              }
            }
            return prev;
          });
        }
        setS(st);
      },
    });
    edRef.current = ed;
    ed.loadImage();
    return () => ed.dispose();
  }, []);

  // Persist custom gradient presets to localStorage
  useEffect(() => {
    try { localStorage.setItem("shotcove_grad_presets", JSON.stringify(customPresets)); } catch {}
  }, [customPresets]);

  // Load settings and subscribe to changes
  useEffect(() => {
    invoke("get_settings").then((cfg) => {
      setDirectLinkReady(isDirectLinkReady(cfg));
      setLang(cfg.language ?? "en");
    });
    invoke("get_drive_status").then((status) => setDriveConnected(!!status.connected)).catch(() => {});
    const unlisten = listen("settings-changed", (ev) => setLang(ev.payload?.language ?? "en"));
    return () => { unlisten.then(f => f()); };
  }, []);

  // Load editor metadata (filename + tags) and available tags
  useEffect(() => {
    invoke("get_editor_meta").then(meta => {
      const parsed = { filename: meta.filename || null, tags: meta.tags || [], monitorRects: meta.monitor_rects || [], monitorNames: meta.monitor_names || [], windowCrops: meta.window_crops || [] };
      setEditorMeta(parsed);
      originalMetaRef.current = parsed;
      if (meta.bg_template) {
        const tpl = meta.bg_template;
        ed().setTool("bg");
        ed().updateBg({
          enabled: true,
          type: tpl.bg_type,
          color1: tpl.color1,
          color2: tpl.color2,
          angle: tpl.angle,
          paddingTop: tpl.padding, paddingRight: tpl.padding, paddingBottom: tpl.padding, paddingLeft: tpl.padding,
          borderRadius: tpl.border_radius,
          shadowEnabled: tpl.shadow,
        });
      }
    }).catch(() => {});
    invoke("get_tags").then(setAllTags).catch(() => {});
  }, []);

  // Close window overlay when tool changes away from crop
  useEffect(() => {
    if (s?.tool !== "crop") setWindowOverlayOpen(false);
  }, [s?.tool]);

  const showToast = useCallback((msg) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2500);
  }, []);

  const run = useCallback(async (fn) => {
    setBusy(true);
    try   { await fn(); }
    catch (e) { showToast(t("editor.toast.error") + " " + e); }
    finally { setBusy(false); }
  }, [showToast, t]);

  const getData = () => edRef.current.exportData();

  const doCopy    = useCallback(() => run(async () => { await invoke("editor_copy",      { data: getData() }); showToast(t("editor.toast.copied")); }), [run, showToast, t]);
  const doCopyFmt = useCallback((fmt) => run(() => invoke("editor_copy_file", { data: getData(), format: fmt })), [run]);
  const doSave       = useCallback((fmt = null) => run(() => invoke("editor_save",        { data: getData(), format: fmt, tagIds: editorMeta?.tags ?? [] })), [run, editorMeta]);
  // editor_copy doesn't close the window; editor_save does — call copy first
  const doCopyAndSave = useCallback((fmt = null) => run(async () => {
    const data = getData();
    await invoke("editor_copy", { data });
    await invoke("editor_save", { data, format: fmt, tagIds: editorMeta?.tags ?? [] });
  }), [run, editorMeta]);
  const doShare      = useCallback(() => run(async () => { showToast(t("editor.toast.uploading")); await invoke("editor_share",       { data: getData(), tagIds: editorMeta?.tags ?? [] }); }), [run, showToast, t, editorMeta]);
  const doDirectLink = useCallback(() => run(() => invoke("editor_direct_link", { data: getData(), tagIds: editorMeta?.tags ?? [] })), [run, editorMeta]);
  const saveAsTemplate = useCallback(() => run(() => {
    const bg = s?.bg ?? {};
    return invoke("save_bg_template", {
      slotId: templateForSlot,
      template: {
        bg_type: bg.type === "solid" ? "solid" : "gradient",
        color1: bg.color1,
        color2: bg.color2 ?? bg.color1,
        angle: bg.angle ?? 135,
        padding: bg.paddingTop ?? 60,
        border_radius: bg.borderRadius ?? 0,
        shadow: !!bg.shadowEnabled,
      },
    });
  }), [run, s, templateForSlot]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      const ed = edRef.current;
      if (!ed || e.target === textInputRef.current) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey) {
        if (k === "z") { e.preventDefault(); e.shiftKey ? ed.redo() : ed.undo(); return; }
        if (k === "y") { e.preventDefault(); ed.redo(); return; }
        if (k === "c") { e.preventDefault(); doCopy(); return; }
        if (k === "s") { e.preventDefault(); doSave(); return; }
      }
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        const toolMap = { v: "select", a: "arrow", t: "text", s: "shape", p: "marker", b: "blur", c: "crop", g: "bg" };
        if (toolMap[k]) { ed.setTool(toolMap[k]); return; }
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (ed.canDeleteSelection()) { e.preventDefault(); ed.deleteSelected(); }
      } else if (e.key === "Escape") {
        if (windowOverlayOpen) { setWindowOverlayOpen(false); return; }
        if (ed.cropRect)         ed.cancelCrop();
        else if (ed.selectedIdx >= 0) ed.deselect();
        else invoke("editor_close");
      } else if (e.key === "Enter" && ed.cropRect) {
        ed.applyCrop();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doCopy, doSave, windowOverlayOpen]);

  // Padding drag

  const startPadDrag = useCallback((side, e) => {
    e.preventDefault();
    e.stopPropagation();
    const capSide = side[0].toUpperCase() + side.slice(1);
    const bg = edRef.current?.bg ?? {};
    padDragRef.current = {
      side,
      startX: e.clientX,
      startY: e.clientY,
      startVal: bg[`padding${capSide}`] ?? 60,
      startAll: { paddingTop: bg.paddingTop ?? 60, paddingRight: bg.paddingRight ?? 60, paddingBottom: bg.paddingBottom ?? 60, paddingLeft: bg.paddingLeft ?? 60 },
    };
    const onMove = (me) => {
      const d = padDragRef.current;
      if (!d) return;
      const dpr  = window.devicePixelRatio || 1;
      const zoom = edRef.current?.zoom ?? 1;
      const scale = dpr / zoom;
      const dx = (me.clientX - d.startX) * scale;
      const dy = (me.clientY - d.startY) * scale;
      const delta = d.side === "top" ? -dy : d.side === "bottom" ? dy : d.side === "left" ? -dx : dx;
      const newVal = Math.max(0, Math.round(d.startVal + delta));
      const capS   = d.side[0].toUpperCase() + d.side.slice(1);
      if (padLockedRef.current) {
        const diff = newVal - d.startVal;
        edRef.current?.updateBg({
          paddingTop:    Math.max(0, Math.round(d.startAll.paddingTop    + diff)),
          paddingRight:  Math.max(0, Math.round(d.startAll.paddingRight  + diff)),
          paddingBottom: Math.max(0, Math.round(d.startAll.paddingBottom + diff)),
          paddingLeft:   Math.max(0, Math.round(d.startAll.paddingLeft   + diff)),
        });
      } else {
        edRef.current?.updateBg({ [`padding${capS}`]: newVal });
      }
    };
    const onUp = () => {
      padDragRef.current = null;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }, []);

  const startCornerDrag = useCallback((corner, e) => {
    e.preventDefault();
    e.stopPropagation();
    const bg = edRef.current?.bg ?? {};
    const startAll = { paddingTop: bg.paddingTop ?? 60, paddingRight: bg.paddingRight ?? 60, paddingBottom: bg.paddingBottom ?? 60, paddingLeft: bg.paddingLeft ?? 60 };
    const ref = { startX: e.clientX, startY: e.clientY, startAll };
    // corner outward direction: tl=(-1,-1), tr=(+1,-1), br=(+1,+1), bl=(-1,+1)
    const sx = (corner === "tr" || corner === "br") ? 1 : -1;
    const sy = (corner === "bl" || corner === "br") ? 1 : -1;
    const onMove = (me) => {
      const dpr  = window.devicePixelRatio || 1;
      const zoom = edRef.current?.zoom ?? 1;
      const scale = dpr / zoom;
      const dx = (me.clientX - ref.startX) * scale;
      const dy = (me.clientY - ref.startY) * scale;
      const delta = Math.round((sx * dx + sy * dy) / 2);
      const a = ref.startAll;
      edRef.current?.updateBg({
        paddingTop:    Math.max(0, a.paddingTop    + delta),
        paddingRight:  Math.max(0, a.paddingRight  + delta),
        paddingBottom: Math.max(0, a.paddingBottom + delta),
        paddingLeft:   Math.max(0, a.paddingLeft   + delta),
      });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup",   onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }, []);

  // Keep ref in sync to avoid stale reads inside closures
  useEffect(() => { padLockedRef.current = padLocked; }, [padLocked]);

  // Viewport pan (drag empty area)

  const startPan = useCallback((e) => {
    if (e.button !== 0) return;
    if (canvasRef.current?.contains(e.target)) return;
    e.preventDefault();
    const vp = viewportRef.current;
    panRef.current = { startX: e.clientX, startY: e.clientY, sl: vp.scrollLeft, st: vp.scrollTop };
    const onMove = (me) => {
      if (!panRef.current) return;
      const { startX, startY, sl, st } = panRef.current;
      vp.scrollLeft = sl - (me.clientX - startX);
      vp.scrollTop  = st - (me.clientY - startY);
    };
    const onUp = () => { panRef.current = null; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup",   onUp);
  }, []);

  // Derived state

  const ed = () => edRef.current;
  const tool    = s?.tool;
  const st      = s?.selectedType;
  const zoomPct = s ? Math.round(s.zoom * 100) : 100;

  const showArrow = tool === "arrow"  || (tool === "select" && st === "arrow");
  const showText  = tool === "text"   || (tool === "select" && st === "text");
  const showShape = tool === "shape"  || (tool === "select" && ["rect","ellipse","line","star","triangle","diamond","pentagon","hexagon"].includes(st));
  const showBlur  = tool === "blur"   || (tool === "select" && st === "blurbox");
  const showBg    = tool === "bg"     && s?.bg != null;
  const canDelete = s?.canDelete ?? false;
  // Presets are only meaningful when the canvas is at its original (uncropped) size.
  // Comparing canvas dims lets undo automatically restore preset visibility without
  // needing to track or restore editorMeta separately.
  const origSize = originalCanvasSize.current;
  const canvasIsOriginal = origSize && s?.canvasW === origSize.w && s?.canvasH === origSize.h;
  const showMonitorPresets = tool === "crop" && canvasIsOriginal && (editorMeta?.monitorRects?.length ?? 0) > 1;
  const showWindowPresets  = tool === "crop" && canvasIsOriginal && (editorMeta?.windowCrops?.length ?? 0) > 0;
  const hasCtx    = showArrow || showText || showShape || showBlur || showBg || canDelete || showMonitorPresets || showWindowPresets;

  // Convert window crop rects (image pixels) → viewport client coords for the overlay
  const windowRects = (() => {
    if (!windowOverlayOpen || !canvasRef.current || !s?.zoom) return [];
    const cr  = canvasRef.current.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const z   = s.zoom;
    return (editorMeta?.windowCrops ?? []).map(wc => ({
      x: cr.left + wc.x * z / dpr,
      y: cr.top  + wc.y * z / dpr,
      w: wc.w * z / dpr,
      h: wc.h * z / dpr,
    }));
  })();

  const showColor = tool && tool !== "crop" && tool !== "bg";
  const showPaint = showColor && tool !== "text" && !(tool === "select" && st === "text");

  // JSX

  return (
    <div className="flex h-screen flex-col bg-stone-950 text-stone-100">

      {/* Loading overlay — shown until the image has decoded & rendered */}
      <div className={`fixed inset-0 z-50 flex items-center justify-center bg-stone-950 transition-opacity duration-200 ${(!s || !s.loaded) ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-stone-800 border-t-amber-400" />
      </div>

      <TitleBar lang={lang} />

      {/* Top toolbar */}
      <header className="flex shrink-0 items-center gap-1 border-b border-stone-800/80 bg-stone-950 px-2 py-1.5">
        {/* Tools + undo/redo — horizontally scrollable if overflow */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto" style={{ scrollbarWidth: "none" }}>
          {(templateForSlot ? TOOLS.filter((td) => td.id === "select" || td.id === "bg") : TOOLS).map((toolDef) => (
            <ToolBtn
              key={toolDef.id}
              icon={toolDef.icon}
              label={t("editor.tools." + toolDef.id)}
              active={tool === toolDef.id}
              onClick={() => ed().setTool(toolDef.id)}
            />
          ))}
          <div className="mx-2 h-5 w-px shrink-0 bg-stone-800" />
          <IconBtn title={t("editor.actions.undo")} disabled={!s?.canUndo} onClick={() => ed().undo()}>
            <Icon.Undo size={16} />
          </IconBtn>
          <IconBtn title={t("editor.actions.redo")} disabled={!s?.canRedo} onClick={() => ed().redo()}>
            <Icon.Redo size={16} />
          </IconBtn>
        </div>

      </header>

      {/* Contextual options — always occupies space to prevent canvas shift */}
      <div className={`shrink-0 z-30 w-full flex items-center gap-2.5 overflow-x-auto border-b border-stone-700/40 bg-stone-950/90 px-3 py-1.5 backdrop-blur-md transition-opacity ${hasCtx ? "opacity-100" : "opacity-0"}`}
           style={{ scrollbarWidth: "none" }}>
          {!hasCtx && (
            <div className="mt-[28px]"></div>
          )}
          {hasCtx && (<>
            {showMonitorPresets && (
              <>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.monitors")}</span>
                {editorMeta.monitorRects.map((rect, i) => (
                  <Chip
                    key={i}
                    active={false}
                    onClick={() => { ed().setCropRect(rect[0], rect[1], rect[2], rect[3]); ed().applyCrop(); }}
                    onContextMenu={(e) => { e.preventDefault(); ed().setCropRect(rect[0], rect[1], rect[2], rect[3]); }}
                  >
                    {editorMeta.monitorNames?.[i] || t("editor.monitorCrop")(i + 1)}
                  </Chip>
                ))}
                {showWindowPresets && <VDivider />}
              </>
            )}
            {showWindowPresets && (
              <button
                onClick={() => setWindowOverlayOpen(p => !p)}
                className={`shrink-0 flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${windowOverlayOpen ? "border-stone-500 bg-stone-800 text-stone-200" : "border-stone-700 bg-stone-900 text-stone-300 hover:border-stone-500 hover:text-stone-100"}`}
              >
                <Icon.Crop size={12} />
                {t("editor.cropByWindow")}
                <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-60"><path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/></svg>
              </button>
            )}
            {showArrow && (
              <>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.arrowStyle")}</span>
                {ARROW_KINDS.map((id) => (
                  <Chip key={id} active={s.arrowKind === id} onClick={() => ed().setArrowKind(id)}>
                    {t("editor.arrowKinds." + id)}
                  </Chip>
                ))}
                <VDivider />
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.thickness")}</span>
                <input type="range" min="1" max="15" step="1" value={s.strokeSize ?? 2}
                  onChange={(e) => ed().setStrokeSize(Number(e.target.value))}
                  className="w-20 shrink-0 accent-accent-500"
                />
                <span className="w-5 shrink-0 text-xs tabular-nums text-stone-400">{s.strokeSize ?? 2}</span>
              </>
            )}

            {showText && (
              <>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.font")}</span>
                {/* Unified font picker — system + Google Fonts in one popup */}
                <button
                  ref={fontPickerBtnRef}
                  onClick={() => {
                    const r = fontPickerBtnRef.current.getBoundingClientRect();
                    setFontPickerAnchor(r);
                    setFontPickerOpen(o => !o);
                  }}
                  className={`flex h-7 max-w-[140px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-xs transition ${fontPickerOpen ? "border-accent-400/40 bg-accent-400/10 text-accent-300" : "border-stone-700 bg-stone-800/80 text-stone-200 hover:bg-stone-700"}`}
                  style={{ fontFamily: s.fontKind }}
                >
                  <span className="truncate">
                    {[...FONTS, ...customFonts].find(f => f.id === s.fontKind)?.label ?? "Font"}
                  </span>
                  <svg className="shrink-0 text-stone-500" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                </button>
                {fontPickerOpen && fontPickerAnchor && (
                  <FontPickerPopup
                    anchor={fontPickerAnchor}
                    value={s.fontKind}
                    customFonts={customFonts}
                    onPickSystem={id => ed().setFontKind(id)}
                    onPickGoogle={handlePickGoogleFont}
                    onRemove={handleRemoveCustomFont}
                    onClose={() => setFontPickerOpen(false)}
                  />
                )}
                {/* Bold / Italic / Underline */}
                <button
                  onClick={() => ed().setFontBold(!s.fontBold)}
                  title={t("editor.ctx.bold")}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm font-bold transition ${s.fontBold ? "bg-accent-400 text-stone-950" : "bg-stone-800/80 text-stone-300 hover:bg-stone-700 hover:text-stone-100"}`}
                >B</button>
                <button
                  onClick={() => ed().setFontItalic(!s.fontItalic)}
                  title={t("editor.ctx.italic")}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm font-medium italic transition ${s.fontItalic ? "bg-accent-400 text-stone-950" : "bg-stone-800/80 text-stone-300 hover:bg-stone-700 hover:text-stone-100"}`}
                >I</button>
                <button
                  onClick={() => ed().setFontUnderline(!s.fontUnderline)}
                  title={t("editor.ctx.underline")}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-sm font-medium underline transition ${s.fontUnderline ? "bg-accent-400 text-stone-950" : "bg-stone-800/80 text-stone-300 hover:bg-stone-700 hover:text-stone-100"}`}
                >U</button>
                <VDivider />
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.size")}</span>
                {FONT_SIZES.map((sz) => (
                  <Chip key={sz} active={s.textFontSize === sz} onClick={() => ed().setTextFontSize(sz)}>
                    {sz}
                  </Chip>
                ))}
                <VDivider />
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.box")}</span>
                {TEXT_BGS.map((id) => (
                  <Chip key={id} active={s.textBg === id} onClick={() => ed().setTextBg(id)}>
                    {t("editor.textBgs." + id)}
                  </Chip>
                ))}
                <VDivider />
                {/* Horizontal alignment */}
                {[
                  { id: "left",   icon: <Icon.AlignLeft   size={13} /> },
                  { id: "center", icon: <Icon.AlignCenter size={13} /> },
                  { id: "right",  icon: <Icon.AlignRight  size={13} /> },
                ].map((a) => (
                  <button key={a.id} title={a.id}
                    onClick={() => ed().setTextHAlign(a.id)}
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition ${s.textHAlign === a.id ? "bg-accent-400 text-stone-950" : "text-stone-400 hover:bg-stone-700 hover:text-stone-200"}`}>
                    {a.icon}
                  </button>
                ))}
                <VDivider />
                {/* Vertical alignment */}
                {[
                  { id: "top",    icon: <Icon.AlignTop     size={13} /> },
                  { id: "center", icon: <Icon.AlignMiddleV size={13} /> },
                  { id: "bottom", icon: <Icon.AlignBottom  size={13} /> },
                ].map((a) => (
                  <button key={a.id} title={a.id}
                    onClick={() => ed().setTextVAlign(a.id)}
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition ${s.textVAlign === a.id ? "bg-accent-400 text-stone-950" : "text-stone-400 hover:bg-stone-700 hover:text-stone-200"}`}>
                    {a.icon}
                  </button>
                ))}
              </>
            )}

            {showShape && (
              <>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.shape")}</span>
                {SHAPES.map((sh) => (
                  <Chip key={sh.id} title={t("editor.shapes." + sh.id)} active={s.shapeKind === sh.id} onClick={() => ed().setShapeKind(sh.id)}>
                    {sh.label}
                  </Chip>
                ))}
                <VDivider />
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.thickness")}</span>
                <input type="range" min="1" max="20" step="1" value={s.strokeSize ?? 2}
                  onChange={(e) => ed().setStrokeSize(Number(e.target.value))}
                  className="w-20 shrink-0 accent-accent-500"
                />
                <span className="w-5 shrink-0 text-xs tabular-nums text-stone-400">{s.strokeSize ?? 2}</span>
              </>
            )}

            {showBlur && (
              <>
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.mode")}</span>
                {BLURS.map((id) => (
                  <Chip key={id} active={s.blurKind === id} onClick={() => ed().setBlurKind(id)}>
                    {t("editor.blurs." + id)}
                  </Chip>
                ))}
              </>
            )}

            {showBg && (
              <>
                <Chip active={s.bg.enabled} onClick={() => {
                  const next = !s.bg.enabled;
                  ed().updateBg({ enabled: next, ...(next ? { borderRadius: 12 } : {}) });
                }}>
                  {s.bg.enabled ? t("editor.bgEnabled") : t("editor.bgDisabled")}
                </Chip>

                {s.bg.enabled && (
                  <>
                    <VDivider />
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.type")}</span>
                    {[
                      { id: "gradient",    label: t("editor.ctx.gradient")    },
                      { id: "solid",       label: t("editor.ctx.solid")       },
                      { id: "transparent", label: t("editor.ctx.transparent") },
                    ].map((bgType) => (
                      <Chip key={bgType.id} active={s.bg.type === bgType.id} onClick={() => ed().updateBg({ type: bgType.id })}>
                        {bgType.label}
                      </Chip>
                    ))}

                    {s.bg.type !== "transparent" && (
                      <>
                        <VDivider />
                        {s.bg.type === "gradient" && (() => {
                          const gradStyle = s.bg.color3
                            ? `linear-gradient(${s.bg.angle}deg, ${s.bg.color1}, ${s.bg.color3}, ${s.bg.color2})`
                            : `linear-gradient(${s.bg.angle}deg, ${s.bg.color1}, ${s.bg.color2})`;
                          return (
                            <button
                              ref={swatchBtnRef}
                              title={t("editor.gradient.title")}
                              onClick={() => {
                                const rect = swatchBtnRef.current.getBoundingClientRect();
                                setGradPopupPos({ top: rect.bottom + 8, left: rect.left });
                                setGradPopupOpen(v => !v);
                              }}
                              style={{ background: gradStyle }}
                              className={`h-6 w-10 shrink-0 rounded-md border-2 transition hover:scale-105 ${gradPopupOpen ? "border-white/70" : "border-stone-700/60 hover:border-stone-500"}`}
                            />
                          );
                        })()}
                        {s.bg.type === "solid" && (
                          <ColorCircle value={s.bg.color1} onChange={v => ed().updateBg({ color1: v })} title={t("editor.gradient.bgColor")} />
                        )}
                      </>
                    )}

                    <VDivider />
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.spacing")}</span>
                    <button
                      title={padLocked ? t("editor.ctx.unlock") : t("editor.ctx.locked")}
                      onClick={() => setPadLocked(v => !v)}
                      className={`flex h-6 w-6 shrink-0 items-center justify-center rounded transition ${padLocked ? "text-accent-400" : "text-stone-500 hover:text-stone-300"}`}
                    >
                      {padLocked ? <Icon.Lock size={13}/> : <Icon.Unlock size={13}/>}
                    </button>
                    <span className="shrink-0 text-[10px] tabular-nums text-stone-400">{s.bg.paddingTop}↑ {s.bg.paddingRight}→ {s.bg.paddingBottom}↓ {s.bg.paddingLeft}←</span>

                    <VDivider />
                    <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                      <input type="checkbox" checked={s.bg.shadowEnabled}
                        onChange={(e) => ed().updateBg({ shadowEnabled: e.target.checked })}
                        className="accent-accent-500"
                      />
                      <span className="text-xs text-stone-300">{t("editor.ctx.shadow")}</span>
                    </label>
                  </>
                )}

                <VDivider />
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{t("editor.ctx.corner")}</span>
                <input type="range" min="0" max="50" value={s.bg.borderRadius}
                  onChange={(e) => ed().updateBg({ borderRadius: Number(e.target.value) })}
                  className="w-16 shrink-0 accent-accent-500"
                />
                <span className="shrink-0 w-5 text-xs tabular-nums text-stone-400">{s.bg.borderRadius}</span>
              </>
            )}

            {/* Selection actions */}
            {canDelete && (
              <>
                <div className="ml-auto flex shrink-0 items-center gap-1 pl-2">
                  <VDivider />
                  <button
                    title={t("editor.actions.bringForward")}
                    onClick={() => ed().bringToFront()}
                    className="rounded px-2 py-0.5 text-xs text-stone-400 hover:bg-stone-700 hover:text-stone-200"
                  >{t("editor.bringForward")}</button>
                  <button
                    title={t("editor.actions.sendBack")}
                    onClick={() => ed().sendToBack()}
                    className="rounded px-2 py-0.5 text-xs text-stone-400 hover:bg-stone-700 hover:text-stone-200"
                  >{t("editor.sendBack")}</button>
                  <VDivider />
                  <button
                    title={t("editor.actions.delete")}
                    onClick={() => ed().deleteSelected()}
                    className="flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium text-red-400 hover:bg-red-500/20 hover:text-red-300"
                  >
                    <Icon.X size={12} /> {t("editor.deleteLabel")}
                  </button>
                </div>
              </>
            )}
          </>)}
        </div>

      {/* Canvas area */}
      <main
        ref={viewportRef}
        className="no-scrollbar relative flex-1 overflow-auto cursor-grab active:cursor-grabbing"
        style={{
          backgroundColor: "#0c0a09",
          backgroundImage: "radial-gradient(rgba(255,255,255,0.035) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
        onMouseDown={startPan}
      >
        <div ref={gridRef} style={{ boxSizing: "border-box" }}>
          <div className="relative leading-[0]">
            <canvas
              ref={canvasRef}
              onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
              className="cursor-crosshair shadow-2xl ring-1 ring-black/60"
            />
            {/* Text input overlay */}
            <input
              ref={textInputRef}
              type="text"
              autoComplete="off"
              spellCheck="false"
              className="absolute hidden min-w-[60px] border border-dashed border-accent-400 bg-transparent leading-tight text-inherit outline-none"
            />
            {/* Padding border lines + corner handles */}
            {s?.bg?.enabled && (() => {
              const dpr = window.devicePixelRatio || 1;
              const cf  = (s.zoom ?? 1) / dpr;
              const bg  = s.bg;
              const pt = Math.round((bg.paddingTop    ?? 60) * cf);
              const pr = Math.round((bg.paddingRight  ?? 60) * cf);
              const pb = Math.round((bg.paddingBottom ?? 60) * cf);
              const pl = Math.round((bg.paddingLeft   ?? 60) * cf);
              const H = 14, C = 20; // strip thickness, corner size
              const amber = "rgba(245,158,11,1)";
              const amberDim = "rgba(245,158,11,0.55)";

              // Edge: thin band along canvas outer border
              const sides = [
                { id: "top",    style: { top:    -H/2, left: 0, right: 0,  height: H, cursor: "ns-resize" }, isH: true  },
                { id: "bottom", style: { bottom: -H/2, left: 0, right: 0,  height: H, cursor: "ns-resize" }, isH: true  },
                { id: "left",   style: { left:   -H/2, top:  0, bottom: 0, width:  H, cursor: "ew-resize" }, isH: false },
                { id: "right",  style: { right:  -H/2, top:  0, bottom: 0, width:  H, cursor: "ew-resize" }, isH: false },
              ].map(({ id, style, isH }) => (
                <div key={id} className="absolute z-10 transition-opacity" style={{ ...style, opacity: 1 }}
                  onMouseDown={(e) => startPadDrag(id, e)}>
                  <div style={{
                    position: "absolute",
                    ...(isH
                      ? { top: "50%", left: 0, right: 0, height: "4px", transform: "translateY(-50%)" }
                      : { left: "50%", top: 0, bottom: 0, width: "4px", transform: "translateX(-50%)" }),
                    background: "rgba(0,0,0,0.35)",
                  }}/>
                  <div style={{
                    position: "absolute",
                    ...(isH
                      ? { top: "50%", left: 0, right: 0, height: "2px", transform: "translateY(-50%)" }
                      : { left: "50%", top: 0, bottom: 0, width: "2px", transform: "translateX(-50%)" }),
                    background: amberDim,
                    boxShadow: `0 0 4px 1px rgba(245,158,11,0.4)`,
                    transition: "background 0.15s",
                  }} className="group-hover:bg-amber-400"
                  onMouseEnter={e => e.currentTarget.style.background = amber}
                  onMouseLeave={e => e.currentTarget.style.background = amberDim}
                  />
                </div>
              ));

              // Corner: small square at canvas outer corners
              const corners = [
                { id: "tl", style: { top: -C/2, left:   -C/2, cursor: "nwse-resize" } },
                { id: "tr", style: { top: -C/2, right:  -C/2, cursor: "nesw-resize" } },
                { id: "br", style: { bottom: -C/2, right: -C/2, cursor: "nwse-resize" } },
                { id: "bl", style: { bottom: -C/2, left:  -C/2, cursor: "nesw-resize" } },
              ].map(({ id, style }) => (
                <div key={id} className="absolute z-20"
                  style={{ ...style, width: C, height: C }}
                  onMouseDown={(e) => startCornerDrag(id, e)}>
                  <div style={{
                    position: "absolute", inset: 0,
                    borderTop:    (id === "tl" || id === "tr") ? `3px solid ${amber}` : undefined,
                    borderBottom: (id === "bl" || id === "br") ? `3px solid ${amber}` : undefined,
                    borderLeft:   (id === "tl" || id === "bl") ? `3px solid ${amber}` : undefined,
                    borderRight:  (id === "tr" || id === "br") ? `3px solid ${amber}` : undefined,
                    boxShadow: "0 0 6px 1px rgba(245,158,11,0.5)",
                  }}/>
                </div>
              ));

              return [...sides, ...corners];
            })()}
            {/* Crop confirm / cancel */}
            <div ref={cropConfRef} className="absolute z-20 hidden gap-1.5">
              <button
                onClick={() => ed().applyCrop()}
                className="flex items-center gap-1.5 rounded-lg bg-accent-400 px-3 py-1.5 text-sm font-semibold text-stone-950 shadow-xl hover:bg-accent-300"
              >
                <Icon.Check size={14} /> {t("editor.crop.apply")}
              </button>
              <button
                onClick={() => ed().cancelCrop()}
                className="flex items-center gap-1.5 rounded-lg bg-stone-800/90 px-3 py-1.5 text-sm text-stone-200 shadow-xl backdrop-blur-sm hover:bg-stone-700"
              >
                <Icon.X size={14} /> {t("editor.crop.cancel")}
              </button>
            </div>
            {/* Monitor labels — only visible while crop tool is active */}
            {s?.zoom && s?.tool === "crop" && (editorMeta?.monitorRects?.length ?? 0) > 1 && (() => {
              const dpr = window.devicePixelRatio || 1;
              const z   = s.zoom;
              const ox  = s?.bg?.enabled ? (s.bg.paddingLeft ?? 0) : 0;
              const oy  = s?.bg?.enabled ? (s.bg.paddingTop  ?? 0) : 0;
              return editorMeta.monitorRects.map(([rx, ry, rw, rh], i) => (
                <div
                  key={i}
                  style={{
                    position:      "absolute",
                    left:          (rx + ox + rw / 2) * z / dpr,
                    top:           (ry + oy + rh) * z / dpr - 22,
                    transform:     "translateX(-50%)",
                    zIndex:        20,
                    pointerEvents: "none",
                  }}
                  className="rounded-full bg-black/60 px-2 py-px text-[9px] font-medium text-white/70 backdrop-blur-sm ring-1 ring-white/10 whitespace-nowrap"
                >
                  {editorMeta.monitorNames?.[i] || t("editor.monitorCrop")(i + 1)}
                </div>
              ));
            })()}
          </div>
        </div>
      </main>

      {/* Bottom bar */}
      <footer className={`@container relative flex shrink-0 items-center overflow-x-auto border-t border-stone-800/80 bg-stone-950 py-2 transition-[gap,padding] ${footerCompact ? "gap-1.5 px-1.5" : "gap-3 px-3"}`}>

        {/* Color + Thickness */}
        {showColor && (
          <div className={`flex shrink-0 items-center @max-[1319px]:gap-1.5 ${footerCompact ? "gap-1" : "gap-2.5"}`}>
            {/* Color palette */}
            <div className="flex items-center gap-1 @max-[1319px]:gap-0.5">
              {DRAW_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => ed().setColor(c)}
                  title={c}
                  style={{ background: c }}
                  className={`h-5 w-5 rounded-full border-2 transition hover:scale-110 @max-[1319px]:h-4 @max-[1319px]:w-4 ${
                    s?.color === c
                      ? "border-white shadow-sm shadow-white/20"
                      : "border-transparent opacity-75 hover:opacity-100"
                  }`}
                />
              ))}
            </div>

            {showPaint && !showArrow && !showShape && (
              <>
                <VDivider />
                {/* Thickness (arrow/shape tools have their own slider) */}
                <div className="flex items-center gap-0.5">
                  {[0, 1, 2, 3, 4, 5].map((i) => {
                    const dotPx = [3, 5, 7, 10, 13, 17][i];
                    const sizeKeys = ["extraThin", "thin", "medium", "thick", "extraThick", "huge"];
                    return (
                      <button
                        key={i}
                        onClick={() => ed().setSizeIdx(i)}
                        title={t("editor.sizes." + sizeKeys[i])}
                        className={`flex h-7 w-7 items-center justify-center rounded-md transition @max-[1319px]:h-6 @max-[1319px]:w-6 ${
                          s?.sizeIdx === i ? "bg-accent-400" : "hover:bg-stone-800"
                        }`}
                      >
                        <span
                          className={`rounded-full ${s?.sizeIdx === i ? "bg-stone-950" : "bg-stone-400"}`}
                          style={{ width: dotPx, height: dotPx }}
                        />
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}

        <div ref={footerRightRef} className={`flex min-w-0 flex-1 items-center justify-end overflow-x-hidden ${footerCompact ? "gap-1.5" : "gap-3"}`}>
          {renderFooterRight({ compact: footerCompact })}
        </div>
        <div
          ref={footerRightMeasureRef}
          aria-hidden="true"
          className="pointer-events-none flex items-center gap-3 opacity-0"
          style={{ position: "fixed", top: -9999, left: -9999 }}
        >
          {renderFooterRight({ compact: false, measure: true })}
        </div>

        {/* Toast notification */}
        {toast && (
          <div className="pointer-events-none absolute -top-11 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-lg bg-stone-800 px-4 py-2 text-sm text-stone-100 shadow-2xl ring-1 ring-stone-700/50">
            {toast}
          </div>
        )}
      </footer>

      {/* Context menu */}
      {ctxMenu && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{ position: "fixed", left: ctxMenu.x, top: ctxMenu.y, zIndex: 9999 }}
          className="min-w-[160px] overflow-hidden rounded-xl border border-stone-700/60 bg-stone-900 py-1 shadow-2xl ring-1 ring-black/40"
        >
          {canDelete && (
            <>
              <button
                onClick={() => { ed().bringToFront(); setCtxMenu(null); }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-xs text-stone-300 hover:bg-stone-800 hover:text-stone-100"
              >{t("editor.context.bringForward")}</button>
              <button
                onClick={() => { ed().sendToBack(); setCtxMenu(null); }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-xs text-stone-300 hover:bg-stone-800 hover:text-stone-100"
              >{t("editor.context.sendBack")}</button>
              <div className="my-1 border-t border-stone-700/60" />
              <button
                onClick={() => { ed().deleteSelected(); setCtxMenu(null); }}
                className="flex w-full items-center gap-2.5 px-3.5 py-2 text-xs font-medium text-red-400 hover:bg-red-500/20 hover:text-red-300"
              >{t("editor.context.delete")}</button>
              <div className="my-1 border-t border-stone-700/60" />
            </>
          )}
          <button
            onClick={() => { ed().undo(); setCtxMenu(null); }}
            disabled={!s?.canUndo}
            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-xs text-stone-300 hover:bg-stone-800 hover:text-stone-100 disabled:opacity-40"
          >{t("editor.context.undo")}</button>
          <button
            onClick={() => { ed().redo(); setCtxMenu(null); }}
            disabled={!s?.canRedo}
            className="flex w-full items-center gap-2.5 px-3.5 py-2 text-xs text-stone-300 hover:bg-stone-800 hover:text-stone-100 disabled:opacity-40"
          >{t("editor.context.redo")}</button>
        </div>
      )}

      {/* Gradient popup — portal to escape overflow-x-auto + backdrop-blur clipping */}
      {gradPopupOpen && s?.bg?.type === "gradient" && s?.bg?.enabled && createPortal(
        <div
          ref={gradPopupRef}
          style={{ position: "fixed", top: gradPopupPos.top, left: gradPopupPos.left, zIndex: 9999 }}
          className="w-72 rounded-xl border border-stone-700/60 bg-stone-950 p-3 shadow-2xl ring-1 ring-black/50"
        >
          {/* Preset grid */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {[...customPresets, ...BG_PRESETS].map((p, i) => {
              const isCustom = i < customPresets.length;
              const ang = p.angle ?? 135;
              const grad = p.color3
                ? `linear-gradient(${ang}deg, ${p.color1}, ${p.color3}, ${p.color2})`
                : `linear-gradient(${ang}deg, ${p.color1}, ${p.color2})`;
              const active = s.bg.color1 === p.color1 && s.bg.color2 === p.color2 && (s.bg.color3 ?? null) === (p.color3 ?? null);
              return (
                <div key={i} className="group relative">
                  <button
                    title={isCustom ? t("editor.gradient.customPreset") : undefined}
                    onClick={() => ed().updateBg({ color1: p.color1, color2: p.color2, color3: p.color3 ?? null, ...(isCustom ? { angle: ang } : {}) })}
                    style={{ background: grad }}
                    className={`h-7 w-7 rounded-lg border-2 transition hover:scale-110 ${active ? "border-white shadow-sm shadow-white/20" : isCustom ? "border-accent-400/50" : "border-transparent opacity-75 hover:opacity-100"}`}
                  />
                  {isCustom && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setCustomPresets(prev => prev.filter((_, j) => j !== i)); }}
                      title={t("editor.gradient.remove")}
                      className="absolute -top-1 -right-1 hidden group-hover:flex items-center justify-center w-3.5 h-3.5 rounded-full bg-red-500 text-white font-bold"
                      style={{ fontSize: 9, lineHeight: 1 }}
                    >×</button>
                  )}
                </div>
              );
            })}
            <button
              title={t("editor.gradient.saveAsPreset")}
              onClick={() => {
                const curr = { color1: s.bg.color1, color2: s.bg.color2, color3: s.bg.color3 ?? null, angle: s.bg.angle };
                setCustomPresets(prev => [curr, ...prev.filter(p => !(p.color1 === curr.color1 && p.color2 === curr.color2 && (p.color3 ?? null) === curr.color3))]);
              }}
              className="h-7 w-7 rounded-lg border-2 border-dashed border-stone-700 flex items-center justify-center text-stone-500 hover:border-accent-400 hover:text-accent-400 transition font-bold text-sm"
            >+</button>
          </div>
          <div className="border-t border-stone-800 mb-3" />
          {/* Colors + angle */}
          <div className="flex items-center gap-2">
            <ColorCircle value={s.bg.color1} onChange={v => ed().updateBg({ color1: v })} title={t("editor.gradient.startColor")} />
            {s.bg.color3 != null && (
              <ColorCircle value={s.bg.color3} onChange={v => ed().updateBg({ color3: v })} title={t("editor.gradient.midColor")} />
            )}
            <ColorCircle value={s.bg.color2} onChange={v => ed().updateBg({ color2: v })} title={t("editor.gradient.endColor")} />
            <button
              title={s.bg.color3 != null ? t("editor.gradient.removeMid") : t("editor.gradient.addMid")}
              onClick={() => ed().updateBg({ color3: s.bg.color3 != null ? null : s.bg.color1 })}
              className="h-5 w-5 flex items-center justify-center rounded-full border border-stone-600 text-stone-500 hover:border-stone-400 hover:text-stone-300 transition font-bold text-xs"
            >{s.bg.color3 != null ? "−" : "+"}</button>
            <div className="flex-1" />
            <input type="range" min="0" max="360" value={s.bg.angle}
              onChange={(e) => ed().updateBg({ angle: Number(e.target.value) })}
              className="w-20 accent-accent-500"
            />
            <span className="w-7 shrink-0 text-right text-xs tabular-nums text-stone-400">{s.bg.angle}°</span>
          </div>
        </div>,
        document.body
      )}

      {/* Window crop overlay — dims screenshot, window areas are transparent hit targets */}
      {/* Monitor labels — bottom-center of each monitor region, all tools */}

      {windowOverlayOpen && showWindowPresets && createPortal(
        <div className="fixed inset-0 z-50" onClick={() => setWindowOverlayOpen(false)}>
          {/* SVG mask: dark everywhere, transparent holes over each window rect */}
          <svg className="pointer-events-none absolute inset-0 h-full w-full">
            <defs>
              <mask id="win-crop-mask">
                <rect width="100%" height="100%" fill="white"/>
                {windowRects.map((r, i) => (
                  <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} fill="black" rx="2"/>
                ))}
              </mask>
            </defs>
            <rect width="100%" height="100%" fill="rgba(0,0,0,0.7)" mask="url(#win-crop-mask)"/>
          </svg>

          {/* Clickable window areas */}
          {editorMeta?.windowCrops?.map((wc, i) => {
            const r = windowRects[i];
            if (!r) return null;
            return (
              <div
                key={i}
                onClick={(e) => { e.stopPropagation(); ed().setCropRect(wc.x, wc.y, wc.w, wc.h); ed().applyCrop(); setWindowOverlayOpen(false); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); ed().setCropRect(wc.x, wc.y, wc.w, wc.h); setWindowOverlayOpen(false); }}
                style={{ position: "fixed", left: r.x, top: r.y, width: r.w, height: r.h }}
                className="group cursor-pointer ring-2 ring-inset ring-transparent transition-all duration-100 hover:ring-white/70"
              >
                {/* Label badge — slides up on hover */}
                <div className="pointer-events-none absolute bottom-2.5 left-2.5 flex max-w-[85%] translate-y-1 items-center gap-2 rounded-lg bg-black/75 px-2.5 py-1.5 opacity-0 backdrop-blur-sm transition-all duration-100 group-hover:translate-y-0 group-hover:opacity-100">
                  {wc.icon_b64
                    ? <img src={`data:image/png;base64,${wc.icon_b64}`} className="h-5 w-5 shrink-0 object-contain" />
                    : <div className="h-5 w-5 shrink-0 rounded-sm bg-stone-600"/>
                  }
                  <span className="truncate text-sm font-medium text-white">{wc.label}</span>
                </div>
              </div>
            );
          })}

          {/* Dismiss hint */}
          <div className="pointer-events-none absolute top-20 left-1/2 -translate-x-1/2 rounded-full bg-black/60 px-4 py-1.5 text-xs text-stone-300 backdrop-blur-sm">
            {t("editor.cropByWindowHint")}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
