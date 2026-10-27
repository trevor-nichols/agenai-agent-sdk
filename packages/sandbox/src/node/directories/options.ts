// ------------------------------------------------------------------------------------------------
//                options.ts - Captured transfer options survive asynchronous filesystem admission
// ------------------------------------------------------------------------------------------------

import type { ParsedTransferOptions } from '../../files/parse.js';
import type { SandboxTransferOptions } from '../../files/types.js';

export function capturedTransferOptions(options: ParsedTransferOptions): SandboxTransferOptions {
  return Object.freeze({ quotas: options.quotas, symlinks: options.symlinks,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.deadlineAt === undefined ? {} : { deadlineAt: new Date(options.deadlineAt).toISOString() }) });
}
