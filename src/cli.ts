import { spawnNative } from "./native";

const argv = process.argv.slice(2);

// JS-handled commands route here; everything else is passed through to the
// native binary. Keep this list tight — native commands pay no startup cost.
if (argv[0] === "init") {
	// Lazy-load the init subtree so native commands don't pay the
	// @clack/prompts import cost on every invocation.
	import("./init/index")
		.then(({ runInit }) => runInit(argv.slice(1)))
		.then(
			(code) => process.exit(code ?? 0),
			(err: Error) => {
				console.error(err.message ?? err);
				process.exit(1);
			},
		);
} else {
	spawnNative(argv);
}
