// Pure builder functions. No I/O. Each returns a plain object ready for
// JSON.stringify with tabs. Keeping these pure means the future MCP server
// can import them directly to generate manifest fragments on the fly.
import type {
	DataView,
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
		manifest.dependencies = Object.fromEntries(
			opts.dependencies.map((d) => [d, ">=0.0.1"]),
		);
	}

	return manifest;
}

export function buildEntity(entity: EntitySpec): Entity {
	const traits = entity.traits === "identity+audit"
		? ["identity", "audit"]
		: ["identity"];

	return {
		description: entity.label,
		dbObject: entity.name,
		toString: "{id}",
		traits,
		fields: {},
	};
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
	return {
		[opts.code]: {
			label: opts.displayName,
			description: opts.description || opts.displayName,
			icon: "bi-folder",
			color: "#2196F3",
			entities: Object.fromEntries(
				opts.entities.map((e) => [
					e.name,
					{ viewName: e.name, quickAdd: true },
				]),
			),
		},
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
): Record<string, string> {
	const t: Record<string, string> = {};
	t[`module.${opts.code}.label`] = opts.displayName;
	if (opts.description) t[`module.${opts.code}.description`] = opts.description;
	for (const e of opts.entities) {
		t[`entity.${e.name}.label`] = e.label;
		t[`view.${e.name}.label`] = e.label;
		t[`menu.${e.name}.label`] = e.label;
	}
	return t;
}

export function buildSeedData(): unknown[] {
	return [];
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
	{ fileMatch: ["security/roles.json"], schema: "roles" },
	{ fileMatch: ["logic/jobs.json"], schema: "jobs" },
	{ fileMatch: ["seed-data/*.json"], schema: "seed-data" },
	{ fileMatch: ["settings.json"], schema: "settings" },
];

export function buildVscodeSettings(): Record<string, unknown> {
	return {
		"json.schemas": SCHEMA_BINDINGS.map((b) => ({
			fileMatch: b.fileMatch,
			url: `${SCHEMA_BASE}/${b.schema}.schema.json`,
		})),
	};
}

export function buildZedSettings(): Record<string, unknown> {
	// Zed uses the same `json.schemas` key under a top-level `languages.JSON`
	// block per its settings schema. Both editors honour the file from their
	// project-local config dir without prompting.
	return {
		languages: {
			JSON: {
				"json.schemas": SCHEMA_BINDINGS.map((b) => ({
					fileMatch: b.fileMatch,
					url: `${SCHEMA_BASE}/${b.schema}.schema.json`,
				})),
			},
		},
	};
}
