#!/bin/bash
# Publish @dforge-core/dforge-cli and its 6 platform-binary sidecars to npm.
#
# What this script does (defaults marked *):
#   1. Pre-flight: all 7 package.json present *; 6 binaries present (unless --source-tag also given, then fetch first)
#   2. If --source-tag: fetch-binaries.sh <tag> to populate packages/*/bin/
#   3. If --version: bump all 7 package.json `version` fields + the wrapper's
#      optionalDependencies block to the new version
#   4. Show version table and verify all match *
#   5. Check npm login (skipped for --dry-run) *
#   6. Dry-run pnpm publish *
#   7. If not --dry-run and not --yes: prompt for confirmation, then publish
#   8. Post-publish verify against the registry
#
# Sidecars publish FIRST so the wrapper's optionalDependencies all resolve
# the moment the wrapper hits the registry. The wrapper's optionalDependencies
# use literal versions (no `workspace:*` — this repo has no pnpm workspace);
# --version rewrites both the wrapper's "version" field AND every entry in
# its "optionalDependencies" block, keeping all 7 packages in lockstep.
#
# Usage:
#   scripts/publish.sh --dry-run                                           # preflight + dry-run, no publish, no prompt
#   scripts/publish.sh --source-tag cli-v0.1.0-rc.2 --version 0.1.0-rc.2   # full flow
#   scripts/publish.sh --version 0.1.0-rc.3 --tag next                     # bump + publish under `next`
#   scripts/publish.sh --version 0.2.0 --tag latest --yes --otp 123456     # non-interactive (CI)
#   scripts/publish.sh --only dforge-cli                                   # publish only the wrapper
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WRAPPER_PKG="dforge-cli"
PLATFORM_PKGS="dforge-cli-darwin-arm64 dforge-cli-darwin-x64 dforge-cli-linux-x64 dforge-cli-linux-arm64 dforge-cli-win32-x64 dforge-cli-win32-arm64"
ALL_PKGS="$WRAPPER_PKG $PLATFORM_PKGS"

# Wrapper lives at repo root; sidecars under packages/. pkg_dir() resolves
# each package name to its on-disk dir.
pkg_dir() {
	case "$1" in
		dforge-cli)     echo "$REPO_ROOT" ;;
		dforge-cli-*-*) echo "$REPO_ROOT/packages/$1" ;;
		*)              echo "" ;;
	esac
}

SOURCE_TAG=""
DRY_RUN=0
NEW_VERSION=""
NPM_TAG="latest"
OTP=""
ONLY=""
ASSUME_YES=0

usage() {
	grep -E "^#( |$)" "$0" | sed 's/^# \?//'
	exit 0
}

while [ $# -gt 0 ]; do
	case "$1" in
		--source-tag) SOURCE_TAG="$2"; shift 2 ;;
		--dry-run)    DRY_RUN=1; shift ;;
		--version)    NEW_VERSION="$2"; shift 2 ;;
		--tag)        NPM_TAG="$2"; shift 2 ;;
		--otp)        OTP="$2"; shift 2 ;;
		--only)       ONLY="$2"; shift 2 ;;
		--yes)        ASSUME_YES=1; shift ;;
		-h|--help)    usage ;;
		*)            echo "Unknown argument: $1" >&2; echo "See: $0 --help" >&2; exit 1 ;;
	esac
done

# Pretty printers — purely cosmetic. Falls back to plain text when not a TTY.
if [ -t 1 ]; then
	C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
	C_GREEN=""; C_RED=""; C_DIM=""; C_BOLD=""; C_OFF=""
fi

section() { echo; echo "${C_BOLD}── $1 ──${C_OFF}"; }
ok()      { echo "  ${C_GREEN}✓${C_OFF} $1"; }
fail()    { echo "  ${C_RED}✗${C_OFF} $1" >&2; exit 1; }

# JSON-aware version helpers (python3 instead of regex over sed — the
# optionalDependencies block contains version-like strings).
read_version() {
	python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$1"
}

write_version() {
	local pj="$1"; local v="$2"
	python3 -c '
import json,sys
p=sys.argv[1]; v=sys.argv[2]
d=json.load(open(p))
d["version"]=v
with open(p,"w") as f: json.dump(d, f, indent="\t"); f.write("\n")
' "$pj" "$v"
}

# Rewrite every entry in the wrapper's "optionalDependencies" matching the
# dforge-cli sidecar naming pattern to the given version. Required because
# the wrapper uses literal versions (this repo has no pnpm workspace), so a
# version bump has to keep the optionalDependencies in lockstep manually.
write_wrapper_optional_deps_version() {
	local pj="$1"; local v="$2"
	python3 -c '
import json,re,sys
p=sys.argv[1]; v=sys.argv[2]
d=json.load(open(p))
deps=d.get("optionalDependencies", {}) or {}
pat=re.compile(r"^@dforge-core/dforge-cli-(darwin|linux|win32)-(arm64|x64)$")
for k in list(deps.keys()):
    if pat.match(k):
        deps[k]=v
d["optionalDependencies"]=deps
with open(p,"w") as f: json.dump(d, f, indent="\t"); f.write("\n")
' "$pj" "$v"
}

binary_name_for() {
	case "$1" in
		*win32*) echo dforge-cli.exe ;;
		*)       echo dforge-cli ;;
	esac
}

# ── 0. Optional: fetch binaries from source-repo release ─────────────
if [ -n "$SOURCE_TAG" ]; then
	section "Fetching binaries from $SOURCE_TAG"
	"$SCRIPT_DIR/fetch-binaries.sh" "$SOURCE_TAG"
fi

# ── 1. Pre-flight ────────────────────────────────────────────────────
section "Pre-flight"
for pkg in $ALL_PKGS; do
	[ -f "$(pkg_dir "$pkg")/package.json" ] || fail "missing $pkg/package.json"
done
ok "all 7 package.json present"

missing_bins=0
for pkg in $PLATFORM_PKGS; do
	bin=$(binary_name_for "$pkg")
	if [ ! -f "$(pkg_dir "$pkg")/bin/$bin" ]; then
		echo "  ${C_RED}✗${C_OFF} missing $pkg/bin/$bin"
		missing_bins=$((missing_bins+1))
	fi
done
if [ "$missing_bins" -gt 0 ]; then
	fail "$missing_bins binary file(s) missing — pass --source-tag <cli-vX.Y.Z> to fetch them"
fi
ok "all 6 platform binaries present"

# ── 2. Version bump ──────────────────────────────────────────────────
if [ -n "$NEW_VERSION" ]; then
	section "Bumping all 7 packages to $NEW_VERSION"
	for pkg in $ALL_PKGS; do
		write_version "$(pkg_dir "$pkg")/package.json" "$NEW_VERSION"
		ok "$pkg → $NEW_VERSION"
	done
	write_wrapper_optional_deps_version "$(pkg_dir "$WRAPPER_PKG")/package.json" "$NEW_VERSION"
	ok "$WRAPPER_PKG optionalDependencies → $NEW_VERSION"
fi

# ── 3. Verify version consistency ────────────────────────────────────
section "Versions"
all_versions=""
for pkg in $ALL_PKGS; do
	v=$(read_version "$(pkg_dir "$pkg")/package.json")
	marker=""
	[ -n "$ONLY" ] && [ "$pkg" = "$ONLY" ] && marker=" ← target"
	printf "  %-34s %s%s\n" "@dforge-core/$pkg" "$v" "$marker"
	all_versions="$all_versions $v"
done
distinct=$(echo "$all_versions" | tr ' ' '\n' | sed '/^$/d' | sort -u)
distinct_count=$(echo "$distinct" | wc -l | tr -d ' ')

if [ -n "$ONLY" ]; then
	case " $ALL_PKGS " in
		*" $ONLY "*) ;;
		*) fail "--only '$ONLY' is not a known package. Choose from: $ALL_PKGS" ;;
	esac
	TARGET_VERSION=$(read_version "$(pkg_dir "$ONLY")/package.json")
	if [ "$distinct_count" != "1" ]; then
		ok "publishing only @dforge-core/$ONLY@$TARGET_VERSION (other packages stay at their current versions)"
	else
		ok "all packages at $TARGET_VERSION, publishing only @dforge-core/$ONLY"
	fi
else
	if [ "$distinct_count" != "1" ]; then
		echo
		fail "versions diverge — pass --version X.Y.Z to align them, or --only <pkg> to publish just one"
	fi
	TARGET_VERSION=$(echo "$distinct" | head -1)
	ok "all packages at $TARGET_VERSION"
fi

# ── 4. npm auth (skipped for dry-run, skipped in CI) ─────────────────
# In CI the publish runs under a Trusted Publisher OIDC token, which has no
# user identity — `npm whoami` returns empty even though publishing works.
# So the check is local-only: a dev who forgot `npm login` gets a fast fail
# instead of a half-completed publish.
if [ "$DRY_RUN" -eq 0 ] && [ -z "${CI:-}" ]; then
	section "npm auth"
	if ! WHO=$(npm whoami 2>/dev/null); then
		echo "  ${C_RED}✗${C_OFF} not logged in — run: ${C_BOLD}npm login${C_OFF}"
		exit 1
	fi
	ok "logged in as $WHO"
fi

# ── 5. Publish order ─────────────────────────────────────────────────
if [ -n "$ONLY" ]; then
	PUBLISH_ORDER="$ONLY"
else
	PUBLISH_ORDER="$PLATFORM_PKGS $WRAPPER_PKG"
fi

publish_one() {
	local pkg="$1"; shift
	(
		cd "$(pkg_dir "$pkg")"
		pnpm publish --no-git-checks --access public --tag "$NPM_TAG" "$@" 2>&1
	)
}

section "Dry-run"
for pkg in $PUBLISH_ORDER; do
	echo "  ${C_DIM}→ @dforge-core/$pkg${C_OFF}"
	publish_one "$pkg" --dry-run \
		| grep -E "^npm notice 📦|^\+ @dforge-core|package size:|unpacked size:" \
		| sed 's/^/    /'
done

if [ "$DRY_RUN" -eq 1 ]; then
	section "Dry-run complete"
	echo "  Re-run without --dry-run to publish."
	exit 0
fi

# ── 6. Confirm ───────────────────────────────────────────────────────
section "Ready to publish"
echo "  Registry: https://registry.npmjs.org/"
echo "  Tag:      $NPM_TAG"
echo "  Access:   public"
echo "  Version:  $TARGET_VERSION"
if [ -n "$ONLY" ]; then
	echo "  Packages: 1 (@dforge-core/$ONLY)"
else
	echo "  Packages: 7 (1 wrapper + 6 platform binaries)"
fi
echo
echo "  ${C_DIM}Note: once published, $TARGET_VERSION is permanent.${C_OFF}"
echo "  ${C_DIM}npm allows unpublish within 72h of first publish, then the version is burned.${C_OFF}"
echo
if [ "$ASSUME_YES" -eq 0 ]; then
	printf "  Publish for real? [y/N] "
	read -r ans
	case "$ans" in
		y|Y|yes|YES) ;;
		*) echo "  Aborted."; exit 0 ;;
	esac
fi

# ── 7. Publish ───────────────────────────────────────────────────────
section "Publishing"
set --
if [ -n "$OTP" ]; then set -- "$@" --otp "$OTP"; fi
# Opt-in npm provenance: when this script runs in GitHub Actions with the
# id-token: write permission, --provenance adds a verifiable link from the
# npm package back to the workflow run that produced it. Outside CI the flag
# is a no-op (npm publish ignores it without the OIDC env), so safe to always
# pass.
set -- "$@" --provenance
for pkg in $PUBLISH_ORDER; do
	echo
	echo "  ${C_BOLD}→ @dforge-core/$pkg${C_OFF}"
	publish_one "$pkg" "$@" | sed 's/^/    /'
done

# ── 8. Verify ────────────────────────────────────────────────────────
section "Verifying against registry"
sleep 3
if [ -n "$ONLY" ]; then VERIFY_PKGS="$ONLY"; else VERIFY_PKGS="$ALL_PKGS"; fi
for pkg in $VERIFY_PKGS; do
	if found=$(npm view "@dforge-core/$pkg@$TARGET_VERSION" version 2>/dev/null) && [ -n "$found" ]; then
		ok "@dforge-core/$pkg@$found"
	else
		echo "  ${C_DIM}…${C_OFF} @dforge-core/$pkg — not visible yet (may take a moment)"
	fi
done

section "Done"
echo "  Try it: ${C_BOLD}npx -y @dforge-core/dforge-cli --version${C_OFF}"
echo "  If you used --tag next: ${C_BOLD}npx -y @dforge-core/dforge-cli@next --version${C_OFF}"
