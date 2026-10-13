import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import { approveSyntheticRequest, runExampleSession } from './run-session.js';

const workingDirectory = await mkdtemp(join(tmpdir(), 'agent-sdk-local-example-'));
try {
  // Replace these host-selected values with an approved agent executable, arguments and workspace.
  // No shell expansion occurs, and the parent's environment is not inherited.
  const driver = createNodeAcpProviderDriver({
    providerKey: 'example-local-acp',
    launch: {
      executable: await realpath(process.execPath),
      args: [fileURLToPath(new URL('./fixtures/credentialless-peer.mjs', import.meta.url)), '$HOME', 'literal;$(never-execute)'],
      cwd: workingDirectory,
      env: { EXAMPLE_MARKER: 'explicit-launch-environment' },
      shutdownTimeoutMs: 1_000,
    },
  });
  await runExampleSession(driver, workingDirectory, approveSyntheticRequest);
  await rm(workingDirectory, { recursive: true, force: true });
} catch (error) {
  console.error(`Example failed; inspect the retained workspace at ${workingDirectory} before cleanup.`);
  throw error;
}
