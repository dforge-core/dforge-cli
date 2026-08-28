# Changelog

All notable changes to `@dforge-core/dforge-cli` are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The CLI is a thin wrapper over native binaries built from `dForge-core`; each
release corresponds to a `cli-vX.Y.Z` tag in that repo. Because `pack`, `validate`
and `install` share the platform's module loader/installer, most CLI behaviour
changes ride along with the shared services — noted below per release.

## [0.2.16] — 2026-08-28

### Added

- **Roll-up (`G`) columns are maintained by the database, on every write path.** A
  Generated column whose formula is a set aggregate installs as a trigger on the
  child table:

  ```jsonc
  "reserved_qty": {
      "columnType": "G",
      "dbDatatype": "numeric(18,2)",
      "fieldTypeCd": "number",
      "flags": "V",
      "formula": "SUM([reservations].[active_qty])"
  }
  ```

  The generator was already emitting these; this release makes them correct under
  everything that actually happens to a parent row:

  - **Composite keys.** The parent side used to be addressed by the first PK column,
    so a two-column key updated every row sharing the first component. Both sides now
    pair column for column off the set link's declared keys, and a composite key whose
    link does not name `thisKey` is skipped with a warning instead of being paired
    against the parent's field-declaration order — two independently authored sequences
    that emit a silently wrong tuple comparison when they disagree. A link whose halves
    do not pair column for column is skipped and named too.
  - **One trigger per link, not per table pair.** Two FKs from one child into the same
    parent (`task.creator_id`, `task.approver_id` → `employee`) produced one trigger
    name: the second `CREATE OR REPLACE` took over the first's body and one roll-up went
    permanently stale, silently. Colliding names now fall back to a hash of the full link
    identity, names a previous install may have created are dropped, and a name that is
    already unique is left alone so an upgrade doesn't orphan a working trigger.
  - **Concurrency.** The recompute locks its parents `FOR NO KEY UPDATE` in a separate,
    ordered statement before the `UPDATE` — under READ COMMITTED a lone
    `SET col = (SELECT SUM(…))` re-reads only the row it updates and stores a partial sum
    when a sibling child commits underneath it. `FOR NO KEY UPDATE` rather than
    `FOR UPDATE`, because the child's own FK holds `KEY SHARE` on the parent and would
    deadlock against the insert that fired the trigger.
  - **A parent that loses its last child is corrected too** (correlated subquery, not a
    `GROUP BY` join), and a child moved between parents recomputes both.
  - **Install re-derives every parent row**, once per parent rather than once per link, so
    a roll-up introduced on an existing tenant starts correct instead of starting at
    whatever the module's logic had last written.

  Together with a check constraint over the roll-up, an invariant the module's actions
  used to have to remember — "reserved never exceeds on hand" — is enforced by the
  database on the UI, API, DSL and raw-SQL paths alike.

- **`constraints` has a schema, and a check constraint can name the fields to
  highlight.**

  ```jsonc
  "chk_reserved_within_quantity": {
      "type": "check",
      "expression": "reserved_qty <= quantity",
      "fields": ["reserved_qty", "quantity"],
      "message": "Reservations cannot exceed the on-hand quantity"
  }
  ```

  `fields` on a `check` does not build the constraint — it travels with the violation so
  the client can point at the right inputs. The expression is never parsed for this: an
  identifier inside a string literal is indistinguishable from a column name. On a
  `unique` constraint `fields` **is** the key, and `expression` has no meaning.
  `@dforge-core/metadata` 0.0.22 ships the matching schema.

  Authoring note: a module's check constraint is added **without** `NOT VALID`, so an
  upgrade fails outright on a tenant that already holds rows violating it. Clean the data
  first — the install is a transaction, so nothing lands until it can.

- **`install` warns when a constraint spells its key columns `columns`.** `columns` is a
  deprecated alias for `fields`, read only on a `unique` constraint and only as a
  fallback; a `check` never reads it. The install still succeeds and the warning names
  the file to edit:

  ```
  ⚠ 1 constraint(s) declare key columns as "columns"; rename to "fields":
     entities/warehouse.json  →  constraints.UQ_warehouse_code.columns
  ```

- **`studio export` writes entity views.** Both exporters wrote fields and constraints
  and no `views`, while the folder export kept emitting `entities.<code>.viewName` — so
  an exported package named a view it did not contain, and reinstalling it dropped the
  folder back to the entity's **full** column set. Export now round-trips `entity_view`
  and `entity_v_column`, preserves empty overrides (`flags: ""` deliberately suppresses
  the entity-level value; only SQL NULL means "inherit"), and runs the installer's own
  validators over what it is about to write.

### Changed

- **A folder entity binding an entity view the entity does not declare now fails at
  `pack` / `validate`** (`FolderViewBindingValidator`, in the shared static phase), not
  only against a live tenant. Every published `parties` package was un-installable for
  exactly this reason.
- **New fail-loud rejections at `install`:**
  - a column code starting with `_` — the prefix is reserved for app URL parameters
    (`_layout`) and print-context keys (`_fmt`, `_raw`, `_color`, `_link`, `_today`,
    `_settings`);
  - an entity view that cannot be resolved, which used to fall back to the entity's full
    column set. Every entity-view failure now fails closed.
- **`M` works on an entity-view column override**, and view-name matching is
  case-insensitive. Installed views are wired into `folder_entity`.
- **Numeric field types no longer carry `min`/`max` defaults** (`metadata` 1.6.0).
  `field_type.def_params` shipped `{min: 0, max: 10000}` for `number`,
  `{min: 0, max: 1000000}` for `currency` and `{min: 0, max: 100}` for `percent`, and the
  client merges those *under* the column's own params before validating on save — so
  every plain `number` column in every module silently refused negatives and anything
  over 10000, with nothing in the column's own spec to explain it. A numeric column is
  bounded only when its own `params` say so. Fixes #947.
- **The developer capability is granted per user** — `"dForge"."user".is_dev`, set by a
  tenant admin, combined with tenant-admin status by the server.

### Fixed

- **A menu's `folders` array silently created zero folders**, leaving the module's menu
  attached nowhere.
- **A report dataset could bind to another module's entity of the same code.**
  `entity_cd` is not unique per tenant — three shipped modules declare `invoice` — so a
  dataset resolved by bare code could land on a stranger's table. Install resolves an
  entity code against the module that owns it; the same resolution now applies to
  reference columns.
- **A bridge module's Formula column installed with no AST.** The parse pass walked the
  module's own entities only, so a Formula contributed through the extension pattern was
  stored with its formula *text* and no `formula_parsed` — and every consumer reads the
  AST, so the column rendered blank everywhere with no install warning. Existing tenants
  need the bridge module reinstalled; there is nothing to migrate, the formula has to be
  parsed by the installer.
- **An action's params could not shrink to zero on upgrade.** Dropped param sets are now
  swept once per install pass and param-set ids deduped on insert.
- **Extension-column defaults are reconciled on upgrade** and no-op `DEFAULT` ALTERs are
  skipped — the "Script execution error: method is required." seen after an upgrade
  install.
- **A folder-owning module's installer roles are granted at its host folders**, not only
  at its own.
- **The "folder entity binds a view the entity does not declare" error names who can
  declare it**, so the fix is in the message.
- **A dependency contract no longer rejects a self-provided extension column** — a module
  extending its own entity was being asked to import from itself.

### System modules

Installing or upgrading with this CLI moves a tenant to:

| Module | manifest | dbSchemaVersion |
|---|---|---|
| `admin` | 1.16.1 | 1.16.1 |
| `metadata` | 1.6.0 | 1.6.0 |

`admin` 1.15.0 adds `"dForge"."user".is_dev` on tenants provisioned before it reached the
baseline; 1.16.0 drops the `ON DELETE SET NULL` FK on `audit.change_log.folder_id`
(deleting a folder erased the folder from its own audit rows, which is what decides who
may read them); 1.16.1 admits `source = 'S'` so module seed and demo-data loads stop
being labelled "direct SQL". `metadata` 1.5.1 corrects the in-database description of
`entity_column.flags` to the live vocabulary — `V`/`I`/`E`/`M`; the `O`/`G`/`S`/`F`/`X`/`W`
letters it used to list were never implemented and have no reader on either side of the
wire. `metadata` 1.6.0 drops the numeric `def_params` described above.

## [0.2.15] — 2026-08-17

Maintenance build; no authoring-surface change. Changelog entry added retroactively with
0.2.16.

### Fixed

- **A report param that reaches the write with no resolved `fieldTypeCd` fails the
  install** instead of storing a param with no control. `param.field_type_cd` is
  nullable, so the defaulting loop being reordered would have written NULL silently.
- Wording in the unrecognized-`manifest.features` rejection.

## [0.2.14] — 2026-08-13

### Added

- **`module validate` / `module pack` check record-report attachments.** A report
  in `ui/reports.json` can attach itself to an entity so it opens from a record,
  with the record's values feeding its parameters:

  ```jsonc
  "credit_check": {
      "entities": [
          { "entityCd": "parties.party", "params": { "customer_id": "party_id" }, "orderNum": 45 }
      ]
  }
  ```

  The installer has always rejected a malformed attachment, but only against a
  live tenant — so the loop was pack → publish → install → read the error. These
  checks need nothing but the package, and now run in the shared static-validation
  phase (`ReportAttachmentValidator`), which `validate`, `pack` and install's own
  static phase all go through:

  - a mapped parameter code that neither the report-level `parameters` block nor
    any dataset declares;
  - a source column the entity doesn't have, or one that is a set / formula /
    free-text / json column;
  - a source and target whose types aren't compatible (only `lookup`↔`number` and
    `date`↔`datetime` widen), so `{ "customer_id": "created_date" }` is an error
    rather than an empty result set at runtime;
  - two attachments to the same entity in one report — the unique key is
    `(entity, report)`, so the second silently overwrites the first's mapping;
  - a cross-module `entityCd` whose module isn't a declared dependency.

  Column-level checks run where the package owns the target entity; a
  cross-module target still falls through to install, which can resolve it. The
  allowlist and type rules are shared with the installer rather than restated, so
  a source `validate` accepts is never one `install` rejects.

- **Report parameters have a report-level home.** A parameter is report-scoped in
  the platform — the declaration is stored once per report
  (`report.param_set_id` → `param_set`), and `report.get` flattens per-dataset
  defaults report-wide before use — but the module loader had only ever read the
  per-dataset shorthand. A report-level `parameters` block was therefore dropped
  by the deserializer and the report installed with **no parameters at all**, its
  `@param` filters comparing against nothing.

  Both declaration sites are now legal and mean the same thing; the loader merges
  them into the report's single parameter set, **report level winning** on a code
  collision:

  ```jsonc
  "customer_statement": {
      "parameters": {
          "customer_id": { "label": "Customer", "fieldTypeCd": "lookup",
                           "params": { "link": { "entity": "parties.party" } }, "required": true }
      },
      "datasets": { "statement_invoices": { }, "statement_payments": { } }
  }
  ```

  Declare at report level when several datasets use the parameter — there is no
  meaningful dataset to attribute it to, which is why `module export` previously
  had to dump the whole set onto "the first dataset that had params".
  `datasets.<cd>.params` stays fully supported for a single-dataset parameter, and
  every module written before this keeps installing unchanged.

- **`reloadInterval`** (a report's auto-refresh, in seconds) is in the schema. It
  has always worked, but the report object is `additionalProperties: false`, so
  setting it was a validation error.

### Fixed

- **`module export` produced an unimportable `reports.json` when two datasets had
  parameter defaults.** Parameters were written onto one arbitrarily chosen
  dataset; the others kept `report_ds.params`' raw `{code: value}` map under
  `params`, where re-import expects a parameter *definition* per code. Parameters
  now export at report level, with each default folded into its definition, so a
  round-trip through export → install is faithful.

- **Two report-parameter spellings that were accepted and then ignored.** Unlike
  `parameters` these are simply misspellings of keys that already exist, so they
  are gone from the schema rather than implemented:

  - **`isRequired`** — the key is `required`; the parameter installed as optional.
  - **top-level `link`** on a lookup parameter — it belongs under `params`; the
    parameter installed with no autocomplete.

  Both are now flagged by `module validate` at either declaration site. Two shipped
  platform modules (`crm-fin`, `wms-fin`) were affected and have been corrected.

- **Report-level parameter labels are translation-checked.** The completeness
  validator collected parameter codes from datasets only, so a report-level
  parameter's `reports.<cd>.params.<cd>.label` would have gone unenforced. It now
  reads the same merged set the loader builds.

### System modules

Installing or upgrading with this CLI moves a tenant to:

| Module | manifest | dbSchemaVersion |
|---|---|---|
| `admin` | 1.13.0 | 1.13.0 |
| `metadata` | 1.5.0 | 1.4.0 |

`metadata` 1.4.0 adds `dForge.entity_report` (the record-report attachment table)
plus its `entity_report.json` metadata entity.

**A module attaching a report declares `"metadata": ">=1.5.0"`** — the *manifest*
column. Dependency ranges are checked against a module's `version`, never its
`dbSchemaVersion`, so quoting the migration's number (`>=1.4.0`) would be
satisfied by metadata 1.4.x, which has no `entity_report` table.

## [0.2.13] — 2026-08-10

### Added

- **Dropdown param options carry labels.** A `dropdown` action or report
  parameter had nowhere to put a per-choice label: `options=` deserialized to a
  `string[]`, so a code was the only thing that could be stored, and the
  translation reader only ever looked at `params.<cd>.label`. Every locale —
  English included — showed raw codes (`bank_transfer`, `cash`) in the parameter
  dialog, even though the same values read correctly once written onto the
  record. `options=` now takes the same `{value, label, icon, color}` shape an
  entity column stores:

  ```
  params:
      payment_method: dropdown options=[bank_transfer:Bank transfer, cash:Cash]
  ```

  The JSON object form works too. Bare `options=a,b,c` still yields plain
  strings, so nothing already installed changes. Per-locale overrides live under
  `actions.<cd>.params.<param_cd>.options` in the module's translation files (and
  the reports equivalent), merged at load.

- **A param can borrow a column domain.** `payment_method: domain payment_method`
  in the action DSL, or `"domain": "payment_method"` on a report param, points
  the parameter at a column domain instead of restating its list. A list shared
  with the column the value is eventually written to is now authored and
  translated once rather than twice and left to drift. Both bare (`payment_method`)
  and module-qualified (`fin.payment_method`) codes resolve. Install materializes
  only the domain's `fieldTypeCd` — a param has no storage — and the options plus
  their translations resolve through the FK, never copied onto the param.

### Changed

- **New fail-loud rejections at `pack` / `install`**, all naming the action or
  report param they came from:
  - a param declaring both `domain` and `fieldTypeCd` (the domain supplies the
    control, so the installer would otherwise have to pick a winner silently);
  - a `domain` that doesn't resolve, or resolves to a domain declaring no
    `fieldTypeCd`;
  - trailing constraints on a domain param, and a malformed
    `paramCd: domain <domainCd>` line;
  - an entry in `options=` that is neither a string nor an object with a
    non-empty `value` — an option that could never round-trip.
- **The domain reap guard names params too.** Removing a column domain that a
  param still references now fails the upgrade with the referencing param
  listed, the same way a referencing column already did.
- **A report param may omit `fieldTypeCd` entirely** — it installs as `text`
  (`ReportRegistrar.DefaultParamFieldTypeCd`). Only declaring *both* keys is
  rejected. `@dforge-core/metadata` 0.0.14 ships the matching schema and types.

### Fixed

- **`uninstall` left param rows behind.** `ModuleUninstaller` never deleted them,
  so a leftover param holding a domain blocked that domain's `DELETE` later in
  the same uninstall. Params, presets, sets and per-param resources are now
  cleaned up, guarded against implementations shared with another module.
- **Identity primary keys installed as nullable when a module used the `M` flag.**
  `M` is folded into `isNullable` by `MandatoryFlagNormalizer`, which deliberately
  skips identity columns — the user is never asked for one. So a definition that
  dropped its explicit `"isNullable": false` in favour of the flag installed its
  identity PK with `is_nullable` NULL, `EntityMetadata.IdentityColumns` (which
  required an explicit `false`) dropped it, and `data.insert` omitted the PK,
  killing the row on the `NOT NULL` a primary key implies. An omitted nullability
  now counts as required; only an explicit `isNullable: true` opts out.
- **`install-system` / `upgrade-system` now create `record_subscription`.** The
  table landed in `tenant-schema.sql` (fresh provisioning) and in the legacy
  `server/database/migrations/` directory, which has no runtime consumer — so
  every tenant provisioned before it was added had no table and
  `RecordWatchService` failed with `42P01` on every write. The admin
  system-module migration that was never written now exists (admin `1.13.0`).
- **Cyclic-hierarchy errors name the column that closed the loop.** The
  acyclic-guard trigger raises with PG's SCHEMA/TABLE/COLUMN fields alongside a
  dedicated SQLSTATE, so the failing reference column reaches the client instead
  of an entity-only "cannot be its own parent". The depth cap got its own
  SQLSTATE (`DF002`) so an over-deep-but-valid tree is no longer reported as a
  record parenting itself. Already-provisioned tenants get the new messages
  without a module bump.

### System modules

Installing or upgrading with this CLI moves a tenant to:

| Module | manifest | dbSchemaVersion |
|---|---|---|
| `admin` | 1.13.0 | 1.13.0 |
| `metadata` | 1.4.0 | 1.3.0 |

`metadata` 1.3.0 adds `dForge.param.domain_id` (FK → `column_domain`, partial
index); `admin` 1.13.0 adds `record_subscription`.

## [0.2.12] — 2026-08-07

### Changed

- **`install` now rejects a filter that uses an operator the runtime can't
  translate.** It used to accept one and the damage showed up later, silently:
  `FilterBuilder` drops a condition it can't translate and logs it, so the
  surviving query runs **wider** than what the module author wrote. For a data
  view that means rows the view was meant to hide; for a folder's `rowFilter` it
  means the row-level security that filter exists to enforce isn't being
  enforced. Nothing failed, so nothing prompted a second look. Install is the
  last point where this is still cheap to fix, so it is now fatal there.

  The operator set was never documented anywhere authoritative — the `o` field in
  the `data_views` / `reports` / `folders` schemas had no `enum`, and its
  description listed operators that **do not exist**: `isNull`, `isNotNull`,
  `neq`, `gt`, `gte`, `lt`, `lte`, `like`. Modules were written against that list.
  The real spellings for the ones most often invented:

  | Invented | Actual |
  |---|---|
  | `isNull` / `isNotNull` | `null` / `!null` |
  | `like` | `contains` (or `mask`) |
  | `neq`, `gt`, `gte`, `lt`, `lte` | `!=`, `>`, `>=`, `<`, `<=` |

  The rejection names the offending path, and for the common misspellings above
  it suggests the correct operator rather than only listing all valid ones.
  Checked everywhere a module can declare a filter: folder `rowFilter`, a data
  view's global `filter` and each `dataSources[].filter`, and both report query
  filter paths.

- **Group combinators (`g`) are validated the same way**, for the same reason: an
  unrecognized combinator fell back to AND at query time, quietly turning an OR
  group into an AND one. Valid: `and`, `or`, `!and`/`nAnd`, `!or`/`nOr`.

### Fixed

- **A dropped filter condition is now attributable.** The old warning named
  neither the entity nor which filter the condition came from, so it could mean a
  user typed something odd in a grid, a module ships a broken data view, or a
  folder's row-level-security filter isn't being applied — three very different
  problems, one unactionable line. Warnings now carry the entity and the filter's
  origin (`request`, `rowFilter`, or `filter` for DSL `select()` and internal
  queries). Diagnostics only — no change to the emitted SQL.

### Known gap

- `pack` and `validate` do **not** run the operator check — it lives in the
  install-time package validator, so a module with a bad operator packs and
  validates clean and only fails at `install`. The check needs no database, so it
  could move earlier; until it does, don't treat a green `validate` as proof the
  filters are sound. Editors are the earlier net in the meantime: the `o` `enum`
  shipped in `@dforge-core/metadata` 0.0.13, so a schema-aware editor flags an
  invented operator as you type it.

## [0.2.11] — 2026-08-06

### Added

- **`currentUserId()`** — a call-shaped way to read the acting user's id in
  `execute:`. `pack` / `validate` / `install` accept it alongside the bare
  `userId` identifier, which is unchanged and still works. It exists because
  `userId` was effectively undiscoverable: a bare identifier with no
  parentheses, documented in a single table row and absent from the reference
  an author actually reads, so reaching for a function was the natural move and
  every guess (`current_user_id()`, `CURRENT_USER_ID()`, `userId()`) failed.
  - `CURRENT_USER_ID()` is a **formula** function — valid in `canExecute:`,
    formula columns, filters and reports, and undefined in `execute:`, exactly
    like `TODAY()`/`NOW()` versus `now()`. That split is now documented rather
    than discovered.

### Changed

- **`userId()` — the value spelled as a call — is now a hard error at `pack`.**
  It previously passed `pack` *and* `install`: the compiler's bare-identifier
  rewrite fires with or without parentheses, so it became `__ctx.userId()`,
  which is syntactically valid JavaScript whose root identifier is a known
  global. Nothing rejected it and the action only failed the first time it ran,
  with `Property 'userId' of object is not a function` — a message naming
  neither the DSL line nor the fix. The error now names both working spellings:

  ```
  line 1: 'userId' is a value, not a function — write 'userId' without
  parentheses, or 'currentUserId()'
  ```

  Actions already installed from an older CLI are not recompiled, so the API
  translates the same failure at run time until they are re-packed.

### Fixed

- **System-module upgrades no longer print ~22 bogus orphan-column warnings.**
  Every `admin` / `metadata` version bump emitted ready-to-paste
  `ALTER TABLE ... DROP COLUMN` statements against columns the platform reads on
  every request — `entity_column.storage_table`, `user.is_dev`,
  `user.auth_user_id`, `sec_object.max_rights`,
  `webhook_subscription.condition_parsed`. The install itself succeeded, so the
  noise *was* the defect: 22 standing false positives that would bury a real
  orphan, and whose suggested DDL would have broken the tenant. The scan is now
  scoped to tables the running install actually generated, because a schema is
  not an ownership boundary for system modules — `admin` and `metadata` share
  the `dForge` schema.

### Note

The 64-bit id precision work in this release cycle (ids reach `execute:` as JS
BigInt and stay exact) lives in the **runtime engine**, not in the CLI's
dependency closure. It ships with the API, not with `pack` / `validate` /
`install`, and needs no CLI update.

## [0.2.10] — 2026-08-04

### Changed

- **The `M` (mandatory) column flag now means required.** It was documented as
  "mandatory" but read by nothing, so a column declared `"flags": "VEM"` installed
  nullable and saved empty. `pack` / `validate` / `install` now fold it into
  `isNullable: false` after trait expansion, and **declaring `M` alongside
  `"isNullable": true` is a hard error** naming the entity and every offending field
  — a contradiction only the author can resolve. `M` stays inert on virtual
  (`R`/`S`/`F`) and identity columns: a Reference is required when its hidden FK is,
  so the flag belongs on the FK.
- **`install` reconciles column nullability in both directions on upgrade.**
  Previously neither direction reached an existing table — `ADD COLUMN IF NOT EXISTS`
  no-ops on a column that is already there, and the only nullability statement emitted
  was `DROP NOT NULL`, and that only for an explicit `isNullable: true`. So adding `M`
  to a shipped field did nothing on tenants that already had the module (it worked on
  a fresh install, which goes through `CREATE TABLE`), and merely deleting `M` left
  the constraint standing, failing later inserts with a raw Postgres 23502.
  - **An upgrade now aborts when existing rows contradict a newly required column**,
    rolled back inside the install transaction, naming each column and its NULL row
    count — rather than committing a tenant whose API enforces a rule its data already
    breaks. Give the column a `params.serverDefault` and the install backfills it
    instead; where there are no NULL rows, which is the common case, the constraint
    lands silently.
  - Relaxing is unconditional and never fails, so removing `M` is always safe.
- **A required column with a `params.serverDefault` is no longer demanded of the
  caller** on insert, alongside `formula` and `numberSequence`. An `on: "update"`
  default still is — it does not fire on insert.

### Added

- **`server defaults` static check** at `pack` / `validate` — rejects a
  `params.serverDefault` whose `value` isn't `now()` / `currentUser()` or whose `on`
  isn't `insert` / `update` / `save`. The runtime reads that phase in two places (does
  the INSERT supply the value; must the caller), and both mapped an unrecognised phase
  to `insert`, so a typo silently picked a behaviour instead of failing the build.

### Fixed

- **`M` and `serverDefault` on a bridge module's extension columns were skipped
  entirely** — both passes walked only the schema's own entities, so an extension
  column never resolved its `M`, and a module consisting solely of extensions was not
  checked at all.
- **Column defaults no longer pass author-supplied `formula` text through to SQL.**
  A `bool` default returned the formula verbatim, and the string branch tested only
  that it started and ended with a quote — so `'a'; DROP TABLE t; --'` reached
  `CREATE`/`ALTER TABLE ... DEFAULT` intact. Both now emit a proven literal or no
  default at all.
- **`install-system` / `upgrade-system` carry the `metadata` system module at 1.3.2**,
  correcting three entity definitions that claimed `isNullable: false` on columns the
  physical schema deliberately leaves nullable (`print_template.entity_id` — a snippet
  has no entity; `saved_query.user_id` — module-owned queries have no user;
  `module_install_log.module_id` — `ON DELETE SET NULL`). They made the generic data
  API reject legitimate writes.

_Corresponds to `cli-v0.2.10` in `dForge-core`. Previous release: 0.2.9 (2026-07-30)._

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
