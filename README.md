# @dforge-core/dforge-cli

Native CLI for authoring dForge modules: validate, pack, publish to the
marketplace, install to a running tenant.

## Install

```bash
npm install -g @dforge-core/dforge-cli
# or, no install:
npx @dforge-core/dforge-cli --help
```

npm picks the right platform binary via `optionalDependencies`. Supported:
macOS arm64/x64, Linux x64/arm64, Windows x64/arm64.

## Commands

```bash
# Scaffold a new module interactively (see `Scaffolding a new module` below).
dforge-cli init module ./my-module

# Package a module directory into a .dforge archive
dforge-cli module pack ./my-module                    # writes my-module-1.0.0.dforge in cwd
dforge-cli module pack ./my-module -o ./dist/         # writes ./dist/my-module-1.0.0.dforge
dforge-cli module pack ./my-module -o pkg.dforge      # writes ./pkg.dforge

# Publish a .dforge to the marketplace (org-scoped)
dforge-cli marketplace publish ./my-module-1.0.0.dforge --org acme

# Install a .dforge (or source directory) to a running tenant over HTTP.
# Manifest, FK targets, package-filter SQL, and migration safety are all
# validated server-side during install — first install of a fresh scaffold
# is the smoke test that catches anything wrong.
DFORGE_URL=https://app.example.com DFORGE_TOKEN=<jwt> \
	dforge-cli module install --path ./my-module-1.0.0.dforge

# DBML → module scaffold (stub — implementation lands in a follow-up)
dforge-cli dbml-import --from-dbml ./schema.dbml
```

## Scaffolding a new module

```bash
dforge-cli init module ./my-module
```

Walks you through an interactive setup and writes a fresh module that's
ready to `pack` and `install`.

### What it asks

| Prompt | Default | Notes |
|---|---|---|
| Module code | (none) | `^[a-z][a-z0-9_-]*$` — becomes the DB schema name and `module_cd` |
| Display name | titlecased `code` | shown in the UI |
| Description | (empty) | optional |
| Author name | `git config user.name` | optional |
| License | `MIT` | |
| Version | `0.1.0` | semver |
| DB schema version | `0.0.1` | bumped when you alter physical columns |
| Dependencies | `admin`, `metadata` | toggle which system modules you depend on |
| Preset | Minimal | see below |
| First entity name | (none) | `^[a-z][a-z0-9_]*$` — table/entity code |
| First entity label | titlecased name | display label |
| Traits | `identity + audit` | see below |

`moduleId` (the immutable UUID) is auto-generated with `crypto.randomUUID()` — no prompt.

### Presets

- **Minimal** — manifest + one entity + minimum UI (`data_views`, `folders`, `menus`, `actions`) + one admin role. ~8 files. Installs as-is; you add fields/views/roles from there.
- **Minimal + add more entities interactively** — same as Minimal, then loops to add additional entities (name + label + traits per entity) so you don't have to re-run.
- **Full template** — Minimal plus `settings.json`, `translations/en-US.json`, a `seed-data/01-<entity>.json` per entity, and a `logic/actions/` stub directory. Use this when you want the typical optional files scaffolded for you to fill in (or delete).

### Entity traits

The "traits" choice controls which built-in columns the entity gets for free — both rendered by the platform, no need to declare in `fields`:

- **identity only** — primary key only. Use for lookup tables that don't need audit columns.
- **identity + audit** (recommended) — primary key + `created_date` + `last_updated` + `created_by` + `last_updated_by`. Standard for any business entity.

You can change traits later by editing the entity JSON.

### After scaffold

```bash
cd ./my-module
dforge-cli module install --path . --code <tenant>   # full validation + install
```

The first install runs the full server-side validator (manifest, FK targets, package-filter SQL, migration safety) — fix anything it flags, then re-run.

## Auth

The remote `module install --url` and `marketplace publish` flows need a JWT
issued by the target dForge auth service. Three ways to provide one, in
precedence order:

1. `--token <jwt>` on the command line
2. `DFORGE_TOKEN` env var
3. **Browser sign-in** (recommended):
   ```bash
   dforge-cli auth login --url https://app.example.com         # for module install
   dforge-cli marketplace login --marketplace-url https://...  # for marketplace publish
   ```
   These open your browser to the tenant `/login` page, capture the OAuth
   callback on `http://127.0.0.1:51719`, exchange the one-time code, and
   **persist the resulting access token to disk** at:
   - `~/.dforge/auth/<sha256-of-url>.json` — for `module install` / `auth login`
   - `~/.dforge/marketplace/<sha256-of-url>.json` — for `marketplace login`

   Files are mode 0600 on Unix. One file per target URL so a developer who
   works against multiple environments (dev/staging/prod) stays signed in to
   all of them. Clear with `dforge-cli auth logout [--url X | --all]` or the
   marketplace equivalent. Inspect with `auth whoami` / `marketplace whoami`.

If you'd rather not write a token to disk, stick with `--token` /
`DFORGE_TOKEN` and the CLI won't touch `~/.dforge/`.

Optional `--code <tenantCd>` on `module install --url` is a sanity check: the
server verifies it matches the JWT's tenant and refuses with `TENANT_CODE_MISMATCH`
if not. Drop it if you trust the token.

## Why a native CLI

The validate/pack/install pipeline is the same code that runs on the dForge
server, packaged as a single-file binary per platform via `dotnet publish
--self-contained`. Avoids drift between author-time validation and server-side
install validation: same parser, same validators, same error messages.

## For maintainers

C# source lives in [`iash44/dForge-core`](https://github.com/iash44/dForge-core)
under `server/src/dForge.Cli/`. This repo only ships the npm wrapper + 6
platform sidecars. Release flow:

1. **Tag the source repo.** From a clean `main` in `iash44/dForge-core`:
   ```bash
   git checkout main && git pull
   git tag cli-v0.1.0                       # NOTE: prefix is cli-v, no `release/` etc.
   git push origin cli-v0.1.0
   ```
   The `cli-v*` tag triggers `.github/workflows/release-cli.yml`, which
   cross-compiles 6 binaries (3–4 min) and attaches them as assets to a
   GitHub Release at that tag. Watch:
   ```bash
   gh run watch --repo iash44/dForge-core
   gh release view cli-v0.1.0 --repo iash44/dForge-core   # should list 6 assets
   ```

2. **Publish to npm under `next`.** From anywhere (workflow runs in CI):
   ```bash
   gh workflow run publish.yml --repo dforge-core/dforge-cli \
     -f source_tag=cli-v0.1.0 \
     -f npm_version=0.1.0 \
     -f npm_tag=next
   ```
   `source_tag` is the source-repo git tag (with `cli-v` prefix);
   `npm_version` is the npm semver (no prefix). They don't have to match
   — pre-release suffixes are fine (`cli-v0.1.0-rc.1` → `0.1.0-rc.1`).

3. **Smoke test, then promote.**
   ```bash
   npx -y @dforge-core/dforge-cli@next --version   # exits 0, prints sha + build time
   ```
   If happy, promote the SAME version to `latest`:
   ```bash
   gh workflow run publish.yml --repo dforge-core/dforge-cli \
     -f source_tag=cli-v0.1.0 \
     -f npm_version=0.1.0 \
     -f npm_tag=latest
   ```
   This re-publishes (idempotent for the same `npm_version`) and moves
   the `latest` dist-tag. End users running `npm i -g @dforge-core/dforge-cli`
   now get this version.

**Choosing the version number.** `npm_version` is permanent once published
— npm only allows unpublish within 72h and burns the version slot forever
after. Use the `0.X.Y-rc.N` / `0.X.Y-test.N` pattern for shake-out runs
(`npm_tag=next`), and reserve plain `0.X.Y` for what you actually want
people to install (`npm_tag=latest`).

To test a freshly-built binary without going through the publish pipeline,
set `DFORGE_CLI_BINARY=/path/to/dforge-cli` and `node index.js` will exec
that path directly, skipping require.resolve and the sibling-packages
fallback.

### CI auth setup (non-obvious, easy to miss)

The `publish.yml` workflow uses two auth mechanisms that both have to be
configured outside the repo:

**1. npm Trusted Publisher — must be set up for ALL 7 package names**

OIDC publishing is configured per-package in the npm UI, not at the org
level. Each of these needs its own Trusted Publisher entry pointing at
`dforge-core/dforge-cli` / `publish.yml`:

- `@dforge-core/dforge-cli` (wrapper)
- `@dforge-core/dforge-cli-darwin-arm64`
- `@dforge-core/dforge-cli-darwin-x64`
- `@dforge-core/dforge-cli-linux-arm64`
- `@dforge-core/dforge-cli-linux-x64`
- `@dforge-core/dforge-cli-win32-arm64`
- `@dforge-core/dforge-cli-win32-x64`

Visit `npmjs.com/package/<name>/access` for each, scroll to **Trusted
Publisher**, click Add. Missing config produces a confusing **404** on
publish (npm returns 404 instead of 401 to avoid leaking package existence).

**2. `SOURCE_REPO_PAT` secret — private cross-owner read**

The source repo (`iash44/dForge-core`) is private and lives under a
different owner than this dist repo. The workflow-issued `GITHUB_TOKEN`
can't reach it. Create a fine-grained PAT with **Contents: Read** on
`iash44/dForge-core` and store it as a repo secret named exactly
`SOURCE_REPO_PAT`:

```bash
gh secret set SOURCE_REPO_PAT --repo dforge-core/dforge-cli
```

Fine-grained PATs can't be renewed — when it expires, regenerate and
re-run the `gh secret set` command.

### Workflow gotchas worth knowing

- **Node 24, not 22.** Node 22 ships npm 10.9.7, which doesn't support
  Trusted Publisher OIDC. `npm install -g npm@latest` on top of npm 10
  fails on Ubuntu runners with `Cannot find module 'promise-retry'`
  (arborist self-upgrade bug). Node 24 ships npm 11.x natively.
- **No `registry-url` in setup-node.** When set, it writes a `.npmrc`
  with `_authToken=${NODE_AUTH_TOKEN}`. With no `NODE_AUTH_TOKEN` env,
  the literal placeholder `XXXXX-XXXXX-XXXXX-XXXXX` ends up as the
  token, and npm uses it instead of falling back to OIDC. Default
  registry is npmjs.org anyway.
- **`npm publish`, not `pnpm publish`.** pnpm's OIDC Trusted Publisher
  support lags npm's. The script uses pnpm for everything else and only
  shells to `npm publish` for the actual upload.
