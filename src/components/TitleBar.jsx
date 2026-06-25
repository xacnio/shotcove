import { useEffect, useState } from "react";
import { useT } from "../lib/i18n.js";
import logo from "../assets/logo.png";

const isLinux = typeof navigator !== "undefined" && navigator.userAgent.toLowerCase().includes("linux");
const isMac   = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");

function MacTrafficLights({ onClose, onMinimize, onMaximize, noMinimize, noMaximize, t }) {
  const Dot = ({ color, onClick, title, glyph }) => (
    <button
      title={title}
      onClick={onClick}
      className="group flex h-3 w-3 items-center justify-center rounded-full"
      style={{ backgroundColor: color }}
    >
      <span className="text-[8px] leading-none text-black/60 opacity-0 group-hover:opacity-100">{glyph}</span>
    </button>
  );
  return (
    <div className="flex items-center gap-2 px-3.5" data-tauri-drag-region={false}>
      <Dot color="#ff5f57" onClick={onClose} title={t("common.close")} glyph="×" />
      <Dot
        color={noMinimize ? "#4b4b4b" : "#febc2e"}
        onClick={noMinimize ? undefined : onMinimize}
        title={t("common.minimize")}
        glyph="−"
      />
      <Dot
        color={noMaximize ? "#4b4b4b" : "#28c840"}
        onClick={noMaximize ? undefined : onMaximize}
        title={t("common.maximize")}
        glyph="+"
      />
    </div>
  );
}

function WinBtn({ onClick, title, danger, children }) {
  if (isLinux) {
    return (
      <button
        title={title}
        onClick={onClick}
        className={[
          "flex h-7 w-7 items-center justify-center rounded-full transition-all duration-150",
          "text-stone-400",
          danger
            ? "hover:bg-red-500 hover:text-white active:bg-red-600"
            : "hover:bg-white/[0.08] hover:text-stone-200 active:bg-white/[0.12]",
        ].join(" ")}
      >
        {children}
      </button>
    );
  }

  return (
    <button
      title={title}
      onClick={onClick}
      className={[
        "flex h-full w-[46px] items-center justify-center",
        "text-stone-500 transition-colors",
        danger
          ? "hover:bg-red-500 hover:text-white"
          : "hover:bg-white/8 hover:text-stone-200",
      ].join(" ")}
    >
      {children}
    </button>
  );
}

const MinimizeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

const MaximizeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <rect x="1.5" y="1.5" width="9" height="9" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

const RestoreIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <rect x="3.5" y="1.5" width="7" height="7" stroke="currentColor" strokeWidth="1.2" />
    <path d="M1.5 4.5v6h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CloseIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
    <line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);

export default function TitleBar({ title = "Shotcove", noMaximize = false, noMinimize = false, className = "", lang = "en" }) {
  const [max, setMax] = useState(false);
  const t = useT(lang);

  useEffect(() => {
    if (isMac) document.documentElement.classList.add("platform-mac");
  }, []);

  useEffect(() => {
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    if (!win) return;

    win.isMaximized().then(setMax);

    const onResize = () => win.isMaximized().then(setMax);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const win = () => window.__TAURI__?.window?.getCurrentWindow?.();

  const minimize = () => win()?.minimize();
  const toggleMax = () =>
    win()?.toggleMaximize().then(() => win()?.isMaximized().then(setMax));
  const close = () => win()?.close();

  return (
    <div
      className={`relative z-[10050] flex h-8 shrink-0 select-none items-center border-b border-white/[0.06] bg-stone-950 ${className}`}
      data-tauri-drag-region
      onDoubleClick={noMaximize ? undefined : toggleMax}
    >
      {isMac && (
        <MacTrafficLights
          onClose={close}
          onMinimize={minimize}
          onMaximize={toggleMax}
          noMinimize={noMinimize}
          noMaximize={noMaximize}
          t={t}
        />
      )}

      {/* Logo — pointer-events none so drag region stays active here */}
      <div
        className="flex items-center gap-2 px-3.5"
        style={{ pointerEvents: "none" }}
      >
        <img src={logo} alt="" className="h-4 w-4" />
        <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-stone-500">
          {title}
        </span>
      </div>

      {/* Drag area */}
      <div className="flex-1" data-tauri-drag-region onDoubleClick={noMaximize ? undefined : toggleMax} />

      {/* Window controls */}
      {!isMac && (
        <div className={isLinux ? "flex items-center gap-1.5 px-3 h-full" : "flex h-full"}>
          {!noMinimize && (
            <WinBtn onClick={minimize} title={t("common.minimize")}>
              <MinimizeIcon />
            </WinBtn>
          )}
          {!noMaximize && (
            <WinBtn onClick={toggleMax} title={max ? t("common.restore") : t("common.maximize")}>
              {max ? <RestoreIcon /> : <MaximizeIcon />}
            </WinBtn>
          )}
          <WinBtn onClick={close} title={t("common.close")} danger>
            <CloseIcon />
          </WinBtn>
        </div>
      )}
    </div>
  );
}
