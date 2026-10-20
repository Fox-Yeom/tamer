import { defineConfig } from "vite";

// Tauri expects a fixed dev port and serves the built files from ../dist
export default defineConfig({
  base: "./", // relative asset paths: Electron loads dist/ from file://
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  // three pages: the main window, the desktop overlay and the menu bar dashboard (#105)
  build: { target: "safari16", outDir: "dist", rollupOptions: { input: { main: "index.html", overlay: "overlay.html", popover: "popover.html" } } },
});
