// Turn off Electron features this app doesn't need and that would let other programs run code
// as Tamer (docs/policy POL-SEC-01): ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect. Turn on asar
// integrity so the packaged app code can't be swapped. Runs after packaging; re-signs ad hoc.
const path = require("node:path");
const { flipFuses, FuseVersion, FuseV1Options } = require("@electron/fuses");

// argv[2]: another build (a test build next to the app in use)
const app = process.argv[2] || path.resolve(__dirname, "../out/Tamer-darwin-arm64/Tamer.app");
flipFuses(app, {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true,
  [FuseV1Options.RunAsNode]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.EnableCookieEncryption]: true,
}).then(() => console.log("fuses set:", app)).catch((e) => { console.error(e); process.exit(1); });
