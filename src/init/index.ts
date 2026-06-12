import { runInitModule } from "./module";

/**
 * Dispatch for `dforge-cli init <subcommand>`.
 * Only `module` is implemented today; the structure is in place so future
 * subcommands (e.g. `init mcp-server`) can slot in without restructuring.
 */
export async function runInit(argv: string[]): Promise<number> {
	const sub = argv[0];
	switch (sub) {
		case "module":
			return runInitModule(argv.slice(1));
		case undefined:
		case "--help":
		case "-h":
			printHelp();
			return sub === undefined ? 2 : 0;
		default:
			console.error(`dforge-cli init: unknown subcommand "${sub}"`);
			printHelp();
			return 2;
	}
}

function printHelp(): void {
	console.log("Usage: dforge-cli init <subcommand>");
	console.log("");
	console.log("Subcommands:");
	console.log("  module <path>    Scaffold a new dForge module. Interactive with a TTY;");
	console.log("                   non-interactive with --code (see `init module --help`).");
}
