// Pure builder functions. No I/O. Each returns a plain object ready for
// JSON.stringify with tabs. Keeping these pure means the future MCP server
// can import them directly to generate manifest fragments on the fly.
import type {
	DataView,
	DependencySpec,
	Entity,
	EntitySpec,
	Manifest,
	ScaffoldOpts,
} from "./types";

export function buildManifest(opts: ScaffoldOpts, moduleId: string): Manifest {
	const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

	const manifest: Manifest = {
		packageFormat: 1,
		moduleId,
		code: opts.code,
		version: opts.version,
		dbSchemaVersion: opts.dbSchemaVersion,
		displayName: opts.displayName,
		entities: Object.fromEntries(
			opts.entities.map((e) => [e.name, `./entities/${e.name}.json`]),
		),
		created: today,
		updated: today,
	};

	if (opts.description) manifest.description = opts.description;
	if (opts.author) manifest.author = { name: opts.author };
	if (opts.license) manifest.license = opts.license;
	if (opts.dependencies.length > 0) {
		// `dependencies` used to be a bare string[] of module codes, and
		// @dforge-core/dforge-mcp consumes these builders across a caret range —
		// so a published MCP still passing the old shape must not emit
		// `{"undefined": …}` into a manifest. A legacy entry keeps the legacy
		// output (a plain range, no contract to match it); the current shape gets
		// the object form the contract is written against.
		manifest.dependencies = Object.fromEntries(
			opts.dependencies.map((d) =>
				typeof d === "string"
					? [d, DEPENDENCY_RANGE]
					: [d.module, { version: DEPENDENCY_RANGE, entities: d.entities }],
			),
		);
	}

	return manifest;
}

/** Range written for a scaffolded dependency, in the manifest and its contract alike. */
export const DEPENDENCY_RANGE = ">=0.0.1";

/**
 * The deps/<module>.json contract that every manifest dependency requires —
 * without it the module fails `module validate`, `module pack` and install.
 * `pk` follows the identity trait's `<entity>_id`, and `use` is a placeholder
 * naming this module: both are starting points the author has to correct, which
 * is what the post-scaffold note says.
 */
export function buildDepsContract(
	dep: DependencySpec,
	consumerCode: string,
): Record<string, unknown> {
	return {
		module: dep.module,
		version: DEPENDENCY_RANGE,
		entities: Object.fromEntries(
			dep.entities.map((e) => [
				e,
				{ pk: `${e}_id`, use: [`ref:${consumerCode}`] },
			]),
		),
	};
}

/**
 * The one field every scaffolded entity gets: a visible, editable, mandatory
 * label column. It is what `toString` interpolates and what the entity's grid
 * renders.
 */
export const NAME_FIELD = "name";

export function buildEntity(entity: EntitySpec): Entity {
	const traits = entity.traits === "identity+audit"
		? ["identity", "audit"]
		: ["identity"];

	const built: Entity = {
		description: entity.label,
		dbObject: entity.name,
		// The traits only add a PK and audit stamps, so an entity with no fields
		// of its own has nothing renderable: its grid view fails the data-view
		// column check and `toString` has nothing to interpolate. Scaffold one
		// visible name column so the module validates and the grid shows a row.
		toString: `{${NAME_FIELD}}`,
		traits,
		fields: {
			[NAME_FIELD]: {
				dbDatatype: "varchar",
				fieldTypeCd: "text",
				flags: "VEM",
				maxLen: 200,
				orderNum: 10,
				description: "Name",
			},
		},
	};

	if (entity.constraints?.length) {
		built.constraints = Object.fromEntries(
			entity.constraints.map((c) => {
				const def: Record<string, unknown> = { type: c.type ?? "check" };
				if (c.expression !== undefined) def.expression = c.expression;
				if (c.fields !== undefined) def.fields = c.fields;
				// The `message` is the base (en-US) text; a per-locale override in
				// translations/<locale>.json localizes it.
				def.message = c.message;
				return [c.name, def];
			}),
		);
	}

	return built;
}

export function buildDataViews(
	entities: EntitySpec[],
): Record<string, DataView> {
	const views: Record<string, DataView> = {};
	for (const e of entities) {
		views[e.name] = {
			viewType: "grid",
			label: e.label,
			dataSources: [
				{
					entityCode: e.name,
					columns: [],
				},
			],
		};
	}
	return views;
}

export function buildFolders(opts: ScaffoldOpts): Record<string, unknown> {
	// folders.json IS the root folder directly (not a map keyed by code).
	// Matches real-module convention — see folders.schema.json.
	return {
		label: opts.displayName,
		description: opts.description || opts.displayName,
		icon: "bi-folder",
		color: "#2196F3",
		entities: Object.fromEntries(
			opts.entities.map((e) => [
				e.name,
				{ viewName: "default", quickAdd: true },
			]),
		),
	};
}

export function buildMenus(opts: ScaffoldOpts): Record<string, unknown> {
	// Schema (and real modules — chore, crm, pm) use `items` keyed by item
	// code, NOT `children` at the top level. Each item carries its own
	// `orderNum` (required) and may have nested `children` later.
	return {
		[`${opts.code}_menu`]: {
			label: opts.displayName,
			items: Object.fromEntries(
				opts.entities.map((e, idx) => [
					e.name,
					{
						itemType: "V",
						label: e.label,
						dataViewCode: e.name,
						orderNum: idx + 1,
						icon: "table",
					},
				]),
			),
		},
	};
}

export function buildRoles(opts: ScaffoldOpts): Record<string, unknown> {
	const rights: Record<string, string> = {};
	for (const e of opts.entities) rights[e.name] = "SIUDC";
	return {
		[`${opts.code}.admin`]: {
			description: `${opts.displayName} administrators`,
			rights,
		},
	};
}

export function buildActions(): Record<string, unknown> {
	return {};
}

export function buildSettings(): Record<string, unknown> {
	return {};
}

export function buildTranslations(
	opts: ScaffoldOpts,
): Record<string, unknown> {
	// The runtime TranslationRegistrar reads the NESTED structure — entities
	// (+ nested fields / constraints), folders, roles, views, menus. Emitting the
	// flat `entity.<x>.label` shape (older scaffold) meant labels were never
	// applied. Mirror the shape real modules ship (see docs `translations.md`).
	const entities: Record<string, unknown> = {};
	for (const e of opts.entities) {
		const fields: Record<string, unknown> = {
			// identity trait → primary key column
			[`${e.name}_id`]: { label: `${e.label} ID` },
			[NAME_FIELD]: { label: "Name" },
		};
		if (e.traits === "identity+audit") {
			// audit trait → timestamp columns (see @dforge-core/metadata traits)
			fields.created_date = { label: "Created Date" };
			fields.last_updated = { label: "Last Updated" };
		}

		const entityEntry: Record<string, unknown> = { label: e.label };
		if (opts.description && opts.entities.length === 1) {
			// Single-entity modules: reuse the module description as the entity desc
			// so authors see where desc goes; multi-entity modules leave it blank.
			entityEntry.desc = opts.description;
		}
		entityEntry.fields = fields;

		// Localizable check/unique constraint violation messages (opt-in). The
		// message here is the en-US base; add per-locale overrides in the other
		// translations/<locale>.json files to localize.
		if (e.constraints?.length) {
			entityEntry.constraints = Object.fromEntries(
				e.constraints.map((c) => [c.name, { message: c.message }]),
			);
		}

		entities[e.name] = entityEntry;
	}

	return {
		entities,
		folders: {
			// folders.json root folder key is the module code (see buildFolders).
			[opts.code]: { label: opts.displayName },
		},
		roles: {
			// Role labels are completeness-enforced in every locale incl. en-US.
			[`${opts.code}.admin`]: { label: `${opts.displayName} Administrator` },
		},
		views: Object.fromEntries(
			opts.entities.map((e) => [e.name, { label: e.label }]),
		),
		menus: {
			[`${opts.code}_menu`]: {
				label: opts.displayName,
				items: Object.fromEntries(
					opts.entities.map((e) => [e.name, { label: e.label }]),
				),
			},
		},
	};
}

/**
 * A seed file is an OBJECT ({ entityCode, records }), not a bare array — a bare
 * array fails to deserialize and takes `module validate` down with it. Ships
 * with no records: seeding needs explicit PKs, which only the author can pick.
 */
export function buildSeedData(
	entity?: EntitySpec | string,
): Record<string, unknown> {
	// Optional for the same cross-package reason as buildManifest's dependency
	// shape: a published MCP calls this with no argument. An empty entityCode
	// fails the install with a precise message, which beats the bare array that
	// used to take the whole validator down on a parse error.
	const entityCode = typeof entity === "string" ? entity : (entity?.name ?? "");
	return { entityCode, records: [] };
}

export function buildGitignore(): string {
	return [
		"# Built module package archives",
		"*.dforge",
		"",
		"# Editor / OS noise",
		"node_modules/",
		".DS_Store",
		"*.swp",
		"",
	].join("\n");
}

// Editor settings binding each module file pattern to its JSON Schema. The
// schemas live in the @dforge-core/dforge-mcp npm package; jsdelivr serves
// them at a stable URL so VS Code / Zed / Cursor / IntelliJ / neovim all
// resolve them without any per-user setup.
//
// @latest follows the npm dist-tag, so the schemas auto-update when
// dforge-mcp is republished. @0 would be safer (locks to major) but
// npm semver excludes prereleases from bare ranges, so it doesn't
// resolve while we're still on 0.1.0-rc.* — switch to @0 once the
// first non-prerelease lands.
const SCHEMA_BASE =
	"https://cdn.jsdelivr.net/npm/@dforge-core/dforge-mcp@latest/resources/schemas";

// File-pattern → schema-name mappings. Same map for both editors; the
// wrapping object shape is what differs.
const SCHEMA_BINDINGS: Array<{ fileMatch: string[]; schema: string }> = [
	{ fileMatch: ["manifest.json"], schema: "manifest" },
	{ fileMatch: ["entities/*.json"], schema: "entity" },
	{ fileMatch: ["ui/data_views.json"], schema: "data-views" },
	{ fileMatch: ["ui/folders.json"], schema: "folders" },
	{ fileMatch: ["ui/menus.json"], schema: "menus" },
	{ fileMatch: ["ui/reports.json"], schema: "reports" },
	{ fileMatch: ["ui/print_templates.json"], schema: "print-templates" },
	{ fileMatch: ["security/roles.json"], schema: "roles" },
	{ fileMatch: ["logic/jobs.json"], schema: "jobs" },
	{ fileMatch: ["logic/triggers.json"], schema: "triggers" },
	{ fileMatch: ["logic/webhooks.json"], schema: "webhooks" },
	{ fileMatch: ["deps/*.json"], schema: "deps" },
	{ fileMatch: ["seed-data/*.json"], schema: "seed-data" },
	{ fileMatch: ["settings.json"], schema: "settings" },
];

function schemaEntries(): Array<{ fileMatch: string[]; url: string }> {
	return SCHEMA_BINDINGS.map((b) => ({
		fileMatch: b.fileMatch,
		url: `${SCHEMA_BASE}/${b.schema}.schema.json`,
	}));
}

export function buildVscodeSettings(): Record<string, unknown> {
	return { "json.schemas": schemaEntries() };
}

// Zed reaches its JSON schema support through the language server, not a
// top-level key: the mappings have to sit where vscode-json-languageservice
// reads them, i.e. lsp.json-language-server.settings.json.schemas. A
// `languages.JSON` block (the shape this used to emit) is silently ignored —
// `languages.*` only accepts editor settings like tab_size.
//
// `context_servers` registers the dForge MCP server for Zed's agent panel,
// the same wiring `.mcp.json` gives Claude Code.
export function buildZedSettings(): Record<string, unknown> {
	return {
		lsp: {
			"json-language-server": {
				settings: { json: { schemas: schemaEntries() } },
			},
		},
		context_servers: {
			dforge: {
				source: "custom",
				command: "npx",
				args: ["-y", "@dforge-core/dforge-mcp@latest"],
				env: {},
			},
		},
	};
}

// Zed has no extension API for commands, so the module dev loop ships as
// project-local tasks instead (`task: spawn`). Mirrors the dForge VS Code
// extension's palette commands, minus the ones that need a picker UI —
// the tenant URL comes from $DFORGE_URL (edit the env block below) rather
// than a quick-pick. Schema validation is deliberately absent: the dForge
// language server reports it live, and the CLI has no `module validate`.
export function buildZedTasks(): unknown[] {
	const CLI = "npx";
	const CLI_ARGS = ["-y", "@dforge-core/dforge-cli@latest"];
	const DEFAULT_TENANT = "http://localhost:5179";

	const task = (label: string, args: string[]) => ({
		label: `dForge: ${label}`,
		command: CLI,
		args: [...CLI_ARGS, ...args],
		cwd: "$ZED_WORKTREE_ROOT",
		env: { DFORGE_URL: DEFAULT_TENANT },
		use_new_terminal: false,
		allow_concurrent_runs: false,
		reveal: "always",
	});

	return [
		task("Pack module", ["module", "pack", "$ZED_WORKTREE_ROOT"]),
		// --force matches the extension's dev-loop default: without it the CLI
		// skips the reinstall when the version hasn't changed and your edits
		// silently never reach the tenant.
		task("Install module to tenant", [
			"module",
			"install",
			"--path",
			"$ZED_WORKTREE_ROOT",
			"--url",
			"$DFORGE_URL",
			"--force",
		]),
		task("Sign in to tenant", [
			"auth",
			"login",
			"--url",
			"$DFORGE_URL",
			"--login-url",
			"$DFORGE_URL",
		]),
		task("Show signed-in user", ["auth", "whoami", "--url", "$DFORGE_URL"]),
		task("List installed modules", ["module", "list", "--url", "$DFORGE_URL"]),
	];
}
