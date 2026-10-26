import { defineConfig } from "vite";

// Tauri expects a fixed dev port and serves the built files from ../dist
export default defineConfig({
  base: "./", // relative asset paths: Electron loads dist/ from file://
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // the pages: the main window, the desktop overlay, the menu bar dashboard (#105), the windows of their own (APP-22)
  build: { target: "safari16", outDir: "dist", rollupOptions: { input: { main: "index.html", overlay: "overlay.html", popover: "popover.html", catch: "catch.html", settings: "settings.html", poke: "poke.html", choose: "choose.html" } } },
});
