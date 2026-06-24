import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// GitHub Pages project site: served from https://xacnio.github.io/shotcove/
export default defineConfig({
  base: "/shotcove/",
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    rollupOptions: {
      input: {
        main: "index.html",
        privacy: "privacy.html",
        terms: "terms.html",
        license: "license.html",
      },
    },
  },
});
