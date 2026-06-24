import { useLanguage } from "../lib/LanguageContext.jsx";
import Screenshot from "./Screenshot.jsx";

export default function Screenshots() {
  const { t } = useLanguage();
  return (
    <section className="max-w-6xl mx-auto px-6 py-20 border-t border-stone-800/80">
      <h2 className="text-2xl font-bold tracking-tight">{t("screenshots.title")}</h2>
      <p className="mt-2 text-stone-400 max-w-lg">{t("screenshots.desc")}</p>
      <div className="mt-10 grid sm:grid-cols-2 gap-6">
        <figure>
          <Screenshot
            src="screenshots/gallery.webp"
            alt={t("screenshots.galleryAlt")}
            placeholder={t("screenshots.galleryPlaceholder")}
            note={t("features.placeholderLabel")}
          />
          <figcaption className="mt-3 text-sm text-stone-500">{t("screenshots.galleryCaption")}</figcaption>
        </figure>
        <figure>
          <Screenshot
            src="screenshots/editor.webp"
            alt={t("screenshots.editorAlt")}
            placeholder={t("screenshots.editorPlaceholder")}
            note={t("features.placeholderLabel")}
          />
          <figcaption className="mt-3 text-sm text-stone-500">{t("screenshots.editorCaption")}</figcaption>
        </figure>
      </div>
    </section>
  );
}
