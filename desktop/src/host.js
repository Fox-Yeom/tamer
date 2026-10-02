// Host bridge: the same UI runs in Tauri (WKWebView) or Electron (Chromium).
// Electron's preload exposes window.cvimHost; otherwise use Tauri's API.
// (X0 finding: WKWebView splits fast Hangul input into jamo — see docs/PLATFORM.md 3.3c)
import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen } from "@tauri-apps/api/event";

const electron = typeof window !== "undefined" && window.cvimHost;

export const hostName = electron ? "electron" : "tauri";

export function invoke(cmd, args) {
  return electron ? window.cvimHost.invoke(cmd, args) : tauriInvoke(cmd, args);
}

// resolves once the listener is registered (callers spawn processes only after that)
export function listen(event, cb) {
  if (!electron) return tauriListen(event, cb);
  window.cvimHost.listen(event, (payload) => cb({ payload }));
  return Promise.resolve();
}
