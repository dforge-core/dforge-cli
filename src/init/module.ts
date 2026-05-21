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
} from "./templates";
import type { EntitySpec, Preset, ScaffoldOpts, Traits } from "./types";

const CANCEL_EXIT = 130;

/**
 * Entry point for `dforge-cli init module <path>`.
 * Returns the process exit code.
 */
export async function runInitModule(argv: string[]): Promise<number> {
	const rawPath = argv[0];
	if (!rawPath) {
		console.error("Usage: dforge-cli init module <path>");
		return 2;
	}
	const absPath = path.resolve(rawPath);

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

	p.intro("dforge-cli init module");

	const opts = await collectOpts(absPath);
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

	// NOTE: post-scaffold validation is intentionally not run here. The C#
	// CLI's only validator (`studio validate`) needs a live tenant DB
	// connection, so it can't validate a freshly-scaffolded directory in
	// isolation. The first time the module is installed (`module install`),
	// the full validator runs and any drift between scaffold output and the
	// validator surfaces. A standalone schema-level validator on the JS
	// side is a future improvement.

	console.log("");
	console.log("Next steps:");
	console.log(`  cd ${path.relative(process.cwd(), opts.path) || "."}`);
	console.log(`  dforge-cli module install --path . --code <tenant>`);
	return 0;
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
			dependencies: () =>
				p.multiselect({
					message: "Depend on system modules (space to toggle)",
					options: [
						{ value: "admin", label: "admin (required for most modules)" },
						{ value: "metadata", label: "metadata (required for most modules)" },
					],
					initialValues: ["admin", "metadata"],
					required: false,
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
		dependencies: (meta.dependencies as string[] | undefined) ?? [],
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
	writeText(path.join(root, ".gitignore"), buildGitignore());

	// Editor-bindings: VS Code + Zed pick these up automatically from
	// their project-local config dirs. JSON Schema URLs resolve via
	// jsdelivr (no per-user setup, no extension required). See the
	// comment on SCHEMA_BINDINGS in templates.ts.
	writeJson(path.join(root, ".vscode", "settings.json"), buildVscodeSettings());
	writeJson(path.join(root, ".zed", "settings.json"), buildZedSettings());

	// Full preset adds the optional-but-typical files. None are required
	// for `module validate` to pass; they're there as scaffolding the author
	// can fill in (or delete) rather than have to remember to create.
	if (opts.preset === "full") {
		writeJson(path.join(root, "settings.json"), buildSettings());
		writeJson(path.join(root, "translations", "en-US.json"), buildTranslations(opts));
		for (const e of opts.entities) {
			writeJson(
				path.join(root, "seed-data", `01-${e.name}.json`),
				buildSeedData(),
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
