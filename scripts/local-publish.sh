#!/bin/bash
# Publish ONLY the wrapper (@dforge-core/dforge-cli) to npm from your local
# machine — for shipping JS-side changes (init command, native.ts tweaks,
# etc.) without touching the 6 platform binaries.
#
# What this does NOT do:
#   - Does NOT republish the 6 sidecars. Use scripts/publish.sh for that
#     (full 7-package release, normally driven by the publish.yml workflow).
#   - Does NOT bump optionalDependencies. The wrapper keeps pointing at
#     whatever sidecar version it was already pinned to.
#
# Prerequisites:
#   1. npm login (run once locally)
#   2. You own publish rights on @dforge-core/dforge-cli, OR a Trusted
#      Publisher is configured. Local publish uses your npm token; OIDC
#      provenance is silently skipped (npm CLI ignores --provenance when
#      not in a CI with id-token: write).
#
# Usage:
#   scripts/local-publish.sh <version> [--tag <dist-tag>] [--otp <code>] [--dry-run] [--yes]
#
# Examples:
#   scripts/local-publish.sh 0.2.0                          # publish to `next` tag (default)
#   scripts/local-publish.sh 0.2.0 --tag latest             # promote to `latest`
#   scripts/local-publish.sh 0.2.0 --otp 123456             # if your npm account has 2FA on publish
#   scripts/local-publish.sh 0.2.0 --dry-run                # see what would happen
#   scripts/local-publish.sh 0.2.0 --yes                    # skip confirmation prompt
#
# Behind the scenes this just calls scripts/publish.sh with --only
# dforge-cli — see that script for the full publish pipeline (pre-flight,
# version bump, dry-run, npm whoami, post-publish verify).
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ $# -lt 1 ] || [ "$1" = "-h" ] || [ "$1" = "--help" ]; then
	grep -E "^#( |$)" "$0" | sed 's/^# \?//'
	exit 0
fi

VERSION="$1"; shift
TAG="next"
EXTRA_ARGS=()

while [ $# -gt 0 ]; do
	case "$1" in
		--tag) TAG="$2"; shift 2 ;;
		--otp) EXTRA_ARGS+=("--otp" "$2"); shift 2 ;;
		--dry-run|--yes) EXTRA_ARGS+=("$1"); shift ;;
		*) echo "Unknown arg: $1" >&2; exit 1 ;;
	esac
done

# Delegate to the existing full-pipeline script — same dry-run, version
# alignment, npm whoami check, post-publish verification. --only restricts
# the publish to the wrapper.
exec "$SCRIPT_DIR/publish.sh" \
	--only dforge-cli \
	--version "$VERSION" \
	--tag "$TAG" \
	"${EXTRA_ARGS[@]}"
