import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri multi-window: each window loads its own HTML entry point.
// (settings → index.html, overlay → overlay.html, editor → editor.html)
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        gallery: "pages/gallery.html",
        settings: "pages/index.html",
        overlay: "pages/overlay.html",
        editor: "pages/editor.html",
        transfers: "pages/transfers.html",
      },
    },
  },
});
