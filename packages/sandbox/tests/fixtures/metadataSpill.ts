// ------------------------------------------------------------------------------------------------
//                metadataSpill.ts - Real anonymous file observations for ledger ownership tests
// ------------------------------------------------------------------------------------------------

import { mkdtemp, readdir, readlink, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { SandboxDriverSpillFile, SandboxDriverSpillStore } from '../../src/backend/spill.js';
import { parseSandboxRelativePath } from '../../src/files/paths.js';
import type { MetadataRecord } from '../../src/files/metadata/index.js';
import { darwinSpillDescriptors } from './darwinSpill.js';
import type { SpillFileIdentity } from './darwinSpill.js';

export async function spillDirectory(t: TestContext): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agenai-metadata-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export function record(path: string, kind: MetadataRecord['kind'] = 'file'): MetadataRecord {
  return { path: parseSandboxRelativePath(path), kind };
}

export async function spillDescriptors(root: string, pid = process.pid, files?: readonly SpillFileIdentity[]) {
  if (process.platform === 'darwin') {
    if (!files) throw new Error('Darwin spill observation requires actual pre-unlink identities.');
    return darwinSpillDescriptors(pid, files);
  }
  const result: Array<{ target: string; links: number; bytes: number }> = [];
  for (const descriptor of await readdir(`/proc/${pid}/fd`)) {
    const path = `/proc/${pid}/fd/${descriptor}`;
    try {
      const target = await readlink(path);
      if (!target.startsWith(`${root}/agenai-metadata-`)) continue;
      const metadata = await stat(path);
      result.push({ target, links: metadata.nlink, bytes: metadata.size });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return result;
}

export function mapSpillFiles(store: SandboxDriverSpillStore,
  transform: (file: SandboxDriverSpillFile, index: number) => SandboxDriverSpillFile): SandboxDriverSpillStore {
  let next = 0;
  return {
    async createFile() { return transform(await store.createFile(), next++); },
    close: () => store.close(),
  };
}
