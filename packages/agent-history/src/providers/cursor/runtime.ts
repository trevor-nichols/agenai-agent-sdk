// ------------------------------------------------------------------------------------------------
//                runtime.ts - Cursor SDK compatibility with the owning Node runtime
// ------------------------------------------------------------------------------------------------

import type { HistoryJsonWorkerRuntime } from '../process/runtime.js';

export function cursorHistoryWorkerRuntime(): HistoryJsonWorkerRuntime {
  return process.versions.node.split('.')[0] === '22' ? 'bounded_webassembly' : 'jitless';
}
