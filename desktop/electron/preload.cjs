// Exposes the host bridge (window.cvimHost) used by src/host.js. Context-isolated: only these
// functions reach the page.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

const handlers = new Map(); // event name -> [callback]
ipcRenderer.on("host-event", (_e, { event, payload }) => {
  for (const cb of handlers.get(event) || []) cb(payload);
});

contextBridge.exposeInMainWorld("cvimHost", {
  invoke: (cmd, args) => ipcRenderer.invoke("host-invoke", cmd, args || {}),
  // real path of a file/folder dropped from Finder (File.path is gone in sandboxed pages)
  pathForFile: (file) => webUtils.getPathForFile(file),
  listen: (event, cb) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(cb);
  },
});
