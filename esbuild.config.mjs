import esbuild from "esbuild";

const isProd = process.argv.includes("production");

const ctx = await esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: ["es2020"],
  sourcemap: isProd ? false : "inline",
  logLevel: "info",
  external: [
    // Obsidian and Electron APIs are provided by the host app
    "obsidian",
    "electron",
    // Common editor libs Obsidian exposes
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/commands",
    "@codemirror/language",
    "@lezer/common",
    // Node builtins (not bundled)
    "fs",
    "path",
    "os"
  ],
  define: {
    "process.env.NODE_ENV": JSON.stringify(isProd ? "production" : "development"),
  },
});

if (!isProd) {
  // In dev mode, rebuild on file changes and stay running
  const watch = await esbuild.context({
    entryPoints: ["main.ts"],
    bundle: true,
    outfile: "main.js",
    format: "cjs",
    platform: "node",
    target: ["es2020"],
    sourcemap: "inline",
    logLevel: "info",
    external: [
      "obsidian",
      "electron",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/commands",
      "@codemirror/language",
      "@lezer/common",
      "fs",
      "path",
      "os"
    ],
    define: {
      "process.env.NODE_ENV": JSON.stringify("development"),
    },
  });
  await watch.watch();
  console.log("esbuild watching for changes...");
}

