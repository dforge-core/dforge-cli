# Changelog

All notable changes to `@dforge-core/dforge-cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The CLI is a thin wrapper over native binaries built from `dForge-core`; each
release corresponds to a `cli-vX.Y.Z` tag in that repo. Because `pack`, `validate`
and `install` share the platform's module loader/installer, most CLI behaviour
changes ride along with the shared services — noted below per release.

## [0.2.8] — 2026-07-24

### Added

- **Column domains** — modules may ship a `domains.json` declaring reusable, named
  field types (base datatype + control + sizing + shared option list). A column
  references one via `"domain": "module_cd.domain_cd"` instead of restating its type.
  `pack` / `validate` / `install` understand the new file and the `domain` field;
  install materializes the domain's structural fields onto each column and rejects a
  column that both names a `domain` and restates a field the domain owns. Unknown or
  cross-module-undeclared domains fail with an actionable message.
- **Document extraction built-ins** compiled by the install compiler:
  - `ocrExtract(fileField, endpointBaseUrl, schema, { mode: 'extract' })` — v2
    schema-driven extraction (v1 raw-bundle call still supported when `schema` is
    omitted); and the profile form `ocrExtract(..., null, { profile: 'module_cd.profile_cd' })`.
  - `detectDocument(rawText)` — scores a module's `logic/extraction_profiles.json`
    `detect` rules and returns `{ profile, docType, score }` or `null`.
  - Modules may ship `logic/extraction_profiles.json`; `pack`/`install` register the
    profiles, and removed profiles are reaped on upgrade.
- **`select()` DSL built-in** — structured multi-row reads for actions
  (`select(entity, { columns, filter, orderBy, limit })`), compiled and validated at
  install alongside the existing `insert`/`update`/`delete`/`query`.

### Changed

- **Dropdown option localization compiles through** — per-option labels (and domain
  option labels) authored under `translations/<locale>.json` (`fields.<col>.options`
  / `domains.<code>.options`) are carried through pack/install; the shared list on a
  column domain is translated once for every consuming column.
- **`getRecord()`** now returns dot-accessible rows and throws a localized not-found
  error (use `getRecordOrNull` for the nullable form); DSL constraint violations
  (insert/update) are localized.
- **Login UX** — `auth login` now shows the workspace name when prompting to grant
  access and confirms the granted workspace on success.

### Fixed

- **Stricter install validation** (fail at pack/validate/install rather than at
  runtime): set-aggregates (`SUM([set].[col])`) are rejected in Formula (`F`) columns
  — use a Generated (`G`) column; data views over an entity with no visible column are
  rejected; non-object folder/view/report/query filters are rejected.
- **Module scaffolding** emits nested `translations/<locale>.json` matching the
  runtime format and supports check-constraint messages.

_Corresponds to `cli-v0.2.8` in `dForge-core`. Previous release: 0.2.7 (2026-07-14)._
