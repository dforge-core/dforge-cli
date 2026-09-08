import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import {
	validateCode,
	validateEntityName,
	validateNonEmpty,
	validateSemver,
	titlecase,
} from "./prompts";
import {
	buildManifest,
	buildEntity,
	buildDataViews,
	buildFolders,
	buildMenus,
	buildRoles,
	buildActions,
	buildSettings,
	buildTranslations,
	buildSeedData,
	buildGitignore,
	buildVscodeSettings,
	buildZedSettings,
	buildZedTasks,
	buildDepsContract,
} from "./templates";
import type { DependencySpec, EntitySpec, Preset, ScaffoldOpts, Traits } from "./types";

const CANCEL_EXIT = 130;

/**
 * Entry point for `dforge-cli init module <path>`.
 * Returns the process exit code.
 *
 * Runs interactively (clack prompts) ONLY when attached to a TTY and no
 * scaffold flags were given. Otherwise it's fully non-interactive, driven by
 * flags + defaults — so callers without a TTY (the VS Code extension, CI,
 * piped shells) never block on stdin that will never arrive. A non-TTY context
 * with no `--code` is a hard, fast error rather than an indefinite hang.
 */
export async function runInitModule(argv: string[]): Promise<number> {
	const args = parseArgs(argv);
	if (args.help) {
		printModuleHelp();
		return 0;
	}
	if (!args.path) {
		printModuleHelp();
		return 2;
	}
	const absPath = path.resolve(args.path);

	// Reject existing non-empty dirs upfront — before any prompts — so the
	// author doesn't sit through five minutes of questions to discover their
	// target dir is already populated.
	if (fs.existsSync(absPath)) {
		const stat = fs.statSync(absPath);
		if (!stat.isDirectory()) {
			console.error(`dforge-cli: ${absPath} exists and is not a directory.`);
			return 1;
		}
		if (fs.readdirSync(absPath).length > 0) {
			console.error(`dforge-cli: ${absPath} exists and is not empty.`);
			return 1;
		}
	}

	// Interactive only when we have a TTY to prompt on AND the caller didn't
	// already supply identity flags. `--code`, `--yes`, or "no TTY" all force
	// the non-interactive path so we never block on stdin that never arrives.
	const nonInteractive =
		args.yes || args.code !== undefined || !process.stdin.isTTY;

	let opts: ScaffoldOpts | null;
	if (nonInteractive) {
		if (args.code === undefined) {
			console.error(
				"dforge-cli init module: no TTY for interactive prompts and no --code given.\n" +
					"Pass --code <code> (plus optional --display-name, --entity, --preset, …) to scaffold\n" +
					"non-interactively, or run in a real terminal. See `dforge-cli init module --help`.",
			);
			return 2;
		}
		opts = buildOptsFromArgs(absPath, args);
		if (opts === null) return 1; // a validation error was already printed
		try {
			writeAll(opts);
		} catch (err) {
			console.error((err as Error).message);
			return 1;
		}
		console.log(`Created module ${opts.code} at ${opts.path}`);
	} else {
		p.intro("dforge-cli init module");
		opts = await collectOpts(absPath);
		if (opts === null) {
			p.cancel("Aborted.");
			return CANCEL_EXIT;
		}
		const s = p.spinner();
		s.start("Writing files");
		try {
			writeAll(opts);
			s.stop("Files written.");
		} catch (err) {
			s.stop("Write failed.");
			console.error((err as Error).message);
			return 1;
		}
		p.outro(`Created module ${opts.code} at ${opts.path}`);
	}

	// NOTE: post-scaffold validation is intentionally not run here. The C#
	// CLI's only validator (`studio validate`) needs a live tenant DB
	// connection, so it can't validate a freshly-scaffolded directory in
	// isolation. The first time the module is installed (`module install`),
	// the full validator runs and any drift between scaffold output and the
	// validator surfaces. A standalone schema-level validator on the JS
	// side is a future improvement.

	console.log("");
	if (opts.dependencies.length > 0) {
		// The contracts are written with a guessed pk and a placeholder provenance
		// token; both pass validation but are not yet true, so say so out loud.
		const files = opts.dependencies
			.map((d) => `deps/${typeof d === "string" ? d : d.module}.json`)
			.join(", ");
		console.log(`Wrote ${files}. Correct each entity's 'pk' against the provider and`);
		console.log("replace the placeholder 'use' token with the real usage before you pack.");
		console.log("");
	}
	console.log("Next steps:");
	console.log(`  cd ${path.relative(process.cwd(), opts.path) || "."}`);
	console.log(`  dforge-cli module install --path . --code <tenant>`);
	return 0;
}

/** Parsed `init module` invocation: positional path + scaffold flags. */
interface InitArgs {
	path?: string;
	code?: string;
	displayName?: string;
	description?: string;
	author?: string;
	license?: string;
	version?: string;
	dbSchemaVersion?: string;
	/** Raw `--dependencies` tokens, each `module:entity[+entity…]`. */
	dependencies?: string[];
	preset?: string;
	/** Entity names; each becomes one entity with default label + traits. */
	entities?: string[];
	traits?: string;
	yes?: boolean;
	help?: boolean;
}

/**
 * Minimal flag parser for `init module`. Supports `--flag value` and
 * `--flag=value`; `--entity` and `--dependencies` accept comma lists and/or
 * repetition. The first non-flag token is the target path.
 */
function parseArgs(argv: string[]): InitArgs {
	const out: InitArgs = {};
	const list = (prev: string[] | undefined, v: string): string[] => [
		...(prev ?? []),
		...v.split(",").map((s) => s.trim()).filter(Boolean),
	];

	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		if (tok === "--help" || tok === "-h") {
			out.help = true;
			continue;
		}
		if (tok === "--yes" || tok === "-y") {
			out.yes = true;
			continue;
		}
		if (!tok.startsWith("-")) {
			if (out.path === undefined) out.path = tok;
			continue;
		}
		// Normalize --flag=value into (flag, value); otherwise consume next token.
		const eq = tok.indexOf("=");
		const flag = eq === -1 ? tok : tok.slice(0, eq);
		const inlineVal = eq === -1 ? undefined : tok.slice(eq + 1);
		const value = (): string =>
			inlineVal !== undefined ? inlineVal : (argv[++i] ?? "");
		switch (flag) {
			case "--code": out.code = value(); break;
			case "--display-name":
			case "--name": out.displayName = value(); break;
			case "--description": out.description = value(); break;
			case "--author": out.author = value(); break;
			case "--license": out.license = value(); break;
			case "--version": out.version = value(); break;
			case "--db-schema-version": out.dbSchemaVersion = value(); break;
			case "--dependencies": out.dependencies = list(out.dependencies, value()); break;
			case "--preset": out.preset = value(); break;
			case "--entity": out.entities = list(out.entities, value()); break;
			case "--traits": out.traits = value(); break;
			default:
				console.error(`dforge-cli init module: unknown flag "${flag}" (ignored)`);
		}
	}
	return out;
}

const PRESETS: ReadonlySet<string> = new Set(["minimal", "minimal-plus", "full"]);
const TRAITS_VALUES: ReadonlySet<string> = new Set(["identity+audit", "identity"]);

/**
 * Build scaffold options from flags + defaults, with the SAME validation the
 * interactive prompts enforce. Returns null (after printing a clear message)
 * on any invalid input. Defaults mirror the interactive initial values, so
 * `init module <path> --code foo` yields the same minimal scaffold a user gets
 * by accepting every prompt default.
 */
function buildOptsFromArgs(absPath: string, args: InitArgs): ScaffoldOpts | null {
	const fail = (msg: string): null => {
		console.error(`dforge-cli init module: ${msg}`);
		return null;
	};

	const code = args.code!;
	const codeErr = validateCode(code);
	if (codeErr) return fail(`--code ${codeErr}`);

	const version = args.version ?? "0.1.0";
	const versionErr = validateSemver(version);
	if (versionErr) return fail(`--version ${versionErr}`);

	const dbSchemaVersion = args.dbSchemaVersion ?? "0.0.1";
	const dbErr = validateSemver(dbSchemaVersion);
	if (dbErr) return fail(`--db-schema-version ${dbErr}`);

	const preset = args.preset ?? "minimal";
	if (!PRESETS.has(preset)) {
		return fail(`--preset must be one of: ${[...PRESETS].join(", ")}.`);
	}

	const traits = args.traits ?? "identity+audit";
	if (!TRAITS_VALUES.has(traits)) {
		return fail(`--traits must be one of: ${[...TRAITS_VALUES].join(", ")}.`);
	}

	// At least one entity is required for a valid scaffold. Default to a single
	// "item" entity when none were named — same shape the interactive flow's
	// first-entity prompt yields, just with a sensible default name.
	const names =
		args.entities && args.entities.length > 0 ? args.entities : ["item"];
	const entities: EntitySpec[] = [];
	for (const name of names) {
		const nameErr = validateEntityName(name);
		if (nameErr) return fail(`--entity "${name}": ${nameErr}`);
		entities.push({ name, label: titlecase(name), traits: traits as Traits });
	}

	const displayName = args.displayName ?? titlecase(code);
	if (validateNonEmpty(displayName)) return fail("--display-name cannot be empty.");

	return {
		path: absPath,
		code,
		displayName,
		description: args.description ?? "",
		author: args.author ?? tryGitUserName() ?? "",
		license: args.license ?? "MIT",
		version,
		dbSchemaVersion,
		dependencies: parseDependencies(args.dependencies ?? []),
		preset: preset as Preset,
		entities,
	};
}

// System modules are provisioned into every tenant before any other module
// installs, so a module never needs to depend on one. Naming one is only
// meaningful as a minimum-platform-version gate, which is not a scaffold-time
// decision — hence a hard reject here, with the reason.
const SYSTEM_MODULES = new Set(["admin", "metadata", "workspace"]);

/**
 * Parses `--dependencies` tokens of the form `module:entity[+entity…]`.
 *
 * The entity list is mandatory because every manifest dependency needs a
 * matching deps/<module>.json contract naming at least one consumed entity;
 * scaffolding the manifest half alone produces a module that cannot be packed
 * (dForge-core issue #1090).
 */
function parseDependencies(tokens: string[]): DependencySpec[] {
	return tokens.map((token) => {
		const [module, entityList] = token.split(":");
		if (!module || !entityList) {
			throw new Error(
				`dforge-cli init module: --dependencies "${token}" must name the entities you consume, ` +
					`as module:entity[+entity]. Every dependency needs a deps/${module || "<module>"}.json ` +
					`contract declaring at least one entity, so a dependency with no named entity cannot be scaffolded. ` +
					`If you do not consume anything from it yet, leave it out and add it later with dforge_dependency_add.`,
			);
		}
		if (SYSTEM_MODULES.has(module)) {
			throw new Error(
				`dforge-cli init module: '${module}' is a system module — it is provisioned into every tenant, ` +
					`so depending on it buys nothing. Declare it by hand only to require a minimum platform version ` +
					`for a feature you use (e.g. "metadata": ">=1.5.0"), with a contract naming the entity that feature introduced.`,
			);
		}
		const entities = entityList.split("+").map((e) => e.trim()).filter(Boolean);
		if (entities.length === 0) {
			throw new Error(
				`dforge-cli init module: --dependencies "${token}" names no entities after the colon.`,
			);
		}
		return { module, entities };
	});
}

function printModuleHelp(): void {
	console.log("Usage: dforge-cli init module <path> [options]");
	console.log("");
	console.log("Scaffold a new dForge module. With a TTY and no flags, runs interactively.");
	console.log("With --code (or when there's no TTY), runs non-interactively from flags + defaults.");
	console.log("");
	console.log("Options:");
	console.log("  --code <code>              Module code (required when non-interactive)");
	console.log("  --display-name <name>      Default: title-cased code");
	console.log("  --description <text>       Default: empty");
	console.log("  --author <name>            Default: git user.name");
	console.log("  --license <id>             Default: MIT");
	console.log("  --version <semver>         Default: 0.1.0");
	console.log("  --db-schema-version <ver>  Default: 0.0.1");
	console.log("  --dependencies <mod:ent>   Consumed module + entities, e.g. fin:invoice+line.");
	console.log("                             Repeatable/comma-separated. Default: none.");
	console.log("  --preset <p>               minimal | minimal-plus | full  (default: minimal)");
	console.log("  --entity <name[,name…]>    Entities to scaffold (default: item). Repeatable.");
	console.log("  --traits <t>               identity+audit | identity  (default: identity+audit)");
	console.log("  -y, --yes                  Force non-interactive even with a TTY");
	console.log("  -h, --help                 Show this help");
}

/**
 * Interactive prompt sequence. Returns null if the user cancels.
 */
async function collectOpts(absPath: string): Promise<ScaffoldOpts | null> {
	const gitName = tryGitUserName();

	// First group: identity + metadata. Each prompt depends only on the
	// previous answers (for default derivation), so p.group() drives them
	// in sequence and short-circuits on cancel.
	const meta = await p.group(
		{
			code: () =>
				p.text({
					message: "Module code (e.g. crm, hr-admin)",
					placeholder: "my-module",
					validate: validateCode,
				}),
			displayName: ({ results }) =>
				p.text({
					message: "Display name",
					initialValue: titlecase(results.code as string),
					validate: validateNonEmpty,
				}),
			description: () =>
				p.text({
					message: "Description (optional)",
					placeholder: "(empty)",
				}),
			author: () =>
				p.text({
					message: "Author name (optional)",
					initialValue: gitName ?? "",
				}),
			license: () =>
				p.text({
					message: "License",
					initialValue: "MIT",
				}),
			version: () =>
				p.text({
					message: "Initial version",
					initialValue: "0.1.0",
					validate: validateSemver,
				}),
			dbSchemaVersion: () =>
				p.text({
					message: "Initial DB schema version",
					initialValue: "0.0.1",
					validate: validateSemver,
				}),
			preset: () =>
				p.select({
					message: "Scaffold preset",
					options: [
						{
							value: "minimal" as Preset,
							label: "Minimal",
							hint: "manifest + one entity + minimal UI/security",
						},
						{
							value: "minimal-plus" as Preset,
							label: "Minimal + add more entities interactively",
							hint: "loop to add multiple entities now",
						},
						{
							value: "full" as Preset,
							label: "Full template",
							hint: "+ settings, translations, seed-data, logic/actions",
						},
					],
					initialValue: "minimal" as Preset,
				}),
		},
		{ onCancel: () => process.exit(CANCEL_EXIT) },
	);

	// First entity — required regardless of preset.
	const firstEntity = await promptEntity("First entity name");
	if (firstEntity === null) return null;

	const entities: EntitySpec[] = [firstEntity];

	// Loop to add more if the user picked the "plus" preset.
	if (meta.preset === "minimal-plus") {
		while (true) {
			const more = await p.confirm({
				message: "Add another entity?",
				initialValue: false,
			});
			if (p.isCancel(more)) return null;
			if (!more) break;
			const next = await promptEntity("Entity name");
			if (next === null) return null;
			entities.push(next);
		}
	}

	return {
		path: absPath,
		code: meta.code as string,
		displayName: meta.displayName as string,
		description: (meta.description as string | undefined) ?? "",
		author: (meta.author as string | undefined) ?? "",
		license: (meta.license as string | undefined) ?? "MIT",
		version: meta.version as string,
		dbSchemaVersion: meta.dbSchemaVersion as string,
		dependencies: [],
		preset: meta.preset as Preset,
		entities,
	};
}

async function promptEntity(message: string): Promise<EntitySpec | null> {
	const grp = await p.group(
		{
			name: () =>
				p.text({
					message,
					placeholder: "thing",
					validate: validateEntityName,
				}),
			label: ({ results }) =>
				p.text({
					message: "Entity label",
					initialValue: titlecase(results.name as string),
					validate: validateNonEmpty,
				}),
			traits: () =>
				p.select({
					message: "Built-in traits",
					options: [
						{
							value: "identity+audit" as Traits,
							label: "identity + audit",
							hint: "PK + created/updated timestamps + created_by/updated_by (recommended)",
						},
						{
							value: "identity" as Traits,
							label: "identity only",
							hint: "PK only",
						},
					],
					initialValue: "identity+audit" as Traits,
				}),
		},
		{ onCancel: () => process.exit(CANCEL_EXIT) },
	);
	return {
		name: grp.name as string,
		label: grp.label as string,
		traits: grp.traits as Traits,
	};
}

function writeAll(opts: ScaffoldOpts): void {
	const moduleId = randomUUID();
	const root = opts.path;
	fs.mkdirSync(root, { recursive: true });

	// Minimal file set — written for every preset.
	writeJson(path.join(root, "manifest.json"), buildManifest(opts, moduleId));
	for (const e of opts.entities) {
		writeJson(path.join(root, "entities", `${e.name}.json`), buildEntity(e));
	}
	writeJson(path.join(root, "ui", "data_views.json"), buildDataViews(opts.entities));
	writeJson(path.join(root, "ui", "folders.json"), buildFolders(opts));
	writeJson(path.join(root, "ui", "menus.json"), buildMenus(opts));
	writeJson(path.join(root, "ui", "actions.json"), buildActions());
	writeJson(path.join(root, "security", "roles.json"), buildRoles(opts));
	// Every manifest dependency needs its contract or the module will not pack.
	for (const dep of opts.dependencies) {
		// The CLI's own parseDependencies always yields the object form; a bare
		// code can only reach here from a legacy programmatic caller, which gets
		// the legacy manifest-only behaviour (buildManifest) and no contract.
		if (typeof dep === "string") continue;
		writeJson(
			path.join(root, "deps", `${dep.module}.json`),
			buildDepsContract(dep, opts.code),
		);
	}
	writeText(path.join(root, ".gitignore"), buildGitignore());

	// Editor-bindings: VS Code + Zed pick these up automatically from
	// their project-local config dirs. JSON Schema URLs resolve via
	// jsdelivr (no per-user setup, no extension required). See the
	// comment on SCHEMA_BINDINGS in templates.ts.
	writeJson(path.join(root, ".vscode", "settings.json"), buildVscodeSettings());
	writeJson(path.join(root, ".zed", "settings.json"), buildZedSettings());
	// Zed has no extension command API — the CLI dev loop ships as tasks.
	writeJson(path.join(root, ".zed", "tasks.json"), buildZedTasks());

	// Full preset adds the optional-but-typical files. None are required
	// for `module validate` to pass; they're there as scaffolding the author
	// can fill in (or delete) rather than have to remember to create.
	if (opts.preset === "full") {
		writeJson(path.join(root, "settings.json"), buildSettings());
		writeJson(path.join(root, "translations", "en-US.json"), buildTranslations(opts));
		for (const e of opts.entities) {
			writeJson(
				path.join(root, "seed-data", `01-${e.name}.json`),
				buildSeedData(e),
			);
		}
		ensureDir(path.join(root, "logic", "actions"));
		writeText(path.join(root, "logic", "actions", ".gitkeep"), "");
	}
}

function writeJson(file: string, obj: unknown): void {
	ensureDir(path.dirname(file));
	// Tabs per CLAUDE.md convention for .json files (size 2). Trailing
	// newline keeps POSIX tools happy.
	fs.writeFileSync(file, JSON.stringify(obj, null, "\t") + "\n", "utf8");
}

function writeText(file: string, content: string): void {
	ensureDir(path.dirname(file));
	fs.writeFileSync(file, content, "utf8");
}

function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function tryGitUserName(): string | undefined {
	try {
		const out = execSync("git config user.name", {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return out || undefined;
	} catch {
		return undefined;
	}
}
