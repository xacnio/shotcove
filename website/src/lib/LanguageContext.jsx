import { createContext, useContext, useMemo, useState } from "react";
import { useT } from "./i18n.js";

const STORAGE_KEY = "shotcove-website-lang";
const LanguageContext = createContext(null);

function detectBrowserLanguage() {
  if (typeof navigator === "undefined") return "en";
  return navigator.language?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

function initialLanguage() {
  if (typeof localStorage === "undefined") return detectBrowserLanguage();
  // A manual choice always wins over the browser language on later visits.
  return localStorage.getItem(STORAGE_KEY) ?? detectBrowserLanguage();
}

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(initialLanguage);
  const t = useT(lang);

  const setLang = (next) => {
    setLangState(next);
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, next);
  };

  const value = useMemo(() => ({ lang, setLang, t }), [lang]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  const ctx = useContext(LanguageContext);
  if (!ctx) throw new Error("useLanguage must be used within LanguageProvider");
  return ctx;
}
