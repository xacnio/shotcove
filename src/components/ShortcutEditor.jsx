import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  MdEdit, MdSave, MdContentCopy, MdLink, MdCloud,
  MdTune, MdDeleteOutline,
} from "react-icons/md";
import {
  Crop, Maximize, Window, Camera, Monitor, Folder, Link, Cloud, Pencil, Tag,
  Gear, Refresh, Upload, External, Search, Copy, Check, Calendar, HardDrive, LayoutGrid,
} from "../gallery/icons.jsx";
import { invoke } from "../lib/tauri.js";
import { Toggle, HotkeyInput, Row, inputCls } from "./settingsUI.jsx";

export const CAPTURE_TYPES = ["area", "window", "fullscreen"];
export const ACTION_LIST   = ["open_editor", "save", "copy_image", "direct_link", "drive_link"];

// Same icons as the gallery sidebar's quick-capture buttons, so a capture
// type reads the same way everywhere in the app.
const CAPTURE_ICON = { area: Crop, window: Window, fullscreen: Maximize };
export const ACTION_ICON = { open_editor: MdEdit, save: MdSave, copy_image: MdContentCopy, direct_link: MdLink, drive_link: MdCloud };

// Icon a shortcut can be tagged with, shown both here and as its button in
// the gallery sidebar's Capture section. Keyed by string so it round-trips
// through the Rust config as plain JSON.
export const SHORTCUT_ICON_OPTIONS = [
  "crop", "window", "maximize", "camera", "monitor", "folder", "link", "cloud", "pencil", "tag",
  "gear", "refresh", "upload", "external", "search", "copy", "check", "calendar", "harddrive", "layoutgrid",
];
export const SHORTCUT_ICON = {
  crop: Crop, window: Window, maximize: Maximize, camera: Camera, monitor: Monitor, folder: Folder, link: Link, cloud: Cloud, pencil: Pencil, tag: Tag,
  gear: Gear, refresh: Refresh, upload: Upload, external: External, search: Search, copy: Copy, check: Check, calendar: Calendar, harddrive: HardDrive, layoutgrid: LayoutGrid,
};
// Sensible default per capture type, used when a shortcut hasn't been given its own icon.
export const CAPTURE_TYPE_ICON = { area: "crop", window: "window", fullscreen: "maximize" };

export function actionKey(action) {
  return action.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

export function captureKey(capture) {
  return "capture" + capture.split("_").map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

// Mirrors the Rust side's `slot_default_label` format ("Type — Action + Action"),
// shown as the menu-label placeholder so "Auto" isn't a mystery.
function autoLabel(slot, t) {
  const capture = t(`settings.shortcuts.${captureKey(slot.capture)}`);
  const actions = slot.actions.map((a) => t(`settings.shortcuts.action${actionKey(a)}`)).join(" + ");
  return actions ? `${capture} — ${actions}` : capture;
}

// What to actually display for a shortcut (e.g. as a button tooltip) —
// the custom label if set, the auto one otherwise.
export function shortcutLabel(slot, t) {
  return slot.label || autoLabel(slot, t);
}

// Small preview mimicking the real composite: outer swatch is the
// background fill, inner box (with its own radius/shadow) stands in for
// the screenshot, inset proportionally to the configured padding.
export function BgTemplatePreview({ tpl }) {
  const insetPct = Math.min(38, Math.max(6, tpl.padding / 2.2));
  return (
    <div
      className="relative h-12 w-20 shrink-0 overflow-hidden rounded border border-stone-700"
      style={{
        background: tpl.bg_type === "solid"
          ? tpl.color1
          : `linear-gradient(${tpl.angle}deg, ${tpl.color1}, ${tpl.color2})`,
      }}
    >
      <div
        className="absolute bg-stone-200"
        style={{
          top: `${insetPct}%`, left: `${insetPct}%`, right: `${insetPct}%`, bottom: `${insetPct}%`,
          borderRadius: `${Math.min(8, tpl.border_radius / 3)}px`,
          boxShadow: tpl.shadow ? "0 3px 6px rgba(0,0,0,0.5)" : "none",
        }}
      />
    </div>
  );
}

export function IconToggle({ active, disabled, title, onClick, children }) {
  return (
    <button type="button" title={title} disabled={disabled} onClick={onClick}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition ${
        active
          ? "border-accent-500/60 bg-accent-500/20 text-accent-400"
          : disabled
            ? "border-stone-800 bg-stone-800/30 text-stone-700 cursor-not-allowed"
            : "border-stone-700 bg-stone-800 text-stone-400 hover:border-stone-500 hover:text-stone-200"
      }`}
    >
      {children}
    </button>
  );
}

export const DEFAULT_BG_TEMPLATE = {
  bg_type: "gradient",
  color1: "#14141e",
  color2: "#282840",
  angle: 135,
  padding: 60,
  border_radius: 0,
  shadow: true,
};

export function ShortcutCard({ slot, onChange, onRemove, t }) {
  const hasAction  = (a) => slot.actions.includes(a);
  const openEditor = hasAction("open_editor");
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState(null);
  const menuBtnRef = useRef(null);
  const popoverRef = useRef(null);
  const MENU_WIDTH = 288; // w-72

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      if (menuBtnRef.current?.contains(e.target)) return;
      if (popoverRef.current?.contains(e.target)) return;
      setMenuOpen(false);
    };
    // Closing on scroll too: the popover is fixed-positioned (portaled to
    // <body>, to escape the shortcuts list's own overflow clipping), so it
    // wouldn't otherwise follow the button if the list scrolls under it.
    const closeOnScroll = () => setMenuOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [menuOpen]);

  const handleToggleMenu = () => {
    if (!menuOpen) {
      const rect = menuBtnRef.current.getBoundingClientRect();
      const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
      // Generous estimate (fully expanded: tray label + bg preview row) —
      // prefer below, flip above if that doesn't fit, then clamp either
      // way so it's never pushed past the window's actual edges (the
      // window itself can't scroll, unlike a browser viewport).
      const estHeight = 400;
      let top = rect.bottom + 6;
      if (top + estHeight > window.innerHeight - 8) {
        top = rect.top - estHeight - 6;
      }
      top = Math.max(8, Math.min(top, window.innerHeight - estHeight - 8));
      setMenuPos({ left, top });
    }
    setMenuOpen((v) => !v);
  };

  const toggleAction = (action) => {
    if (action === "open_editor") {
      onChange({ ...slot, actions: openEditor ? [] : ["open_editor"] });
      return;
    }
    // Open Editor and the direct actions are mutually exclusive — turning
    // on a direct action just switches Open Editor off, instead of blocking
    // the click until the user disables it themselves.
    const withoutEditor = slot.actions.filter((a) => a !== "open_editor");
    const next = withoutEditor.includes(action)
      ? withoutEditor.filter((a) => a !== action)
      : [...withoutEditor, action];
    onChange({ ...slot, actions: next });
  };

  return (
    <div className="rounded-xl border border-stone-700 bg-stone-900/60 p-2.5 flex items-center gap-2">
      {/* Capture type — icon-only segmented control */}
      <div className="flex shrink-0 gap-0.5 rounded-lg bg-stone-950/60 p-0.5">
        {CAPTURE_TYPES.map((c) => {
          const Icon = CAPTURE_ICON[c];
          return (
            <button key={c} type="button" title={t(`settings.shortcuts.${captureKey(c)}`)}
              onClick={() => onChange({ ...slot, capture: c })}
              className={`flex h-7 w-7 items-center justify-center rounded-md transition ${
                slot.capture === c
                  ? "bg-accent-500 text-stone-950"
                  : "text-stone-500 hover:bg-stone-800 hover:text-stone-300"
              }`}
            >
              <Icon size={15} />
            </button>
          );
        })}
      </div>

      <HotkeyInput
        value={slot.combo}
        onChange={(v) => onChange({ ...slot, combo: v })}
        placeholder={t("settings.shortcuts.hint")}
        className="w-28 shrink-0"
      />

      {/* Actions this shortcut performs */}
      <div className="flex flex-1 flex-wrap items-center justify-center gap-1">
        {ACTION_LIST.map((action) => {
          const Icon   = ACTION_ICON[action];
          const active = hasAction(action);
          return (
            <IconToggle key={action} active={active}
              title={t(`settings.shortcuts.action${actionKey(action)}`)}
              onClick={() => toggleAction(action)}
            >
              <Icon size={15} />
            </IconToggle>
          );
        })}
      </div>

      {/* Advanced settings, tucked behind a single menu */}
      <div className="shrink-0">
        <button ref={menuBtnRef} type="button" title={t("settings.shortcuts.moreOptions")} onClick={handleToggleMenu}
          className={`flex h-7 w-7 items-center justify-center rounded-lg border transition ${
            menuOpen ? "border-stone-500 bg-stone-800 text-stone-200" : "border-stone-700 bg-stone-800 text-stone-400 hover:border-stone-500 hover:text-stone-200"
          }`}
        >
          <MdTune size={15} />
        </button>
        {menuOpen && menuPos && createPortal(
          <div ref={popoverRef}
            style={{ position: "fixed", left: menuPos.left, top: menuPos.top, width: MENU_WIDTH, maxHeight: "calc(100vh - 16px)", overflowY: "auto" }}
            className="z-50 rounded-xl border border-stone-700 bg-stone-900 p-1 shadow-2xl">
            <div className="divide-y divide-stone-800/70 px-2">
              <div className="py-2.5">
                <div className="mb-1.5 text-sm text-stone-200">{t("settings.shortcuts.icon")}</div>
                <div className="flex flex-wrap gap-1">
                  {SHORTCUT_ICON_OPTIONS.map((key) => {
                    const Ico = SHORTCUT_ICON[key];
                    const active = (slot.icon || CAPTURE_TYPE_ICON[slot.capture]) === key;
                    return (
                      <button key={key} type="button" onClick={() => onChange({ ...slot, icon: key })}
                        className={`flex h-7 w-7 items-center justify-center rounded-lg border transition ${
                          active
                            ? "border-accent-500/60 bg-accent-500/20 text-accent-400"
                            : "border-stone-700 bg-stone-800 text-stone-400 hover:border-stone-500 hover:text-stone-200"
                        }`}
                      >
                        <Ico size={14} />
                      </button>
                    );
                  })}
                </div>
              </div>
              <Row label={t("settings.shortcuts.multiMonitor")}>
                <Toggle checked={slot.multi_monitor ?? true} onChange={(v) => onChange({ ...slot, multi_monitor: v })} />
              </Row>
              <Row label={t("settings.shortcuts.showInMenu")}>
                <Toggle checked={slot.show_in_menu} onChange={(v) => onChange({ ...slot, show_in_menu: v })} />
              </Row>
              {slot.show_in_menu && (
                <div className="py-2.5">
                  <input type="text" value={slot.label}
                    placeholder={autoLabel(slot, t)}
                    onChange={(e) => onChange({ ...slot, label: e.target.value })}
                    className={`${inputCls} w-full text-sm`}
                  />
                </div>
              )}
              <Row label={t("settings.shortcuts.customBg")} hint={t("settings.shortcuts.customBgHint")}>
                <Toggle
                  checked={!!slot.bg_template}
                  onChange={(on) => onChange({ ...slot, bg_template: on ? DEFAULT_BG_TEMPLATE : null })}
                />
              </Row>
              {slot.bg_template && (
                <div className="flex items-center gap-2 py-2.5">
                  <BgTemplatePreview tpl={slot.bg_template} />
                  <button type="button"
                    onClick={() => invoke("start_bg_template_capture", { slotId: slot.id }).catch(() => {})}
                    className="ml-auto rounded-lg border border-stone-700 bg-stone-800 px-3 py-1.5 text-xs font-medium text-stone-300 transition hover:border-stone-500 hover:text-stone-100"
                  >
                    {t("settings.shortcuts.editInEditor")}
                  </button>
                </div>
              )}
            </div>
            <button type="button" onClick={onRemove}
              className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-red-400/80 transition hover:bg-red-400/10 hover:text-red-400"
            >
              <MdDeleteOutline size={14} /> {t("settings.shortcuts.remove")}
            </button>
          </div>,
          document.body
        )}
      </div>
    </div>
  );
}

// PrintScreen gets the same action/multi-monitor/background-template knobs
// as a regular shortcut, but lives in its own card — it's a fixed OS key,
// not a rebindable combo, so the capture-type selector, hotkey input and
// icon picker (shown only in the gallery's Capture section) don't apply.
export function PrintscreenCard({ settings, onChange, t }) {
  const actions = settings.printscreen_actions ?? ["open_editor"];
  const enabled = settings.printscreen_enabled ?? true;
  const hasAction = (a) => actions.includes(a);
  const openEditor = hasAction("open_editor");

  const toggleAction = (action) => {
    if (action === "open_editor") {
      onChange({ printscreen_actions: openEditor ? [] : ["open_editor"] });
      return;
    }
    const withoutEditor = actions.filter((a) => a !== "open_editor");
    const next = withoutEditor.includes(action)
      ? withoutEditor.filter((a) => a !== action)
      : [...withoutEditor, action];
    onChange({ printscreen_actions: next });
  };

  return (
    <div className="rounded-xl border border-stone-700 bg-stone-900/60 overflow-hidden">
      <div className="px-3">
        <Row label={t("settings.shortcuts.printscreen")} hint={t("settings.shortcuts.printscreenHint")}>
          <Toggle checked={enabled} onChange={(v) => onChange({ printscreen_enabled: v })} />
        </Row>
      </div>
      {enabled && (
        <div className="divide-y divide-stone-800/70 border-t border-stone-800 px-3">
          <div className="py-2.5">
            <div className="mb-1.5 text-sm text-stone-200">{t("settings.shortcuts.actionsLabel")}</div>
            <div className="flex flex-wrap gap-1">
              {ACTION_LIST.map((action) => {
                const Icon   = ACTION_ICON[action];
                const active = hasAction(action);
                return (
                  <IconToggle key={action} active={active}
                    title={t(`settings.shortcuts.action${actionKey(action)}`)}
                    onClick={() => toggleAction(action)}
                  >
                    <Icon size={15} />
                  </IconToggle>
                );
              })}
            </div>
          </div>
          <Row label={t("settings.shortcuts.multiMonitor")}>
            <Toggle checked={settings.printscreen_multi_monitor ?? true} onChange={(v) => onChange({ printscreen_multi_monitor: v })} />
          </Row>
          <Row label={t("settings.shortcuts.customBg")} hint={t("settings.shortcuts.customBgHint")}>
            <Toggle
              checked={!!settings.printscreen_bg_template}
              onChange={(on) => onChange({ printscreen_bg_template: on ? DEFAULT_BG_TEMPLATE : null })}
            />
          </Row>
          {settings.printscreen_bg_template && (
            <div className="flex items-center gap-2 py-2.5">
              <BgTemplatePreview tpl={settings.printscreen_bg_template} />
              <button type="button"
                onClick={() => invoke("start_bg_template_capture", { slotId: "printscreen" }).catch(() => {})}
                className="ml-auto rounded-lg border border-stone-700 bg-stone-800 px-3 py-1.5 text-xs font-medium text-stone-300 transition hover:border-stone-500 hover:text-stone-100"
              >
                {t("settings.shortcuts.editInEditor")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
