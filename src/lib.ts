// Library entry point: re-exports the pure scaffold builders + types so
// downstream packages (@dforge-core/dforge-mcp, future tooling) can
// compose the same building blocks the CLI uses for `init module`.
//
// CLI consumers don't reach this file — the `dforge-cli` bin is bundled
// from src/cli.ts. This entry is only for `import { ... } from
// "@dforge-core/dforge-cli/templates"` from another package.
export * from "./init/templates";
export type * from "./init/types";
