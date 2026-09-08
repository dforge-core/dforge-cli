export type Preset = "minimal" | "minimal-plus" | "full";
export type Traits = "identity" | "identity+audit";

export interface ConstraintSpec {
	name: string;                       // constraint code, e.g. "chk_qty_positive"
	type?: "check" | "unique";
	expression?: string;                // for check constraints
	fields?: string[];                  // for unique constraints
	message: string;                    // base (en-US) violation message — localizable
}

export interface EntitySpec {
	name: string;
	label: string;
	traits: Traits;
	// Optional check/unique constraints. When present, buildEntity emits them
	// into the entity JSON and buildTranslations emits a localizable
	// `constraints.<name>.message` under the entity (opt-in localization).
	constraints?: ConstraintSpec[];
}

/**
 * One declared dependency. `entities` is what the module consumes from it and
 * is never empty: the platform requires a deps/<module>.json contract naming at
 * least one entity for every manifest dependency, so a dependency we cannot
 * name an entity for is one we must not scaffold.
 */
export interface DependencySpec {
	module: string;
	entities: string[];
}

export interface ScaffoldOpts {
	path: string;          // absolute destination directory
	code: string;
	displayName: string;
	description: string;
	author: string;
	license: string;
	version: string;
	dbSchemaVersion: string;
	/**
	 * Accepts bare module codes too: @dforge-core/dforge-mcp calls these builders
	 * across a caret range and older published versions still pass string[].
	 */
	dependencies: Array<DependencySpec | string>;
	preset: Preset;
	entities: EntitySpec[]; // at least one
}

// Manifest shape — kept loose (Record) for any-fields, with required
// fields explicit so the type system flags missing ones in builders.
export interface Manifest {
	packageFormat: number;
	moduleId: string;
	code: string;
	version: string;
	dbSchemaVersion: string;
	displayName: string;
	description?: string;
	author?: { name: string };
	license?: string;
	/**
	 * Either a bare semver range or the object form that narrows the dependency
	 * to named entities. The scaffolder always writes the object form, since it
	 * only declares a dependency whose consumed entities it knows.
	 */
	dependencies?: Record<string, string | { version: string; entities: string[] }>;
	entities: Record<string, string>;
	created?: string;
	updated?: string;
}

export interface Entity {
	description: string;
	dbObject: string;
	toString: string;
	traits: string[];
	fields: Record<string, unknown>;
	constraints?: Record<string, unknown>;
}

export interface DataView {
	viewType: string;
	label: string;
	dataSources: Array<{
		entityCode: string;
		columns: string[];
	}>;
}
