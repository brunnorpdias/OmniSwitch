import { defineConfig } from "vitest/config";
import { resolve } from "path";

export default defineConfig({
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "tests/stubs/obsidian.ts"),
		},
	},
	test: {
		environment: "node",
		globals: true,
		coverage: {
			reporter: ["text", "lcov"],
		},
	},
});
