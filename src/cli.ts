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
} else {
	// Everything else — including `module pack` — goes to the native binary.
	// `module pack` archives in-process (.NET ZipFile.CreateFromDirectory), so
	// it never depends on a `zip` executable being installed. (It used to be a
	// JS detour that shelled out to `zip`, which broke on Windows / anywhere
	// `zip` wasn't on PATH.)
	spawnNative(argv);
}
