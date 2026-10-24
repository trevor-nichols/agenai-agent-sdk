// ------------------------------------------------------------------------------------------------
//                core.mjs - Execute the public input example from a core-only installation
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const consumerRoot = fileURLToPath(new URL('./', import.meta.url));
const privateRoot = process.argv[2];
assert.ok(privateRoot, 'The caller must identify the excluded private checkout.');
for (const entrypoint of ['@agen-ai/validation', '@agen-ai/agent-protocol', '@agen-ai/agent-runtime']) {
  const resolved = await realpath(fileURLToPath(import.meta.resolve(entrypoint)));
  assert.ok(resolved.startsWith(join(consumerRoot, 'node_modules') + sep));
  assert.equal(resolved.startsWith(privateRoot + sep), false);
}
for (const name of ['@agen-ai/agent-history', '@agen-ai/agent-orchestration', '@agen-ai/acp-transport',
  '@agen-ai/provider-acp', '@agen-ai/acp-registry']) {
  assert.throws(() => import.meta.resolve(name), { code: 'ERR_MODULE_NOT_FOUND' },
    `${name} must be absent from the core-only input example.`);
}
const { runExecutionInputExample } = await import('./dist/examples/execution-input/main.js');
process.stdout.write(JSON.stringify(await runExecutionInputExample()) + '\n');
