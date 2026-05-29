#!/bin/bash
# Generate the six platform sidecar package.json files from a single platform
# table + template, instead of hand-maintaining six near-identical dirs. The
# binaries are staged separately by fetch-binaries.sh into packages/<dir>/bin/.
#
# Version is the source of truth baked into the binary: by default it's read
# back from the linux-x64 binary (the one that runs on the Linux publish
# runner); pass --version X.Y.Z to override, in which case it's asserted
# against the binary whenever that binary is present.
#
# Usage:
#   scripts/generate-sidecars.sh [--version X.Y.Z]
# The resolved version is printed to stdout (progress goes to stderr), so a
# caller can capture it:  VERSION=$(scripts/generate-sidecars.sh)
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCOPE="@dforge-core"
REPO_URL="https://github.com/dforge-core/dforge-cli.git"

# Single source of truth — "<dir> <os> <cpu>". Add a platform here and it flows
# through generation. Keep in sync with fetch-binaries.sh's asset->dir map().
PLATFORMS="
dforge-cli-darwin-arm64 darwin arm64
dforge-cli-darwin-x64   darwin x64
dforge-cli-linux-arm64  linux  arm64
dforge-cli-linux-x64    linux  x64
dforge-cli-win32-arm64  win32  arm64
dforge-cli-win32-x64    win32  x64
"

log() { echo "$@" >&2; }

VERSION_OVERRIDE=""
if [ "${1:-}" = "--version" ]; then
	[ -n "${2:-}" ] || { log "ERROR: --version needs a value"; exit 2; }
	VERSION_OVERRIDE="$2"
fi

# Read the version the binary self-reports, when a runnable one is present.
BIN="$REPO_ROOT/packages/dforge-cli-linux-x64/bin/dforge-cli"
BIN_VERSION=""
if [ -x "$BIN" ]; then
	BIN_VERSION="$("$BIN" --version | sed -n 's/^dForge\.Cli \([^ ]*\).*/\1/p')"
fi

if [ -n "$VERSION_OVERRIDE" ]; then
	VERSION="$VERSION_OVERRIDE"
	if [ -n "$BIN_VERSION" ] && [ "$BIN_VERSION" != "$VERSION" ]; then
		log "ERROR: --version $VERSION disagrees with binary ($BIN_VERSION)"; exit 1
	fi
elif [ -n "$BIN_VERSION" ]; then
	VERSION="$BIN_VERSION"
else
	log "ERROR: no --version given and no linux-x64 binary to derive it from"; exit 1
fi

log "-> Generating 6 sidecar packages @ $VERSION"

os_label() {
	case "$1" in
		darwin) echo "macOS" ;;
		win32)  echo "Windows" ;;
		linux)  echo "Linux" ;;
		*)      echo "$1" ;;
	esac
}

emit() {  # <dir> <os> <cpu>
	local dir="$1" os="$2" cpu="$3"
	local pkgdir="$REPO_ROOT/packages/$dir"
	mkdir -p "$pkgdir"
	NAME="$SCOPE/$dir" VERSION="$VERSION" OS="$os" CPU="$cpu" \
	LABEL="$(os_label "$os") $cpu" REPO_URL="$REPO_URL" \
	node -e '
		const fs = require("fs");
		const j = {
			name: process.env.NAME,
			version: process.env.VERSION,
			description: `${process.env.LABEL} binary for @dforge-core/dforge-cli. `
				+ `Not installed directly — see the parent package.`,
			license: "MIT",
			repository: { type: "git", url: process.env.REPO_URL },
			os: [process.env.OS],
			cpu: [process.env.CPU],
			files: ["bin/"],
		};
		fs.writeFileSync(process.argv[1], JSON.stringify(j, null, "\t") + "\n");
	' "$pkgdir/package.json"
	log "  ok packages/$dir/package.json ($os/$cpu)"
}

printf '%s\n' "$PLATFORMS" | while read -r dir os cpu; do
	[ -z "$dir" ] && continue
	emit "$dir" "$os" "$cpu"
done

echo "$VERSION"
