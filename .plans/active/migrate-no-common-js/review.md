# Review — pure ESM entry-point detection

## Bug report

### [P2] Handle package-directory and synthetic entry paths

**Location:** `src/server/tau.ts`

The ESM migration replaced `require.main === module` with a comparison between
the real path of `process.argv[1]` and the path represented by
`import.meta.url`. That comparison assumed the command-line entry argument was
always the JavaScript file Node ultimately loaded, but Node also accepts entry
arguments that are not that file path.

- With `node .`, `process.argv[1]` identifies the package directory while Node
  resolves `package.json`'s `main` field to `bin/tau.js`. The paths do not match,
  so Tau exits successfully without ever starting its server.
- When an ESM stdin program (`node --input-type=module -`) imports Tau,
  `process.argv[1]` is the synthetic value `-`. Calling `realpathSync('-')`
  throws `ENOENT` during module evaluation, so consumers cannot access Tau's
  exports.

The old CommonJS check compared Node's resolved module identity and therefore
handled both cases. The path comparison was a functional regression in valid
package invocation and library-import workflows.

## Fix summary

`src/server/tau.ts` now uses `import.meta.main`, Node's direct ESM signal that
the current module is the program entry point. This starts Tau for direct,
package-directory, and symlinked npm-bin invocations, while remaining false
when Tau is imported by a file, eval script, or stdin program. It also removes
all filesystem access from module-entry detection. The package requires Node
22.19 or newer, which supports this API.

`test/entrypoint.test.ts` adds process-level regression coverage for both
reported paths:

1. `node .` must reach the server-start callback and then shut down cleanly on
   `SIGTERM`.
2. An ESM stdin program must import Tau, observe its `startCli` export, and exit
   normally without starting the server.

Before the fix, both tests failed: the first child exited before starting, and
the second threw `ENOENT` while resolving a path named `-`. After the fix, both
pass.

## Verification

- `npm run build`: passed.
- `node --test test/entrypoint.test.ts`: 2 tests passed.
- `npm test`: 202 tests passed.
- `npm run typecheck`: the server and public projects passed; the test project
  remains blocked by the migration plan's documented missing local
  `playwright` dependency (`TS2307` in `test/e2e/history-render.e2e.ts`). No new
  type errors remain from this fix.

**Post-fix verdict:** The P2 finding is resolved and ready for re-review.
