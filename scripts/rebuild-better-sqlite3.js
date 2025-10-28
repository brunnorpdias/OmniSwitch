#!/usr/bin/env node
const { execSync } = require("child_process");
const path = require("path");
let electronVersion = process.env.OBSIDIAN_ELECTRON_VERSION;
if (!electronVersion) {
  const versionFile = path.resolve(__dirname, "../electron-version.json");
  try {
    electronVersion = require(versionFile).version;
  } catch (error) {
    console.error("[OmniSwitch] Could not read electron-version.json. Set OBSIDIAN_ELECTRON_VERSION.");
    process.exit(1);
  }
}
if (!electronVersion) {
  console.error("[OmniSwitch] Electron version is undefined. Set OBSIDIAN_ELECTRON_VERSION.");
  process.exit(1);
}
let sdkRoot = process.env.SDKROOT;
if (!sdkRoot) {
  try {
    sdkRoot = execSync("xcrun --sdk macosx --show-sdk-path", { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  } catch (error) {
    console.warn("[OmniSwitch] Could not infer SDKROOT via xcrun. Continuing without it.");
  }
}
const env = { ...process.env };
if (sdkRoot) {
  env.SDKROOT = sdkRoot;
  const includePath = path.join(sdkRoot, "usr", "include", "c++", "v1");
  env.CPLUS_INCLUDE_PATH = env.CPLUS_INCLUDE_PATH ? `${env.CPLUS_INCLUDE_PATH}:${includePath}` : includePath;
}
const arch = process.env.npm_config_arch || process.arch;
const rebuildCmd = `npm rebuild better-sqlite3 --runtime=electron --target=${electronVersion} --dist-url=https://electronjs.org/headers --arch=${arch}`;
console.log(`Rebuilding better-sqlite3 for Electron ${electronVersion} (${arch})…`);
try {
  execSync(rebuildCmd, { stdio: "inherit", env });
  console.log("[OmniSwitch] better-sqlite3 rebuild complete.");
} catch (error) {
  console.error("[OmniSwitch] npm rebuild better-sqlite3 failed.");
  process.exit(1);
}
