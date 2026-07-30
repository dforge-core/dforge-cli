# Changelog

All notable changes to `@dforge-core/dforge-cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The CLI is a thin wrapper over native binaries built from `dForge-core`; each
release corresponds to a `cli-vX.Y.Z` tag in that repo. Because `pack`, `validate`
and `install` share the platform's module loader/installer, most CLI behaviour
changes ride along with the shared services — noted below per release.

## [0.2.9] — 2026-07-30

### Added

- **`old[field]` in event-trigger actions** — the triggering record's pre-mutation
  values. The trigger dispatcher already computed them for its `status_change`
  comparison and then dropped them before the action could look. Read-only, `null` on
  insert, checked against the entity's columns, and rejected for scheduled jobs (which
  have no triggering row). Async triggers persist the snapshot, so a queued action
  still sees pre-change values even though the worker runs after the row changed.
- **Two static checks at `pack` / `validate`** — `action DSL columns` validates every
  `[field]` an action reads or writes against its entity's columns (the treatment
  `params[x]` always had), covering reads, writes, ref-nav bases, `canExecute` and
  batch `x[field]`. `event triggers` rejects a trigger whose action isn't in the
  module, is bound to a different entity than the trigger watches, uses
  `executionMode: batch`, or carries a condition that won't parse or names a missing
  column. Both run after trait expansion, so a trait-contributed column like
  `[status]` isn't reported as a typo.
- **Bracketed ref navigation** — `[ref].[target]` is accepted alongside `[ref].target`.
  The bracketed form is what the DSL reference has always documented, but the compiler
  matched only the bare target, so it fell through and emitted valid-looking JS that
  died at run time. Multi-hop `[a].[b].[c]` is now a clear compile error (single-hop
  only, unlike formulas).
- **Formula functions** `ISNULL`, `NULLIF`, `MOD`, `LTRIM`, `RTRIM`, and the
  `CEILING` / `LENGTH` / `IIF` aliases the SQL translator already accepted — now
  implemented in both engines. `ISNULL` was documented but implemented in neither: it
  parsed, installed, and then threw once per record with the error swallowed, so a
  bool column read as empty on every row with nothing in any log.
- **Operator commands** (instance admins, not module authors): `tenant move` relocates
  a tenant's database to another cell, `tenant revoke-public-connect` backfills the
  removal of PUBLIC's implicit `CONNECT` on existing tenant databases, and a new
  `schema` command drives fleet-wide system-module rollout.

### Changed

- **Trigger install failures are errors, not warnings.** Previously a typo'd action
  code installed "successfully" with automation that never fired, and an unparseable
  condition installed as `NULL` — which makes the trigger fire on *every* matching
  event. Cross-module `module.action` references now resolve, too: the dotted string
  used to be matched against bare action codes and so never matched, and the fallback
  could bind to a same-named action in an unrelated module. Qualified references
  resolve within the named module, unqualified ones within the owner only.
- **Unsupported trigger conditions are rejected at `pack` and `install`.** The trigger
  evaluator is a small fail-closed AST walker with no DB connection, so
  `[status] IN ('ready')` — a perfectly valid formula — used to install and then
  evaluate false forever. The supported set (`AND` / `OR` / `NOT` plus the six scalar
  comparisons) is now a single authority both the evaluator and install read from, so
  the two can't drift; navigation inside a condition is rejected with its own message
  pointing at the fix.
- **The DSL targets physical tables.** `insert()`, `update()`, `delete()`,
  `getRecord()`, `[ref].target` navigation and the extraction-profile
  `lookupRef` / `matchCatalog` mappers all interpolated the entity code as the table
  name, so an entity with a `dbObject` override was unreachable. They resolve
  `db_object` now, and install writes `schema_name` / `db_object` for every entity.
- **Queued actions carry a resolved entity id.** `entity_cd` is unique only within a
  module, but the background worker matched queued jobs by bare code and rebuilt the
  table name from `module_cd` + `entity_cd` — so a job could read and write another
  module's table. Jobs now resolve by id alone, with no by-code branch to fall back to.
- **Unknown formula function names fail at install**, with a did-you-mean suggestion,
  rather than throwing once per record at render time.
- **Folder-scoped settings resolve in background actions.** The worker never set
  `FolderId`, so `getSetting()` in an async action skipped folder inheritance and used
  the module default. Note this is a behaviour change: folder-scoped settings now
  resolve differently in background actions than they did before.

### Fixed

- **Async delete triggers fire at all.** The row was already gone when the worker ran,
  so the load failed and the job was skipped; a delete now runs against the
  queue-time snapshot of the old values.
- **Formula parity between the client runtime and SQL** on the edge cases where one
  engine answered and the other raised: comparison no longer coerces via `Number()`
  (which read `''` as `0`, making `0 = ''` true); date comparisons work in `F` columns,
  where `TODAY() > [due_date]` used to compare `"Sat Jul 25 2026…"` against
  `"2026-01-15"` and was true for every row; bare `YYYY-MM-DD` parses as a local
  calendar date rather than UTC midnight, which had made `YEAR('2020-01-01')` return
  2019 west of Greenwich; `NUMBER()` accepts only what `::numeric` would; `POW` and
  `FROUND` guard float overflow; `ATANH`'s domain is open at ±1; `SUBSTRING` / `MID`
  swap reversed bounds; and `BOOLEAN` branches on `pg_typeof`, so the string `'0'` is
  true and the number `0` is false.
- **`CURRENT_USER_ID()`** resolves in ad-hoc query formulas.
- **Trigger documentation was wrong in two ways.** `dforge://schema/triggers` promised
  a runtime-injected `record_id` param that has never existed — declaring it compiled
  and was then never populated, trading a build error for a silent runtime failure —
  and carried an inverted "must NOT use `[field]`" note. Both copies now describe what
  the action actually receives, and the documented `async` default matches the
  registrar's behaviour (true).

_Corresponds to `cli-v0.2.9` in `dForge-core`. Previous release: 0.2.8 (2026-07-24)._

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
