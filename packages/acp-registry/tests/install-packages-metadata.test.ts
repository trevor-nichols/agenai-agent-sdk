import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AcpInstallationError } from '../src/node/install/errors.js';
import { readPackageMetadata } from '../src/node/install/packages/metadata.js';
import { runAcpInstallTool } from '../src/node/install/tools/run.js';

for (const reader of ['readPackageMetadata', 'isNodeEntryPoint'] as const) {
  test(`${reader} rejects an actual FIFO without waiting for a writer`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-package-special-file-'));
    try {
      const fifo = join(root, 'native-file');
      execFileSync('mkfifo', [fifo]);
      const probe = join(root, 'probe.mjs');
      const owner = new URL('../src/node/install/packages/metadata.ts', import.meta.url).href;
      await writeFile(probe, `import { ${reader} } from ${JSON.stringify(owner)};\ntry { await ${reader}(process.argv[2]); process.exitCode = 2; } catch (error) { if (error.name !== 'AcpInstallationError' || error.code !== 'payload_changed') throw error; console.log(error.code); }\n`);
      const result = await runAcpInstallTool({ executable: process.execPath, args: ['--import', import.meta.resolve('tsx'), probe, fifo], cwd: root,
        env: {}, timeoutMs: 2000, maxOutputBytes: 4096 });
      assert.equal(result.exitCode, 0, result.stderr);
      assert.equal(result.stdout.trim(), 'payload_changed');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('native package metadata exceeding its byte ceiling rejects with a stable installation limit error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'acp-package-metadata-bound-'));
  try {
    const metadata = join(root, 'package.json');
    await writeFile(metadata, Buffer.alloc(256 * 1024 + 1, ' '));
    await assert.rejects(readPackageMetadata(metadata), (error: unknown) => error instanceof AcpInstallationError && error.code === 'limit_exceeded');
  } finally { await rm(root, { recursive: true, force: true }); }
});
