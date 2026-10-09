import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Two entries (widget = app embed, thankyou = app block), chunk splitting ON.
 * Entry names are stable (liquid references them); chunks are hashed and
 * emitted FLAT into the same assets dir so the ES-module loader resolves them
 * relative to the entry's CDN URL. Shopify's assets dir is flat — nested
 * chunk paths will not upload.
 *
 * Lazy loading: widget.js is a tiny loader; the app is a dynamic import(),
 * which Rollup automatically emits as a separate spx-app-[hash].js chunk that
 * only downloads when checkout is actually opened.
 */
export default defineConfig({
  plugins: [react()],
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "../extensions/smartpayx/assets",
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        widget: "src/widget/main.jsx",
        thankyou: "src/thankyou/main.jsx",
      },
      output: {
        format: "es",
        entryFileNames: "[name].js",
        chunkFileNames: "spx-[name]-[hash].js",
        assetFileNames: "spx-[name].[ext]",
      },
    },
  },
});
