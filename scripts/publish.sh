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
# 2FA: --otp is optional. If npm asks for a one-time code (EOTP) the script
# prompts for one on the terminal and retries that package, reusing the code
# for the remaining packages and re-prompting if it expires mid-run. In CI
# there is no terminal, so --otp is still required there when 2FA is enforced.
#
# Sidecars publish FIRST so the wrapper's optionalDependencies all resolve
# the moment the wrapper hits the registry. The wrapper's optionalDependencies
# use literal versions (no `workspace:*` — this repo has no pnpm workspace);
# --version rewrites both the wrapper's "version" field AND every entry in
# its "optionalDependencies" block, keeping all 7 packages in lockstep.
#
# Promote-only mode: when --version is set and that version is already on
# the npm registry, the script auto-skips fetch/bump/publish and just runs
# `npm dist-tag add` to move the tag pointer (e.g. `next` → `latest`). This
# is the documented "second run promotes to latest" pattern. Pass
# --promote-only to force this path without the registry probe.
#
# Usage:
#   scripts/publish.sh --dry-run                                           # preflight + dry-run, no publish, no prompt
#   scripts/publish.sh --source-tag cli-v0.1.0-rc.2 --version 0.1.0-rc.2   # full flow
#   scripts/publish.sh --version 0.1.0-rc.3 --tag next                     # bump + publish under `next`
#   scripts/publish.sh --version 0.1.0-rc.3 --tag latest                   # auto-detects: promote-only (no republish)
#   scripts/publish.sh --version 0.1.0-rc.3 --tag latest --promote-only    # explicit promote
#   scripts/publish.sh --version 0.2.0 --tag latest --yes --otp 123456     # non-interactive (CI); locally the code is prompted for
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
PROMOTE_ONLY=0

usage() {
	grep -E "^#( |$)" "$0" | sed 's/^# \?//'
	exit 0
}

while [ $# -gt 0 ]; do
	case "$1" in
		--source-tag)   SOURCE_TAG="$2"; shift 2 ;;
		--dry-run)      DRY_RUN=1; shift ;;
		--version)      NEW_VERSION="$2"; shift 2 ;;
		--tag)          NPM_TAG="$2"; shift 2 ;;
		--otp)          OTP="$2"; shift 2 ;;
		--only)         ONLY="$2"; shift 2 ;;
		--yes)          ASSUME_YES=1; shift ;;
		--promote-only) PROMOTE_ONLY=1; shift ;;
		-h|--help)      usage ;;
		*)              echo "Unknown argument: $1" >&2; echo "See: $0 --help" >&2; exit 1 ;;
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

# ── 2FA one-time codes ───────────────────────────────────────────────
# npm asks for a 2FA code whenever the account (or the package) has 2FA
# enforced for writes. Passing --otp up front only works if you already know
# that and can type a code before its ~30s window closes — so instead every
# npm write runs first, and if npm answers EOTP we prompt on the terminal and
# retry. The code is cached in $OTP so the remaining packages reuse it inside
# its validity window; if it expires mid-run the next failure just prompts
# again. CI has no terminal, so there --otp (or a token without 2FA) is still
# the only way through, and a missing code fails with npm's own message.
NPM_LOG="$(mktemp "${TMPDIR:-/tmp}/dforge-publish.XXXXXX")"
trap 'rm -f "$NPM_LOG"' EXIT

otp_prompt_available() {
	[ -z "${CI:-}" ] && [ -e /dev/tty ]
}

# Does this npm failure output mean "give me a 2FA code"? Covers both the
# missing case (EOTP) and the wrong/expired case (E401 + "one-time password").
is_otp_error() {
	grep -qiE 'EOTP|one-time pass|otp[- ]?code|invalid (or expired )?otp' "$1"
}

# Reads a code from the controlling terminal (stdin may be a pipe). Echoes
# the code on stdout; empty means the user declined.
read_otp() {
	local code=""
	{
		echo
		echo "  ${C_BOLD}npm wants a 2FA one-time code${C_OFF} for $1"
		printf "  Code (leave blank to abort): "
	} > /dev/tty
	read -r code < /dev/tty
	printf '%s' "$code" | tr -d '[:space:]'
}

# JSON-aware version helpers (python3 instead of regex over sed — the
# optionalDependencies block contains version-like strings).
read_version() {
	python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["version"])' "$1"
}

write_version() {
	local pj="$1"; local v="$2"
	# ensure_ascii=False keeps non-ASCII chars (em-dashes, accented letters,
	# emoji) as literals instead of \uXXXX escapes — Python's default would
	# re-mangle a clean package.json on every publish.
	python3 -c '
import json,sys
p=sys.argv[1]; v=sys.argv[2]
d=json.load(open(p))
d["version"]=v
with open(p,"w",encoding="utf-8") as f: json.dump(d, f, indent="\t", ensure_ascii=False); f.write("\n")
' "$pj" "$v"
}

# Rewrite every entry in the wrapper's "optionalDependencies" matching the
# dforge-cli sidecar naming pattern to the given version. Required because
# the wrapper uses literal versions (this repo has no pnpm workspace), so a
# version bump has to keep the optionalDependencies in lockstep manually.
write_wrapper_optional_deps_version() {
	local pj="$1"; local v="$2"
	# See write_version above for the ensure_ascii=False rationale.
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
with open(p,"w",encoding="utf-8") as f: json.dump(d, f, indent="\t", ensure_ascii=False); f.write("\n")
' "$pj" "$v"
}

binary_name_for() {
	case "$1" in
		*win32*) echo dforge-cli.exe ;;
		*)       echo dforge-cli ;;
	esac
}

# ── 0a. Auto-detect "version already published" → switch to promote-only ──
# A second workflow run with the same --version but a different --tag is the
# documented promote pattern (publish as `next` first, then run again with
# --tag latest). `npm publish` rejects republishing the same version, so
# without this check the second run errors out. Detect early: if the wrapper
# version is already on the registry, skip fetch/bump/publish and just run
# `npm dist-tag add` to move the tag pointer. Explicit --promote-only also
# triggers this path without the version probe (useful when the registry
# query is slow or you know the answer).
if [ -n "$NEW_VERSION" ] && [ "$PROMOTE_ONLY" -eq 0 ]; then
	if npm view "@dforge-core/$WRAPPER_PKG@$NEW_VERSION" version >/dev/null 2>&1; then
		section "Detected $NEW_VERSION already on npm — switching to promote-only mode"
		echo "  (skipping fetch/bump/publish; will run npm dist-tag add → $NPM_TAG)"
		PROMOTE_ONLY=1
	fi
fi

# ── 0b. Promote-only short-circuit: change the dist-tag pointer, exit ────
# npm dist-tag uses a normal user/automation token (not Trusted Publisher
# OIDC), so this path needs $NODE_AUTH_TOKEN or an existing `npm login`.
# The workflow exports NPM_TOKEN when running promote-only.
if [ "$PROMOTE_ONLY" -eq 1 ]; then
	if [ -z "$NEW_VERSION" ]; then
		fail "--promote-only requires --version <X.Y.Z> (the version already on npm to point --tag at)"
	fi
	# `npm dist-tag add` authenticates with a normal token, NOT Trusted
	# Publisher OIDC. In CI the workflow only writes ~/.npmrc when the
	# NPM_PROMOTE_TOKEN secret is set — without it every dist-tag call 401s
	# with a confusing error. Fail up front with the actual fix instead.
	if [ "$DRY_RUN" -eq 0 ] && [ -n "${CI:-}" ] && ! grep -qs '_authToken' ~/.npmrc; then
		fail "promote needs an npm auth token, but none is configured. Add the NPM_PROMOTE_TOKEN repo secret to dforge-core/dforge-cli (a classic 'Automation' token with publish rights) — npm dist-tag does not go through the Trusted Publisher OIDC channel that initial publishes use."
	fi
	section "Promoting @dforge-core/* @ $NEW_VERSION → dist-tag '$NPM_TAG'"
	# Promote the wrapper + every sidecar so they stay aligned. `npm install -g`
	# only consults the wrapper's dist-tag (sidecars resolve via the wrapper's
	# pinned optionalDependencies), but tidiness keeps `npm view` results sane
	# and avoids "wait, why does this sidecar still say `next`?" confusion.
	# 2FA applies here too, not just to `npm publish`: an account with 2FA on
	# publish is asked for a code by dist-tag as well. Locally the EOTP retry
	# below prompts for it; in CI --otp is the only channel.
	for pkg in $ALL_PKGS; do
		printf "  → @dforge-core/%-34s " "$pkg"
		if [ "$DRY_RUN" -eq 1 ]; then
			echo "${C_DIM}(dry-run — would run: npm dist-tag add @dforge-core/$pkg@$NEW_VERSION $NPM_TAG)${C_OFF}"
			continue
		fi
		while :; do
			# shellcheck disable=SC2086  # word-splitting of the --otp pair is intentional
			if npm dist-tag add "@dforge-core/$pkg@$NEW_VERSION" "$NPM_TAG" ${OTP:+--otp $OTP} >"$NPM_LOG" 2>&1; then
				echo "${C_GREEN}✓${C_OFF}"
				break
			fi
			if is_otp_error "$NPM_LOG" && otp_prompt_available; then
				echo "${C_DIM}needs 2FA${C_OFF}"
				OTP=$(read_otp "@dforge-core/$pkg")
				[ -n "$OTP" ] || fail "promote aborted — no 2FA code entered"
				printf "  → @dforge-core/%-34s " "$pkg"
				continue
			fi
			echo "${C_RED}✗${C_OFF}"
			# npm's own message, not just a bare ✗. Swallowing it turned "needs a
			# 2FA code" (EOTP) into an unactionable failure.
			sed 's/^/      /' "$NPM_LOG" >&2
			fail "  npm dist-tag add failed for @dforge-core/$pkg@$NEW_VERSION"
		done
	done
	echo
	if [ "$DRY_RUN" -eq 1 ]; then
		ok "Promotion dry-run complete. Re-run without --dry-run to actually move the tag."
	else
		ok "Promotion complete. Verify: npm view @dforge-core/$WRAPPER_PKG dist-tags"
	fi
	exit 0
fi

# ── 0. Optional: fetch binaries from source-repo release ─────────────
if [ -n "$SOURCE_TAG" ]; then
	section "Fetching binaries from $SOURCE_TAG"
	"$SCRIPT_DIR/fetch-binaries.sh" "$SOURCE_TAG"
fi

# ── 0c. Generate the sidecar package.json from the platform table ────
# Sidecars are pure boilerplate (only name/os/cpu differ) so they're generated
# here rather than hand-maintained. The version is read back from the binary
# (or validated against --version when given); the resolved version flows into
# the wrapper bump + consistency check below.
NEW_VERSION="$("$SCRIPT_DIR/generate-sidecars.sh" ${NEW_VERSION:+--version "$NEW_VERSION"})"
ok "sidecars generated @ $NEW_VERSION"

# ── 1. Pre-flight ────────────────────────────────────────────────────
section "Pre-flight"
for pkg in $ALL_PKGS; do
	[ -f "$(pkg_dir "$pkg")/package.json" ] || fail "missing $pkg/package.json"
done
ok "all 7 package.json present"

# When --only restricts to the wrapper, no binaries are needed (the wrapper
# ships only dist/cli.js). When --only restricts to a specific sidecar, only
# that one's binary is needed. Full publish (no --only) requires all 6.
if [ -n "$ONLY" ]; then
	BIN_CHECK_PKGS=""
	case "$ONLY" in
		dforge-cli-*-*) BIN_CHECK_PKGS="$ONLY" ;;
		*) ;;  # wrapper: no binaries to check
	esac
else
	BIN_CHECK_PKGS="$PLATFORM_PKGS"
fi

if [ -z "$BIN_CHECK_PKGS" ]; then
	ok "wrapper-only publish — skipping binary check"
else
	missing_bins=0
	for pkg in $BIN_CHECK_PKGS; do
		bin=$(binary_name_for "$pkg")
		if [ ! -f "$(pkg_dir "$pkg")/bin/$bin" ]; then
			echo "  ${C_RED}✗${C_OFF} missing $pkg/bin/$bin"
			missing_bins=$((missing_bins+1))
		fi
	done
	if [ "$missing_bins" -gt 0 ]; then
		fail "$missing_bins binary file(s) missing — pass --source-tag <cli-vX.Y.Z> to fetch them"
	fi
	count=$(echo "$BIN_CHECK_PKGS" | wc -w | tr -d ' ')
	ok "$count platform binar$([ "$count" = "1" ] && echo "y" || echo "ies") present"
fi

# ── 2. Version bump ──────────────────────────────────────────────────
if [ -n "$NEW_VERSION" ]; then
	if [ -n "$ONLY" ]; then
		# Targeted publish: bump only the named package; leave the wrapper's
		# optionalDependencies untouched so it keeps pointing at whatever
		# sidecar versions are already on the registry.
		section "Bumping $ONLY to $NEW_VERSION"
		write_version "$(pkg_dir "$ONLY")/package.json" "$NEW_VERSION"
		ok "$ONLY → $NEW_VERSION"
	else
		section "Bumping all 7 packages to $NEW_VERSION"
		for pkg in $ALL_PKGS; do
			write_version "$(pkg_dir "$pkg")/package.json" "$NEW_VERSION"
			ok "$pkg → $NEW_VERSION"
		done
		write_wrapper_optional_deps_version "$(pkg_dir "$WRAPPER_PKG")/package.json" "$NEW_VERSION"
		ok "$WRAPPER_PKG optionalDependencies → $NEW_VERSION"
	fi
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
		# Use npm (not pnpm) for the actual publish so npm CLI's built-in
		# OIDC Trusted Publisher exchange kicks in. Requires npm >= 11.5.1
		# — the workflow upgrades npm explicitly before this script runs.
		npm publish --access public --tag "$NPM_TAG" "$@" 2>&1
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
PUBLISH_ARGS=""
# Opt-in npm provenance: when this script runs in GitHub Actions with the
# id-token: write permission, --provenance adds a verifiable link from the
# npm package back to the workflow run that produced it. npm 11+ errors out
# ("Automatic provenance generation not supported for provider: null") if
# --provenance is passed outside a recognised OIDC provider env, so only
# add it when we can actually exchange a token. ACTIONS_ID_TOKEN_REQUEST_URL
# is set whenever a workflow grants id-token: write — more precise than
# checking $CI alone.
if [ -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
	PUBLISH_ARGS="--provenance"
fi
for pkg in $PUBLISH_ORDER; do
	echo
	echo "  ${C_BOLD}→ @dforge-core/$pkg${C_OFF}"
	while :; do
		# tee keeps npm's progress streaming to the terminal while retaining a
		# copy to inspect for EOTP. pipefail makes npm's failure the pipeline's.
		# shellcheck disable=SC2086  # word-splitting of the arg strings is intentional
		if publish_one "$pkg" $PUBLISH_ARGS ${OTP:+--otp $OTP} | tee "$NPM_LOG" | sed 's/^/    /'; then
			break
		fi
		if is_otp_error "$NPM_LOG" && otp_prompt_available; then
			OTP=$(read_otp "@dforge-core/$pkg")
			[ -n "$OTP" ] || fail "publish aborted — no 2FA code entered"
			continue
		fi
		fail "npm publish failed for @dforge-core/$pkg"
	done
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
