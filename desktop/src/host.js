// Host bridge: Electron's preload exposes window.cvimHost (the Tauri version was removed 2026-10-05;
// X0 finding that led to Electron: WKWebView split fast Hangul input into jamo — docs/PLATFORM.md 3.3c)
export function invoke(cmd, args) {
  return window.cvimHost.invoke(cmd, args);
}

// resolves once the listener is registered (callers spawn processes only after that)
export function listen(event, cb) {
  window.cvimHost.listen(event, (payload) => cb({ payload }));
  return Promise.resolve();
}
