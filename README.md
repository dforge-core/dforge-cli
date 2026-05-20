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
# STATIC checks: manifest identifiers, translation completeness, menu/folder/entity
# coverage, folder paths. DB-bound checks (FK target resolution, package-filter SQL,
# migration safety) only surface during `module install` against a live tenant —
# a clean `validate` does NOT guarantee a clean install.
dforge-cli module validate ./my-module
dforge-cli module validate ./my-module-1.0.0.dforge

# Package a module directory into a .dforge archive
dforge-cli module pack ./my-module                    # writes my-module-1.0.0.dforge in cwd
dforge-cli module pack ./my-module -o ./dist/         # writes ./dist/my-module-1.0.0.dforge
dforge-cli module pack ./my-module -o pkg.dforge      # writes ./pkg.dforge

# Publish a .dforge to the marketplace (org-scoped)
dforge-cli marketplace publish ./my-module-1.0.0.dforge --org acme

# Install a .dforge (or source directory) to a running tenant over HTTP
DFORGE_URL=https://app.example.com DFORGE_TOKEN=<jwt> \
	dforge-cli module install --path ./my-module-1.0.0.dforge

# DBML → module scaffold (stub — implementation lands in a follow-up)
dforge-cli dbml-import --from-dbml ./schema.dbml
```

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
