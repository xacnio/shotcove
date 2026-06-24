// Tailwind v4 emits a legacy hex/rgb color for every `color/opacity` utility
// (e.g. `bg-black/70`), then a `color-mix(in oklab, ...)` rule right after it
// to override that fallback in browsers that understand the modern syntax.
// Some WebKit builds (macOS WKWebView) parse `color-mix(in oklab|oklch|lab|lch,
// <color>, transparent)` without erroring but render it as a washed-out gray
// instead of the intended translucent color — a real WebKit rendering bug,
// not a missing-feature case the hex fallback is meant to catch. Since the
// override "succeeds" as far as the cascade is concerned, the buggy color
// wins everywhere on affected macOS builds (every modal/overlay backdrop in
// the app). Stripping these rules makes the safe legacy value win instead.
const stripColorMixFallback = () => ({
  postcssPlugin: "strip-color-mix-fallback",
  Declaration(decl) {
    if (/color-mix\(\s*in\s+(oklab|oklch|lab|lch)/i.test(decl.value)) {
      decl.remove();
    }
  },
  OnceExit(root) {
    root.walkRules((rule) => {
      if (rule.nodes.length === 0) rule.remove();
    });
  },
});
stripColorMixFallback.postcss = true;

export default {
  plugins: [stripColorMixFallback()],
};
