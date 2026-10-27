// ------------------------------------------------------------------------------------------------
//                quotas.ts - Optional logical quotas and exact transfer summary verification
// ------------------------------------------------------------------------------------------------

import { SandboxOperationError } from '../errors.js';
import { parseTransferSummary } from './parse.js';
import type { SandboxTransferBudget, SandboxTransferSummary } from './types.js';

export class TransferCounters {
  files = 0n;
  directories = 0n;
  symlinks = 0n;
  payloadBytes = 0n;
  constructor(private readonly quotas: SandboxTransferBudget, private readonly direction: 'import' | 'export') {}

  admit(entry: Readonly<{ kind: 'file'; byteLength: number }> | Readonly<{ kind: 'directory' }> | Readonly<{ kind: 'symlink' }>): void {
    if (entry.kind === 'directory') this.directories += 1n;
    else if (entry.kind === 'symlink') { this.symlinks += 1n; this.check('maxSymlinks', this.symlinks); }
    else {
      this.files += 1n;
      const bytes = BigInt(entry.byteLength);
      this.payloadBytes += bytes;
      this.check('maxFileBytes', bytes);
      this.check('maxFiles', this.files);
      this.check('maxTotalBytes', this.payloadBytes);
    }
  }

  check(name: keyof SandboxTransferBudget, actual: bigint): void {
    const ceiling = this.quotas[name];
    if (ceiling !== undefined && actual > ceiling) throw new SandboxOperationError(this.direction === 'import' ? 'input_limit' : 'output_limit', `Transfer exceeded caller quota ${name}.`);
  }

  verify(input: unknown): SandboxTransferSummary {
    const summary = parseTransferSummary(input);
    if (summary.files !== this.files || summary.directories !== this.directories || summary.symlinks !== this.symlinks || summary.payloadBytes !== this.payloadBytes) {
      throw new SandboxOperationError('driver_failure', 'Backend transfer summary disagrees with completely consumed entries.');
    }
    this.check('maxArchiveBytes', summary.archiveBytes);
    return summary;
  }
}
