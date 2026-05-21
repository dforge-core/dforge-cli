#!/bin/bash
# Pack the wrapper as a tarball and install it globally on this machine.
# Use this to smoke-test changes (especially the `init module` flow) without
# going through the npm publish pipeline.
#
# Usage:
#   scripts/local-install.sh                # pack + install
#   scripts/local-install.sh --pack-only    # just produce the .tgz, skip install
#   scripts/local-install.sh --uninstall    # remove the globally installed wrapper
#
# After install, run from anywhere:
#   DFORGE_CLI_BINARY=/path/to/dForge.Cli dforge-cli init module /tmp/test
#
# DFORGE_CLI_BINARY is needed because this local install ships only the
# wrapper (no platform sidecars). For full native-binary support, install
# a matching sidecar globally too, e.g.:
#   npm install -g @dforge-core/dforge-cli-darwin-arm64@0.1.0-rc.2
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

MODE="install"
for arg in "$@"; do
	case "$arg" in
		--pack-only) MODE="pack" ;;
		--uninstall) MODE="uninstall" ;;
		-h|--help)
			grep -E "^#( |$)" "$0" | sed 's/^# \?//'; exit 0 ;;
		*) echo "Unknown arg: $arg" >&2; exit 1 ;;
	esac
done

if [ -t 1 ]; then
	C_GREEN=$'\033[32m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
	C_GREEN=""; C_DIM=""; C_BOLD=""; C_OFF=""
fi
ok() { echo "  ${C_GREEN}✓${C_OFF} $1"; }
step() { echo; echo "${C_BOLD}── $1 ──${C_OFF}"; }

if [ "$MODE" = "uninstall" ]; then
	step "Uninstalling @dforge-core/dforge-cli globally"
	npm uninstall -g "@dforge-core/dforge-cli" || true
	ok "Uninstalled (or wasn't installed)"
	exit 0
fi

cd "$REPO_ROOT"

step "Building wrapper"
pnpm build
ok "dist/cli.js built"

step "Packing as tarball"
# npm pack prints the filename on stdout (other lines go to stderr). The
# resulting .tgz lands in cwd.
TARBALL=$(npm pack --silent | tail -1)
ok "$TARBALL"

if [ "$MODE" = "pack" ]; then
	step "Pack-only mode"
	echo "  Tarball at: ${C_BOLD}$REPO_ROOT/$TARBALL${C_OFF}"
	echo "  Install manually with: ${C_DIM}npm install -g ./$TARBALL${C_OFF}"
	exit 0
fi

step "Installing globally"
# Pass the absolute path so npm doesn't get confused about cwd.
npm install -g "$REPO_ROOT/$TARBALL"
ok "Installed"

step "Verifying"
WHICH=$(which dforge-cli || true)
if [ -z "$WHICH" ]; then
	echo "  ${C_DIM}!${C_OFF} dforge-cli not on PATH yet. Open a new shell, or check your npm prefix."
else
	ok "dforge-cli → $WHICH"
fi

step "Done"
echo "  Try: ${C_BOLD}dforge-cli init module /tmp/scaffold-test${C_OFF}"
echo "  Native commands need a binary — either install a sidecar:"
echo "    ${C_DIM}npm install -g @dforge-core/dforge-cli-darwin-arm64@0.1.0-rc.2${C_OFF}"
echo "  …or point at a local C# build:"
echo "    ${C_DIM}export DFORGE_CLI_BINARY=/path/to/dForge.Cli${C_OFF}"
echo
echo "  Tidy up the tarball when done: ${C_DIM}rm $TARBALL${C_OFF}"
