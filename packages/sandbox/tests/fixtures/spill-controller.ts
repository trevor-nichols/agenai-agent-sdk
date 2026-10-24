// ------------------------------------------------------------------------------------------------
//                spill-controller.ts - Production ledger held across physical controller death
// ------------------------------------------------------------------------------------------------

import { once } from 'node:events';
import filesystem from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import type { SpillFileIdentity } from './darwinSpill.js';

const directory = process.argv[2];
if (!directory) throw new Error('An explicit spill directory is required.');
const files: SpillFileIdentity[] = [];
if (process.platform === 'darwin') {
  const open = filesystem.open;
  filesystem.open = async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    if (typeof args[0] === 'string' && args[0].startsWith(`${directory}/agenai-metadata-`)) {
      try {
        if (files.length === 4) throw new Error('Spill observation exceeded four owned files.');
        const fileStats = await handle.stat({ bigint: true });
        files.push({ path: args[0], descriptor: handle.fd, device: fileStats.dev.toString(), inode: fileStats.ino.toString() });
      } catch (error) { await handle.close(); throw error; }
    }
    return handle;
  };
  syncBuiltinESMExports();
}
const { createMetadataLedger } = await import('../../src/files/metadata/index.js');
const { parseSandboxRelativePath } = await import('../../src/files/paths.js');
const { createSandboxSpillStore } = await import('../../src/node/index.js');
const ledger = await createMetadataLedger({
  openSpill: () => createSandboxSpillStore({ directory }), batchBytes: 1030, fanIn: 2,
});
for (let index = 0; index < 200; index += 1) {
  await ledger.append({ path: parseSandboxRelativePath(`held/${index}`), kind: 'file' });
}
process.send?.(process.platform === 'darwin' ? { kind: 'spill_held', files } : { kind: 'spill_held' });
await once(process, 'message');
await ledger.close();
