import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/cli.ts"],
	format: ["cjs"],
	target: "node18",
	bundle: true,
	clean: true,
	banner: { js: "#!/usr/bin/env node" },
	// Bundle @clack/prompts and its small dep tree into one dist/cli.js so
	// the published npm tarball ships a single file — no node_modules tree
	// to install on the user's machine.
	noExternal: ["@clack/prompts"],
});
