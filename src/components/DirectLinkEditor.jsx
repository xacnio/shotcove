import { useState, useRef, useEffect } from "react";
import { invoke } from "../lib/tauri.js";
import { Toggle, Button, Card, inputCls } from "./settingsUI.jsx";

const PROVIDER_META = {
  prntscr:   { name: "prnt.sc (LightShot)", formats: "PNG, JPG",            needsKey: false, tos: "https://app.prntscr.com/en/terms-of-service.html", privacy: "https://app.prntscr.com/en/privacy.html" },
  imgbb:     { name: "ImgBB",               formats: "PNG, JPG, WebP, GIF", needsKey: "imgbb_api_key",     keyHint: "api.imgbb.com", tos: "https://imgbb.com/tos", privacy: "https://imgbb.com/privacy" },
  freeimage: { name: "Freeimage.host",      formats: "PNG, JPG, WebP",      needsKey: "freeimage_api_key", keyHint: "freeimage.host/page/api", tos: "https://freeimage.host/tos", privacy: "https://freeimage.host/privacy" },
  catbox:    { name: "Catbox.moe",          formats: null,                  needsKey: false, optionalKey: "catbox_userhash", keyLabel: null, tos: "https://catbox.moe/legal.php", privacy: "https://catbox.moe/legal.php" },
};

const BODY_TYPES = ["multipart", "form_data", "json", "binary"];
const METHODS    = ["post", "put", "patch", "get"];

function TestResponseModal({ result, onClose }) {
  if (!result) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="bg-stone-900 border border-stone-700 rounded-xl shadow-2xl w-[560px] max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-stone-800">
          <span className="text-sm font-medium text-stone-200">
            Test Response
            <span className={`ml-2 text-xs px-1.5 py-0.5 rounded font-mono ${result.status < 300 ? "bg-green-500/20 text-green-400" : "bg-red-500/20 text-red-400"}`}>
              HTTP {result.status}
            </span>
          </span>
          <button onClick={onClose} className="text-stone-500 hover:text-stone-300 text-lg leading-none">✕</button>
        </div>
        <div className="overflow-y-auto flex-1 p-4 flex flex-col gap-3">
          <div>
            <div className="text-xs text-stone-500 mb-1 uppercase tracking-wide">Body</div>
            <pre className="text-xs text-stone-300 bg-stone-950 rounded p-3 overflow-x-auto whitespace-pre-wrap break-all font-mono">{result.body || "(empty)"}</pre>
          </div>
          <div>
            <div className="text-xs text-stone-500 mb-1 uppercase tracking-wide">Headers</div>
            <pre className="text-xs text-stone-500 bg-stone-950 rounded p-3 overflow-x-auto whitespace-pre-wrap font-mono">{result.headers || "(none)"}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

function CustomProviderRow({ provider, onChange, onRemove, dragHandle, isOver, isDragging, t }) {
  const [expanded, setExpanded] = useState(!provider.url);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const set = (patch) => onChange({ ...provider, ...patch });

  const runTest = async () => {
    if (!provider.url.trim()) return;
    setTesting(true);
    try {
      const result = await invoke("test_custom_provider", { provider });
      setTestResult(result);
    } catch (e) {
      setTestResult({ status: 0, headers: "", body: String(e) });
    } finally {
      setTesting(false);
    }
  };

  const urlShort = provider.url.length > 40
    ? provider.url.slice(0, 40) + "…"
    : provider.url;

  return (
    <>
    <TestResponseModal result={testResult} onClose={() => setTestResult(null)} />
    <div
      className={`rounded-lg border transition-colors select-none ${isOver ? "border-accent-500 bg-stone-800/60" : "border-stone-700 bg-stone-900/60"} ${isDragging ? "opacity-40" : ""}`}
    >
      {/* Collapsed row */}
      <div className="flex items-center gap-2 px-3 py-2.5">
        <span {...dragHandle} className="cursor-grab active:cursor-grabbing text-stone-600 hover:text-stone-400 shrink-0 text-lg leading-none touch-none">⠿</span>
        <Toggle checked={provider.enabled} onChange={(v) => set({ enabled: v })} />
        <div className="flex-1 min-w-0">
          <div className={`text-sm truncate ${provider.enabled ? "text-stone-100" : "text-stone-500"}`}>
            {provider.name || <span className="text-stone-600 italic">{t("settings.link.custom.namePlaceholder")}</span>}
          </div>
          {provider.url && (
            <div className="text-xs text-stone-600 font-mono truncate">
              {provider.method.toUpperCase()} {urlShort}
            </div>
          )}
        </div>
        <button type="button" onClick={() => setExpanded((v) => !v)}
          className="text-xs text-stone-400 hover:text-stone-200 transition px-2 py-1 rounded hover:bg-stone-800 shrink-0">
          {expanded ? t("settings.link.custom.collapse") : t("settings.link.custom.edit")}
        </button>
        <button type="button" onClick={onRemove}
          className="text-stone-600 hover:text-red-400 transition text-xs px-1.5 py-1 rounded hover:bg-red-400/10 shrink-0">
          ✕
        </button>
      </div>

      {/* Expanded fields */}
      {expanded && (
        <div className="border-t border-stone-700/60 px-3 pb-3 pt-2.5 flex flex-col gap-2.5">
          {/* Name */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-500 shrink-0 w-20">{t("settings.link.custom.name")}</span>
            <input type="text" value={provider.name}
              placeholder={t("settings.link.custom.namePlaceholder")}
              onChange={(e) => set({ name: e.target.value })}
              className={`${inputCls} flex-1 text-sm`}
            />
          </div>

          {/* Method + URL */}
          <div className="flex gap-2">
            <select value={provider.method} onChange={(e) => set({ method: e.target.value })}
              className={`${inputCls} w-24 shrink-0`}>
              {METHODS.map((m) => <option key={m} value={m}>{m.toUpperCase()}</option>)}
            </select>
            <input type="text" value={provider.url}
              placeholder="https://api.example.com/upload"
              onChange={(e) => set({ url: e.target.value.trim() })}
              className={`${inputCls} flex-1 font-mono text-xs`}
            />
          </div>

          {/* Body type */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-500 shrink-0 w-20">{t("settings.link.custom.bodyType")}</span>
            <div className="flex rounded-lg overflow-hidden border border-stone-700 text-xs">
              {BODY_TYPES.map((bt) => (
                <button key={bt} type="button" onClick={() => set({ body_type: bt })}
                  className={`px-2.5 py-1 transition ${provider.body_type === bt ? "bg-accent-500 text-stone-950 font-medium" : "bg-stone-800 text-stone-400 hover:bg-stone-700"}`}>
                  {t(`settings.link.custom.bodyTypes.${bt}`)}
                </button>
              ))}
            </div>
          </div>

          {provider.body_type !== "binary" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-stone-500 shrink-0 w-20">{t("settings.link.custom.fileField")}</span>
              <input type="text" value={provider.file_field} placeholder="file"
                onChange={(e) => set({ file_field: e.target.value.trim() })}
                className={`${inputCls} w-32 font-mono text-xs`}
              />
            </div>
          )}

          {provider.body_type !== "binary" && (
            <div className="flex gap-2 items-start">
              <span className="text-xs text-stone-500 shrink-0 w-20 pt-1.5">{t("settings.link.custom.extraFields")}</span>
              <textarea value={provider.extra_fields} placeholder={"key=value\ntoken=abc123"}
                onChange={(e) => set({ extra_fields: e.target.value })}
                rows={2} className={`${inputCls} flex-1 font-mono text-xs resize-none`}
              />
            </div>
          )}

          <div className="flex gap-2 items-start">
            <span className="text-xs text-stone-500 shrink-0 w-20 pt-1.5">{t("settings.link.custom.headers")}</span>
            <textarea value={provider.headers} placeholder={"Authorization: Bearer token\nX-Api-Key: abc"}
              onChange={(e) => set({ headers: e.target.value })}
              rows={2} className={`${inputCls} flex-1 font-mono text-xs resize-none`}
            />
          </div>

          <div className="flex items-start gap-2">
            <span className="text-xs text-stone-500 shrink-0 w-20 pt-0.5">{t("settings.link.custom.acceptedFormats")}</span>
            <div className="flex flex-wrap gap-1.5">
              {(() => {
                const accepted = provider.accepted_formats || [];
                const isAll    = accepted.length === 0;
                const badgeCls = (on) => `text-xs px-2 py-0.5 rounded border transition ${
                  on ? "border-accent-500 bg-accent-500/20 text-accent-300"
                     : "border-stone-700 text-stone-500 hover:border-stone-500 hover:text-stone-400"
                }`;
                return <>
                  <button type="button" onClick={() => set({ accepted_formats: [] })} className={badgeCls(isAll)}>
                    {t("settings.link.custom.acceptedFormatsHint")}
                  </button>
                  {["png","jpg","webp","gif","bmp","avif"].map((fmt) => {
                    const on = accepted.includes(fmt);
                    return (
                      <button key={fmt} type="button"
                        onClick={() => set({ accepted_formats: on ? accepted.filter((f) => f !== fmt) : [...accepted, fmt] })}
                        className={badgeCls(on)}>
                        {fmt.toUpperCase()}
                      </button>
                    );
                  })}
                </>;
              })()}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-stone-500 shrink-0 w-20">{t("settings.link.custom.responseType")}</span>
            <select value={provider.response_type || "json_path"}
              onChange={(e) => set({ response_type: e.target.value, response_value: "" })}
              className={`${inputCls} w-36`}>
              {["plain_text","json_path","header","regex"].map((v) => (
                <option key={v} value={v}>{t(`settings.link.custom.responseTypes.${v}`)}</option>
              ))}
            </select>
          </div>
          {(provider.response_type || "json_path") !== "plain_text" && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-stone-500 shrink-0 w-20">{t("settings.link.custom.responseValue")}</span>
              <input type="text" value={provider.response_value || ""}
                placeholder={t(`settings.link.custom.responseValuePlaceholder.${provider.response_type || "json_path"}`)}
                onChange={(e) => set({ response_value: e.target.value.trim() })}
                className={`${inputCls} flex-1 font-mono text-xs`}
              />
            </div>
          )}

          <div className="flex justify-between items-center">
            <button type="button" onClick={runTest} disabled={!provider.url.trim() || testing}
              className="text-xs text-stone-400 hover:text-accent-300 transition px-2.5 py-1 rounded bg-stone-800 hover:bg-stone-700 disabled:opacity-40">
              {testing ? "…" : "Test"}
            </button>
            <button type="button" onClick={() => setExpanded(false)}
              className="text-xs text-stone-400 hover:text-stone-200 transition px-2.5 py-1 rounded bg-stone-800 hover:bg-stone-700">
              {t("settings.link.custom.collapse")}
            </button>
          </div>
        </div>
      )}
    </div>
    </>
  );
}

export function DirectLinkCard({ settings, apply, t }) {
  const providers = settings.direct_link_providers || [];
  const custom    = settings.custom_providers      || [];
  const order     = settings.provider_order        || [];

  const builtinMap = Object.fromEntries(providers.map((p) => [p.id, p]));
  const customMap  = Object.fromEntries(custom.map((p)    => [p.id, p]));
  const inOrder    = new Set(order);
  const unified = [
    ...order.map((id) => {
      if (builtinMap[id]) return { kind: "builtin", data: builtinMap[id] };
      if (customMap[id])  return { kind: "custom",  data: customMap[id] };
      return null;
    }).filter(Boolean),
    ...providers.filter((p) => !inOrder.has(p.id)).map((p) => ({ kind: "builtin", data: p })),
    ...custom.filter((p)    => !inOrder.has(p.id)).map((p) => ({ kind: "custom",  data: p })),
  ];

  const [dragging, setDragging] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const [showKey,  setShowKey]  = useState({});
  const ref = useRef({ dragging: null, dragOver: null, unified });
  ref.current.unified  = unified;
  ref.current.dragging = dragging;
  ref.current.dragOver = dragOver;

  useEffect(() => {
    const onMove = (e) => {
      if (ref.current.dragging === null) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return;
      const row = el.closest("[data-drag-idx]");
      if (!row) return;
      const idx = Number(row.dataset.dragIdx);
      if (!Number.isNaN(idx) && idx !== ref.current.dragOver) {
        ref.current.dragOver = idx;
        setDragOver(idx);
      }
    };
    const onUp = () => {
      const { dragging: from, dragOver: to, unified: list } = ref.current;
      if (from !== null && to !== null && from !== to) {
        const next = [...list];
        const [item] = next.splice(from, 1);
        next.splice(to, 0, item);
        apply({
          direct_link_providers: next.filter((x) => x.kind === "builtin").map((x) => x.data),
          custom_providers:      next.filter((x) => x.kind === "custom").map((x) => x.data),
          provider_order:        next.map((x) => x.data.id),
        });
      }
      ref.current.dragging = null;
      setDragging(null);
      setDragOver(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup",   onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup",   onUp);
    };
  }, []); // eslint-disable-line

  const toggleBuiltin = (id) =>
    apply({ direct_link_providers: providers.map((p) => p.id === id ? { ...p, enabled: !p.enabled } : p) });

  const updateCustom = (id, updated) =>
    apply({ custom_providers: custom.map((p) => p.id === id ? updated : p) });

  const removeCustom = (id) =>
    apply({ custom_providers: custom.filter((p) => p.id !== id) });

  const addCustom = () => {
    const id = "custom_" + Date.now().toString(36);
    apply({ custom_providers: [...custom, {
      id, name: "", enabled: true, method: "post", url: "",
      headers: "", body_type: "multipart", file_field: "file",
      extra_fields: "", response_type: "json_path", response_value: "", accepted_formats: [],
    }]});
  };

  let enabledCount = 0;

  return (
    <Card title={t("settings.link.title")}>
      <div className="py-2 text-xs text-stone-500">{t("settings.link.hint")}</div>

      {unified.map((item, idx) => {
        const isOver     = dragging !== null && dragOver === idx && dragging !== idx;
        const isDragging = dragging === idx;
        const onDragStart = (e) => {
          e.preventDefault();
          ref.current.dragging = idx;
          setDragging(idx);
          setDragOver(idx);
        };

        if (item.kind === "builtin") {
          const p    = item.data;
          const meta = PROVIDER_META[p.id];
          if (!meta) return null;
          const formats  = meta.formats  ?? t("settings.link.allFormats");
          const keyLabel = meta.keyLabel ?? t("settings.link.userhash");
          if (p.enabled) enabledCount++;
          const badge = p.enabled ? enabledCount : null;
          return (
            <div key={p.id} data-drag-idx={idx}
              className={`border-t border-stone-800/70 py-3 select-none transition-colors ${isOver ? "bg-stone-800/60 border-t-accent-500" : ""} ${isDragging ? "opacity-40" : ""}`}
            >
              <div className="flex items-center gap-2">
                <span onPointerDown={onDragStart}
                  className="cursor-grab active:cursor-grabbing text-stone-600 hover:text-stone-400 shrink-0 px-0.5 text-lg leading-none touch-none">⠿</span>
                <Toggle checked={p.enabled} onChange={() => toggleBuiltin(p.id)} />
                <div className="flex-1 min-w-0">
                  <div className={`text-sm ${p.enabled ? "text-stone-100" : "text-stone-500"}`}>{meta.name}</div>
                  <div className="text-xs text-stone-600 flex items-center gap-1.5">
                    <span>{formats}</span>
                    {meta.tos === meta.privacy ? (
                      <button type="button" onClick={() => invoke("open_url", { url: meta.tos })}
                        className="underline hover:text-stone-400 transition">{t("settings.link.legal")}</button>
                    ) : (
                      <>
                        <button type="button" onClick={() => invoke("open_url", { url: meta.tos })}
                          className="underline hover:text-stone-400 transition">{t("settings.link.tos")}</button>
                        <button type="button" onClick={() => invoke("open_url", { url: meta.privacy })}
                          className="underline hover:text-stone-400 transition">{t("settings.link.privacy")}</button>
                      </>
                    )}
                  </div>
                </div>
                {badge && <span className="text-xs text-stone-600 font-mono shrink-0">#{badge}</span>}
              </div>
              {p.enabled && meta.needsKey && (
                <div className="mt-2 flex items-center gap-2 pl-10">
                  <input type={showKey[p.id] ? "text" : "password"}
                    value={settings[meta.needsKey] || ""}
                    placeholder={t("settings.link.apiKey")}
                    onChange={(e) => apply({ [meta.needsKey]: e.target.value.trim() })}
                    className={`${inputCls} flex-1`}
                  />
                  <button type="button" onClick={() => setShowKey((s) => ({ ...s, [p.id]: !s[p.id] }))}
                    className="text-xs text-stone-500 hover:text-stone-300 shrink-0 transition">
                    {showKey[p.id] ? t("settings.link.hide") : t("settings.link.show")}
                  </button>
                  <span className="text-xs text-stone-600 shrink-0">{meta.keyHint}</span>
                </div>
              )}
              {p.enabled && meta.optionalKey && (
                <div className="mt-2 flex items-center gap-2 pl-10">
                  <input type={showKey[p.id + "_opt"] ? "text" : "password"}
                    value={settings[meta.optionalKey] || ""}
                    placeholder={keyLabel}
                    onChange={(e) => apply({ [meta.optionalKey]: e.target.value.trim() })}
                    className={`${inputCls} flex-1`}
                  />
                  <button type="button" onClick={() => setShowKey((s) => ({ ...s, [p.id + "_opt"]: !s[p.id + "_opt"] }))}
                    className="text-xs text-stone-500 hover:text-stone-300 shrink-0 transition">
                    {showKey[p.id + "_opt"] ? t("settings.link.hide") : t("settings.link.show")}
                  </button>
                </div>
              )}
            </div>
          );
        }

        const p = item.data;
        if (p.enabled) enabledCount++;
        return (
          <div key={p.id} data-drag-idx={idx}
            className={`border-t border-stone-800/70 py-2 select-none transition-colors ${isOver ? "border-t-accent-500" : ""} ${isDragging ? "opacity-40" : ""}`}
          >
            <CustomProviderRow
              provider={p}
              onChange={(updated) => updateCustom(p.id, updated)}
              onRemove={() => removeCustom(p.id)}
              isOver={isOver}
              isDragging={isDragging}
              dragHandle={{ onPointerDown: onDragStart }}
              t={t}
            />
          </div>
        );
      })}

      <div className="border-t border-stone-800/70 py-3">
        <Button onClick={addCustom}>+ {t("settings.link.custom.add")}</Button>
      </div>
    </Card>
  );
}
