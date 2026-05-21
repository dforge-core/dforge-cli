import { defineConfig } from "tsup";

export default defineConfig([
	// CLI bin — bundled with @clack/prompts inlined, gets a shebang banner so
	// the output is directly executable as the `dforge-cli` bin.
	{
		entry: ["src/cli.ts"],
		format: ["cjs"],
		target: "node18",
		bundle: true,
		clean: true,
		banner: { js: "#!/usr/bin/env node" },
		noExternal: ["@clack/prompts"],
	},
	// Library entry — for downstream packages (e.g. @dforge-core/dforge-mcp)
	// to import the pure scaffold builders. ESM + CJS, with .d.ts so
	// consumers get types. No bundling — the builders are dependency-free
	// pure TS, so tsup just transpiles them.
	{
		entry: ["src/lib.ts"],
		format: ["cjs", "esm"],
		target: "node18",
		dts: true,
		// Don't clean again — would wipe the cli.js output above. tsup runs
		// the two configs in sequence and the first one already cleaned.
		clean: false,
	},
]);
