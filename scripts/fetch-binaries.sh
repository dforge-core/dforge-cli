#!/bin/bash
# Download dForge.Cli binaries from a GitHub Release on dforge-core/dForge-core
# and place each one in its npm-sidecar bin/ dir. The source repo's
# release-cli workflow names assets by RID (dforge-cli-osx-arm64,
# dforge-cli-win-x64.exe, …); this script maps each RID asset to the npm
# package naming (darwin/win32 instead of osx/win) the sidecar dirs use.
#
# Usage:
#   scripts/fetch-binaries.sh <source-tag>
# Example:
#   scripts/fetch-binaries.sh cli-v0.1.0-rc.2
#
# Auth:
#   - In CI: GH_TOKEN env (set by workflow from GITHUB_TOKEN or a PAT).
#   - Locally: `gh auth login` first.
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SOURCE_REPO="dforge-core/dForge-core"

TAG="${1:-}"
if [ -z "$TAG" ]; then
	echo "Usage: $0 <source-tag>" >&2
	echo "  e.g.  $0 cli-v0.1.0-rc.2" >&2
	exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
	echo "ERROR: gh CLI not found. Install: https://cli.github.com/" >&2
	exit 1
fi

TMP_DIR="$(mktemp -d -t dforge-fetch.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

# Asset name on the GitHub Release → "<sidecar-dir> <bin-filename>" pair.
# Asset names match release-cli.yml's matrix asset_name values exactly.
# Bash 3.2 compatible (no associative arrays).
map() {
	case "$1" in
		dforge-cli-osx-arm64)      echo "dforge-cli-darwin-arm64 dforge-cli" ;;
		dforge-cli-osx-x64)        echo "dforge-cli-darwin-x64 dforge-cli" ;;
		dforge-cli-linux-x64)      echo "dforge-cli-linux-x64 dforge-cli" ;;
		dforge-cli-linux-arm64)    echo "dforge-cli-linux-arm64 dforge-cli" ;;
		dforge-cli-win-x64.exe)    echo "dforge-cli-win32-x64 dforge-cli.exe" ;;
		dforge-cli-win-arm64.exe)  echo "dforge-cli-win32-arm64 dforge-cli.exe" ;;
		*)                         echo "" ;;
	esac
}

ASSETS="dforge-cli-osx-arm64 dforge-cli-osx-x64 dforge-cli-linux-x64 dforge-cli-linux-arm64 dforge-cli-win-x64.exe dforge-cli-win-arm64.exe"

echo
echo "→ Fetching $TAG assets from $SOURCE_REPO"
echo "  staging dir: $TMP_DIR"

# Download all matching assets in one gh call. --pattern uses a fnmatch glob,
# so 'dforge-cli-*' captures all six. --clobber lets us re-run the script
# against an existing tmp dir without prompting.
if ! gh release download "$TAG" \
		--repo "$SOURCE_REPO" \
		--dir "$TMP_DIR" \
		--pattern 'dforge-cli-*' \
		--clobber; then
	echo "ERROR: gh release download failed. Check:" >&2
	echo "  - tag exists: gh release view $TAG --repo $SOURCE_REPO" >&2
	echo "  - you're authenticated: gh auth status" >&2
	exit 1
fi

echo
echo "→ Staging binaries into sidecar bin/ dirs"
for asset in $ASSETS; do
	mapping=$(map "$asset")
	if [ -z "$mapping" ]; then
		echo "  WARN: no mapping for $asset, skipping" >&2
		continue
	fi
	# shellcheck disable=SC2086  # word-splitting is intentional
	set -- $mapping
	dir="$1"; binname="$2"

	src="$TMP_DIR/$asset"
	dst="$REPO_ROOT/packages/$dir/bin/$binname"
	if [ ! -f "$src" ]; then
		echo "  ✗ missing $src — was it uploaded to the release?" >&2
		exit 1
	fi
	mkdir -p "$REPO_ROOT/packages/$dir/bin"
	mv "$src" "$dst"
	chmod +x "$dst" 2>/dev/null || true
	size=$(du -h "$dst" | cut -f1 | tr -d ' ')
	echo "  ✓ packages/$dir/bin/$binname  ($size)"
done

echo
echo "✅ All 6 binaries staged for publish."
