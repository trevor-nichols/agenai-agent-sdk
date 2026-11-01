import assert from 'node:assert/strict';
import { join } from 'node:path';
import { originalFile } from '../coordinator-recovery/common.mjs';
import { originalDeleteCut } from './original.mjs';
import { failure } from '../coordinator/evidence.mjs';

export function retainOriginalHandoff({ originalInput, sdkOutput, handoffOutput, consumer, output, evidence, report }) {
  let selected, cleanupInput, publication = 0;
  const admit = async () => {
    if (selected) return selected;
    const predecessor = await originalFile(join(handoffOutput, 'report.json'), 4 * 1024 ** 2);
    assert.equal(predecessor.value.format, 'agenai.ms005-owned-controller-crash-handoff.v2');
    assert.deepEqual(predecessor.value.input, { path: originalInput.path, sha256: originalInput.sha256 });
    if (predecessor.value.status !== 'original_controller_killed_exact_pending_cut_preserved') {
      selected = { kind: 'rejected', predecessor }; return selected;
    }
    const value = { consumer, output, originalInput: originalInput.path,
      originalReport: predecessor.value.barrier.report.path, canonical: join(sdkOutput, 'cut-canonical-original.bin') };
    const original = await originalDeleteCut({ ...value, predecessor: predecessor.identity.path });
    selected = { kind: 'cut', predecessor: original.predecessor, value };
    report.predecessor = selected.predecessor.identity;
    return selected;
  };
  return {
    admit,
    async cleanupInput() {
      const original = await admit(); assert.equal(original.kind, 'cut');
      if (!cleanupInput) {
        const name = () => `cleanup-only-input${publication ? `-${publication}` : ''}.json`;
        try {
          const published = await originalFile(join(evidence.directory, name()), 1024 ** 2);
          assert.deepEqual(published.value, original.value, 'Published cleanup input differs from the exact original handoff.');
          cleanupInput = published.identity;
        } catch (error) {
          if (error.code !== 'ENOENT') { report.evidenceFailures.push(failure(error)); publication += 1; }
          cleanupInput = await evidence.file(name(), original.value);
        }
      }
      return cleanupInput;
    },
  };
}
