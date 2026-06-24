import { useEffect, useState } from "react";
import { marked } from "marked";
import { openExternalLinks } from "../lib/links.js";
import { translateHtml } from "../lib/translate.js";

const docClasses =
  "select-text text-sm text-stone-300 leading-relaxed space-y-3" +
  " [&_a]:text-accent-400 [&_a]:hover:underline [&_strong]:text-stone-100 [&_strong]:font-semibold" +
  " [&_code]:text-accent-300 [&_code]:bg-stone-900 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[13px]" +
  " [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:space-y-1 [&_li]:marker:text-stone-600";

// `releases` is pre-filtered/sorted by the caller to (lastSeenVersion, currentVersion].
export default function WhatsNewModal({ releases, lang, t, onClose }) {
  const [html, setHtml] = useState(() => releases.map((r) => marked.parse(r.body || "")));
  const [translated, setTranslated] = useState(false);
  const [translating, setTranslating] = useState(false);
  const canTranslate = lang && lang !== "en";

  useEffect(() => {
    setHtml(releases.map((r) => marked.parse(r.body || "")));
    setTranslated(false);
  }, [releases]);

  const toggleTranslate = async () => {
    if (translated) {
      setHtml(releases.map((r) => marked.parse(r.body || "")));
      setTranslated(false);
      return;
    }
    setTranslating(true);
    try {
      setHtml(await Promise.all(releases.map((r) => translateHtml(marked.parse(r.body || ""), lang))));
      setTranslated(true);
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="absolute inset-0 z-[100] flex items-center justify-center bg-black/85" onClick={onClose}>
      <div
        className="relative flex flex-col w-[560px] max-h-[80vh] rounded-2xl border border-stone-700/60 bg-stone-950 shadow-2xl shadow-black/80"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-stone-800 shrink-0">
          <h2 className="text-base font-semibold text-stone-100">{t("whatsNew.title")}</h2>
          <div className="flex items-center gap-3">
            {canTranslate && (
              <button onClick={toggleTranslate} disabled={translating}
                className="text-xs text-accent-400 hover:text-accent-300 disabled:opacity-50 transition-colors">
                {translating ? t("legal.translating") : translated ? t("legal.showOriginal") : t("legal.translate")}
              </button>
            )}
            <button onClick={onClose} className="text-stone-500 hover:text-stone-300 text-lg leading-none">✕</button>
          </div>
        </div>

        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-6">
          {translated && <p className="text-xs text-stone-500 italic">{t("legal.machineTranslated")}</p>}
          {releases.map((r, i) => (
            <div key={r.version}>
              <h3 className="text-sm font-semibold text-stone-100 mb-2">{r.name || r.version}</h3>
              <div className={docClasses} onClick={openExternalLinks} dangerouslySetInnerHTML={{ __html: html[i] }} />
            </div>
          ))}
        </div>

        <div className="px-6 py-4 border-t border-stone-800/60 shrink-0">
          <button onClick={onClose}
            className="w-full rounded-lg bg-accent-400 px-3.5 py-2 text-sm font-medium text-stone-950 hover:bg-accent-300 transition">
            {t("whatsNew.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
