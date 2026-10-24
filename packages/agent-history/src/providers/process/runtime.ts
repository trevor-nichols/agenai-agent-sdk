// ------------------------------------------------------------------------------------------------
//                runtime.ts - Closed Node execution profiles for bounded native history workers
// ------------------------------------------------------------------------------------------------

export type HistoryJsonWorkerRuntime = 'jitless' | 'bounded_webassembly';

const argumentsByRuntime = Object.freeze({
  jitless: Object.freeze(['--jitless', '--max-old-space-size=128']),
  bounded_webassembly: Object.freeze(['--disable-wasm-trap-handler', '--max-old-space-size=128']),
});

export function historyJsonWorkerArguments(runtime: HistoryJsonWorkerRuntime): readonly string[] {
  return argumentsByRuntime[runtime];
}
