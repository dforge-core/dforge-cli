import { spawnNative } from "./native";

const argv = process.argv.slice(2);

// JS-handled commands route here; everything else is passed through to the
// native binary. Keep this list tight — native commands pay no startup cost.
function jsCommand(
	loader: () => Promise<(rest: string[]) => Promise<number>>,
	rest: string[],
): void {
	loader()
		.then((run) => run(rest))
		.then(
			(code) => process.exit(code ?? 0),
			(err: Error) => {
				console.error(err.message ?? err);
				process.exit(1);
			},
		);
}

if (argv[0] === "init") {
	jsCommand(() => import("./init/index").then((m) => m.runInit), argv.slice(1));
} else if (argv[0] === "module" && argv[1] === "pack") {
	// `module pack` is JS-only — pure zip operation, no need to spin up the
	// .NET runtime or talk to a DB. Every other `module <subcommand>` (install,
	// uninstall, list, export, …) still goes to the native binary.
	jsCommand(() => import("./pack").then((m) => m.runPack), argv.slice(2));
} else {
	spawnNative(argv);
}
