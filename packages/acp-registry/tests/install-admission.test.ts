import assert from 'node:assert/strict';
import { access, chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { openAcpInstallationStore } from '../src/node/install/index.js';
import { AcpInstallationError } from '../src/node/install/errors.js';
import { packageContext } from './fixtures/install-packages/index.js';

test('a mismatched package runtime is rejected before even a version probe can execute its bytes', async () => {
  const fixture = await packageContext('npx', { locked: true });
  try {
    const marker = join(fixture.root, 'unapproved-tool-executed');
    const wrong = join(fixture.root, 'wrong-runtime');
    await writeFile(wrong, `#!/bin/sh\nprintf executed > '${marker}'\nprintf 'v24.18.0\\n'\n`);
    await chmod(wrong, 0o700);
    const store = await openAcpInstallationStore({ root: join(fixture.root, 'store') });
    await assert.rejects(store.install({ plan: fixture.context.plan, expectedPlanDigest: fixture.context.plan.digest,
      toolchains: fixture.context.toolchains.map((tool) => ({ kind: tool.kind, path: tool.kind === 'node' ? wrong : tool.path })),
      localArtifacts: fixture.context.localArtifacts, packageArtifacts: fixture.context.packageArtifacts }),
    (error: unknown) => error instanceof AcpInstallationError && error.code === 'toolchain_mismatch');
    await assert.rejects(access(marker), { code: 'ENOENT' });
  } finally { await fixture.cleanup(); }
});
