#!/bin/bash
# Generate the six platform sidecar package.json files from a single platform
# table + template, instead of hand-maintaining six near-identical dirs. The
# binaries are staged separately by fetch-binaries.sh into packages/<dir>/bin/.
#
# Version is the source of truth baked into the binary: by default it's read
# back from a staged binary this host can execute; pass --version X.Y.Z to
# override, in which case it's asserted against that binary. When binaries are
# staged but none of them can be probed here, that's a hard error rather than a
# silent skip — see the probe block below.
#
# Usage:
#   scripts/generate-sidecars.sh [--version X.Y.Z] [--allow-unverified-binary]
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
ALLOW_UNVERIFIED=0
while [ $# -gt 0 ]; do
	case "$1" in
		--version)
			[ -n "${2:-}" ] || { log "ERROR: --version needs a value"; exit 2; }
			VERSION_OVERRIDE="$2"; shift 2 ;;
		--allow-unverified-binary)
			ALLOW_UNVERIFIED=1; shift ;;
		*)
			log "ERROR: unknown argument: $1"; exit 2 ;;
	esac
done

bin_path_for() {  # <dir>
	case "$1" in
		*win32*) echo "$REPO_ROOT/packages/$1/bin/dforge-cli.exe" ;;
		*)       echo "$REPO_ROOT/packages/$1/bin/dforge-cli" ;;
	esac
}

# Which sidecar matches the host running this script? Probed first, since it's
# the one guaranteed to execute when it's staged. Empty on an unrecognised host.
host_platform_dir() {
	local os cpu
	case "$(uname -s)" in
		Darwin)               os=darwin ;;
		Linux)                os=linux ;;
		MINGW*|MSYS*|CYGWIN*) os=win32 ;;
		*)                    return 0 ;;
	esac
	case "$(uname -m)" in
		arm64|aarch64) cpu=arm64 ;;
		x86_64|amd64)  cpu=x64 ;;
		*)             return 0 ;;
	esac
	echo "dforge-cli-$os-$cpu"
}

# ── Probe the staged binaries for the version they self-report ───────
# The version baked into the binary is the source of truth, so it has to be
# read on whatever host runs this script — not just on the Linux publish
# runner. Probe order is host-native sidecar first, then every other staged
# binary (a darwin-x64 build answers on arm64 under Rosetta, so more than one
# may respond).
#
# `-x` only means the execute bit is set, not that THIS host can run the file —
# a Linux binary on macOS exits "cannot execute binary file". Individual probes
# are allowed to fail. What is NOT allowed is *every* probe failing while
# binaries are staged: that silently drops the assertion below and lets the npm
# version drift ahead of the build it ships. Previously this script only ever
# probed linux-x64, so publishing from a macOS checkout skipped the check
# entirely and 0.2.13/0.2.14 went out carrying the 0.2.12 binary.
HOST_DIR="$(host_platform_dir)"
ALL_DIRS="$(printf '%s\n' "$PLATFORMS" | awk 'NF {print $1}')"

PROBE_ORDER=""
for dir in $HOST_DIR $ALL_DIRS; do
	case " $PROBE_ORDER " in *" $dir "*) continue ;; esac
	PROBE_ORDER="$PROBE_ORDER $dir"
done

STAGED=()        # binaries present on disk
PROBED_PAIRS=()  # "<dir>=<version>" for the ones that answered
DISTINCT=""      # unique self-reported versions, space-delimited
for dir in $PROBE_ORDER; do
	bin="$(bin_path_for "$dir")"
	[ -f "$bin" ] || continue
	STAGED+=("$dir")
	[ -x "$bin" ] || continue
	v="$("$bin" --version 2>/dev/null | sed -n 's/^dForge\.Cli \([^ ]*\).*/\1/p' || true)"
	[ -n "$v" ] || continue
	PROBED_PAIRS+=("$dir=$v")
	case " $DISTINCT " in *" $v "*) ;; *) DISTINCT="$DISTINCT $v" ;; esac
done

DISTINCT_COUNT=$(echo $DISTINCT | wc -w | tr -d ' ')
if [ "$DISTINCT_COUNT" -gt 1 ]; then
	log "ERROR: staged binaries disagree on version — the set is not from one build:"
	for pair in "${PROBED_PAIRS[@]}"; do log "         ${pair%%=*} -> ${pair#*=}"; done
	log "       Re-stage a single build: scripts/fetch-binaries.sh <cli-vX.Y.Z>"
	exit 1
fi
BIN_VERSION="$(echo $DISTINCT)"  # unquoted: strips the leading space

if [ -z "$BIN_VERSION" ]; then
	if [ ${#STAGED[@]} -eq 0 ]; then
		# Nothing staged at all — there is no build here to verify against, and
		# that's legitimate for a wrapper-only publish. publish.sh's pre-flight
		# hard-fails on missing binaries for any publish that actually ships
		# them, so this stays a warning.
		log "!! no staged binaries — version is NOT verified against a build"
	elif [ "$ALLOW_UNVERIFIED" -eq 1 ]; then
		log "!! ${#STAGED[@]} staged binary/binaries, none runnable on $(uname -s)/$(uname -m)"
		log "!! proceeding unverified (--allow-unverified-binary)"
	else
		log "ERROR: ${#STAGED[@]} binary/binaries staged, but none could be executed on"
		log "       this host ($(uname -s)/$(uname -m)) to read the version they were"
		log "       built as, so the version cannot be verified."
		log "       Expected host-native sidecar: ${HOST_DIR:-<unrecognised host>}"
		log "       Fix by staging the build you mean to publish:"
		log "         scripts/fetch-binaries.sh <cli-vX.Y.Z>"
		log "       or re-run with --allow-unverified-binary to skip this check."
		exit 1
	fi
fi

if [ -n "$VERSION_OVERRIDE" ]; then
	VERSION="$VERSION_OVERRIDE"
	if [ -n "$BIN_VERSION" ] && [ "$BIN_VERSION" != "$VERSION" ]; then
		log "ERROR: --version $VERSION disagrees with the staged binaries ($BIN_VERSION)"
		for pair in "${PROBED_PAIRS[@]}"; do log "         ${pair%%=*} -> ${pair#*=}"; done
		log "       Either publish $BIN_VERSION, or stage the $VERSION build first:"
		log "         scripts/fetch-binaries.sh cli-v$VERSION"
		exit 1
	fi
elif [ -n "$BIN_VERSION" ]; then
	VERSION="$BIN_VERSION"
else
	log "ERROR: no --version given and no probeable binary to derive it from"; exit 1
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
