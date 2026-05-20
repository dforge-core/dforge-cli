#!/usr/bin/env node
// Resolve the platform-specific binary package via require.resolve. Mirrors the
// esbuild distribution model: each supported platform is a separately-published
// optionalDependency with `os`/`cpu` pins, so npm installs only the right one
// for the user's machine. Fails fast with a clear message when no binary
// matches (most often: user is on an unsupported platform, or someone passed
// --no-optional to npm install).
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const platformMap = {
	"darwin-arm64": "@dforge-core/dforge-cli-darwin-arm64",
	"darwin-x64": "@dforge-core/dforge-cli-darwin-x64",
	"linux-x64": "@dforge-core/dforge-cli-linux-x64",
	"linux-arm64": "@dforge-core/dforge-cli-linux-arm64",
	"win32-x64": "@dforge-core/dforge-cli-win32-x64",
	"win32-arm64": "@dforge-core/dforge-cli-win32-arm64",
};

function resolveBinary() {
	// Escape hatch for source-repo / dist-repo maintainers who want to test a
	// freshly-built binary without going through the publish pipeline.
	// Honored before anything else.
	const override = process.env.DFORGE_CLI_BINARY;
	if (override) {
		if (!fs.existsSync(override)) {
			console.error(`dforge-cli: DFORGE_CLI_BINARY points at non-existent path: ${override}`);
			process.exit(1);
		}
		return override;
	}

	const key = `${process.platform}-${process.arch}`;
	const pkg = platformMap[key];
	if (!pkg) {
		console.error(
			`dforge-cli: unsupported platform "${key}". Supported: ${Object.keys(platformMap).join(", ")}.`,
		);
		process.exit(1);
	}

	let pkgJsonPath;
	try {
		pkgJsonPath = require.resolve(`${pkg}/package.json`);
	} catch {
		// Dist-repo dev fallback: after running scripts/fetch-binaries.sh the
		// sidecars sit under ./packages/<shortName>/ at the repo root, but
		// they're not in node_modules (no `pnpm install` to symlink them).
		// Check that path before bailing. Consumers of the published package
		// never hit this branch — require.resolve succeeds via npm-installed
		// node_modules.
		const shortName = pkg.split("/").pop();
		const siblingPkgJson = path.join(__dirname, "packages", shortName, "package.json");
		if (fs.existsSync(siblingPkgJson)) {
			pkgJsonPath = siblingPkgJson;
		} else {
			console.error(
				`dforge-cli: platform package "${pkg}" not installed. ` +
					`Re-run \`npm install\` without --no-optional, or install it explicitly.`,
			);
			process.exit(1);
		}
	}

	const pkgDir = path.dirname(pkgJsonPath);
	const binName = process.platform === "win32" ? "dforge-cli.exe" : "dforge-cli";
	const binPath = path.join(pkgDir, "bin", binName);
	if (!fs.existsSync(binPath)) {
		console.error(`dforge-cli: binary missing at ${binPath}`);
		process.exit(1);
	}

	// Ensure the binary is executable. pnpm/npm tarball-packing has dropped the
	// +x bit on files outside `bin` fields in some versions, so a freshly-
	// downloaded sidecar can land as 0644 even though the local checkout was
	// 0755. chmod is idempotent — no-op when already executable — and skipped
	// on Windows where it has no effect on .exe invocation.
	if (process.platform !== "win32") {
		try {
			const mode = fs.statSync(binPath).mode;
			if ((mode & 0o111) === 0) fs.chmodSync(binPath, mode | 0o755);
		} catch (e) {
			// Non-fatal: spawnSync below will surface EACCES with a clear message
			// if chmod failed for an unexpected reason (read-only fs, perms).
		}
	}
	return binPath;
}

const result = spawnSync(resolveBinary(), process.argv.slice(2), {
	stdio: "inherit",
	shell: false,
});

if (result.error) {
	console.error(`dforge-cli: failed to exec binary: ${result.error.message}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
