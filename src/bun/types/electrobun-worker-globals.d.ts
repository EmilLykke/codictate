/**
 * electrobun ships `dist/api/bun/proc/native.ts` as TypeScript source, and that
 * file reaches for the WebWorker `self` global. `tsconfig.bun.json` deliberately
 * declares only `lib: ["ES2020"]` for the main process, so `self` is unknown there
 * and `bun run tsc` fails inside node_modules.
 *
 * Declare just the surface that file touches rather than pulling in the whole
 * WebWorker or DOM lib, which would add browser globals the main process must not
 * use. Remove this once electrobun ships prebuilt declarations for that module.
 */
declare let self: {
  addEventListener?: (
    type: string,
    listener: (event: MessageEvent) => void
  ) => void
  postMessage: (message: unknown) => void
}
