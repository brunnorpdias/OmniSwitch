import esbuild from "esbuild";
import builtinModules from "builtin-modules";

const isProd = process.argv.includes("production");

const options = {
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: "main.js",
  sourcemap: isProd ? false : "inline",
  minify: isProd,
  target: "es2018",
  format: "cjs",
  platform: "browser",
  external: [
    // Obsidian and Electron are provided by the host app
    "obsidian",
    "electron",
    // Exclude Node built-ins from the bundle just in case
    ...builtinModules,
  ],
  logLevel: "info",
  legalComments: "none",
};

if (isProd) {
  esbuild.build(options).catch(() => process.exit(1));
} else {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("[esbuild] Watching for changes…");
}

