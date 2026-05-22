import * as fs from "node:fs";
import * as path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

// Tar+gz writer. Pure-Node, no deps — avoids pulling `archiver` into the
// wrapper bundle (every extra dep slows npx cold-start). The .dforge format
// is just a zip per the C# install code (Tar+gz works too — ModuleInstall
// detects format by file header).
//
// We use gzip-wrapped TAR because Node ships zlib natively but not zip,
// and writing a TAR record stream is ~80 lines of code vs. requiring a dep.
//
// Actually — easier: shell out to the system `zip` command which is on
// every macOS/Linux/Windows-with-Git-Bash. Falls back to a friendly error
// if it's not. Most reliable cross-platform, smallest code surface.

import { spawnSync } from "node:child_process";

interface Manifest {
	code: string;
	version: string;
}

export async function runPack(argv: string[]): Promise<number> {
	const positional: string[] = [];
	let outPath: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-o" || a === "--output") {
			outPath = argv[++i];
		} else if (a === "-h" || a === "--help") {
			printHelp();
			return 0;
		} else {
			positional.push(a);
		}
	}

	if (positional.length === 0) {
		console.error("Usage: dforge-cli module pack <module-dir> [-o <output>]");
		return 2;
	}

	const moduleDir = path.resolve(positional[0]);
	const manifestPath = path.join(moduleDir, "manifest.json");
	if (!fs.existsSync(manifestPath)) {
		console.error(`No manifest.json at ${manifestPath}`);
		return 1;
	}

	let manifest: Manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
	} catch (e) {
		console.error(`manifest.json: ${(e as Error).message}`);
		return 1;
	}
	if (!manifest.code || !manifest.version) {
		console.error("manifest.json missing required `code` or `version`");
		return 1;
	}

	// Determine output path:
	//   --output ends in .dforge → use as-is
	//   --output is a directory → write <code>-<version>.dforge inside it
	//   no --output → write to current working directory
	const defaultName = `${manifest.code}-${manifest.version}.dforge`;
	let finalOut: string;
	if (!outPath) {
		finalOut = path.resolve(process.cwd(), defaultName);
	} else {
		const abs = path.resolve(outPath);
		if (abs.endsWith(".dforge")) {
			finalOut = abs;
		} else {
			fs.mkdirSync(abs, { recursive: true });
			finalOut = path.join(abs, defaultName);
		}
	}
	fs.mkdirSync(path.dirname(finalOut), { recursive: true });
	if (fs.existsSync(finalOut)) fs.rmSync(finalOut);

	// Use the system `zip` command. On macOS + most Linux distros it's
	// always present. On Windows the user typically runs from Git Bash
	// which ships zip via MSYS. If absent, surface a clear error.
	const zip = spawnSync(
		"zip",
		["-r", "-q", finalOut, "."],
		{
			cwd: moduleDir,
			stdio: ["ignore", "inherit", "inherit"],
		},
	);

	if (zip.error) {
		console.error(
			`pack: failed to run \`zip\`: ${zip.error.message}. Install zip ` +
				`(brew install zip / apt install zip / git-for-windows ships it).`,
		);
		return 1;
	}
	if (zip.status !== 0) {
		console.error(`pack: zip exited ${zip.status}`);
		return zip.status ?? 1;
	}

	const size = fs.statSync(finalOut).size;
	const kib = (size / 1024).toFixed(1);
	console.log(`✓ ${finalOut} (${kib} KB)`);
	void pipeline;
	void createGzip;
	return 0;
}

function printHelp(): void {
	console.log("Usage: dforge-cli module pack <module-dir> [-o <output>]");
	console.log("");
	console.log(
		"Packages a module directory into a .dforge archive (zip with .dforge extension).",
	);
	console.log("");
	console.log("Examples:");
	console.log("  dforge-cli module pack ./my-module                # → ./<code>-<version>.dforge");
	console.log("  dforge-cli module pack ./my-module -o ./dist/     # → ./dist/<code>-<version>.dforge");
	console.log("  dforge-cli module pack ./my-module -o pkg.dforge  # → ./pkg.dforge");
}
