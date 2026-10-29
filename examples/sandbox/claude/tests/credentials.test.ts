import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSandboxClaudeRun } from '../index.js';
import { fixture, request, sdkFixture } from './fixture.js';

test('saved Claude login is delivered privately before SDK input on the same process owner', { timeout: 3000 }, async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-auth-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.json');
  const bytes = Buffer.from(JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-account-access',
    refreshToken: 'synthetic-account-refresh', expiresAt: 4102444800000, scopes: ['user:inference'] } }));
  await writeFile(path, JSON.stringify({ ...JSON.parse(bytes.toString()), apiKey: 'unselected-api-key', mcpOAuth: { token: 'unselected-mcp-token' } }), { mode: 0o600 });
  const physical = fixture({ bootstrap: true, echo: true });
  const sdk = sdkFixture((child) => child.stdin.end('original SDK input\n'));
  const sandbox = await physical.owner.start();
  try {
    const run = await createSandboxClaudeRun(sdk.sdk, sandbox, { ...request, credential: { kind: 'auth_json', path,
      lineage: 'caller_quiescent', bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 1000 } });
    for await (const _message of run.messages) { /* the original reader drains the native protocol */ }
    assert.deepEqual(await run.settled, { kind: 'receipt', receipt: { kind: 'exited', code: 7 } });
    assert.deepEqual(physical.credentialFile, { name: '.credentials.json', bytes });
    assert.equal(Buffer.concat(physical.received).toString(), 'original SDK input\n');
    assert.equal(Buffer.concat(sdk.bytes).toString(), 'original SDK input\n');
    assert.equal(physical.specification?.env.CLAUDE_CONFIG_DIR, '/home/sandbox/.agenai-credentials');
    assert.equal(physical.specification?.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(physical.specification?.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(physical.specification?.executable, '/opt/agenai/bin/agenai-credential-bootstrap');
    assert.equal(physical.specification?.args[0], request.guestExecutable);
    assert.equal(physical.processCalls, 1);
    await run.cleanup(); assert.deepEqual([...physical.resources], ['storage']);
  } finally { await physical.owner.destroy(); }
});

test('malformed or key-only saved credentials fail before SDK entry without exposing source values', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'claude-auth-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.json');
  const physical = fixture(); const sdk = sdkFixture(); const sandbox = await physical.owner.start();
  const credential = { kind: 'auth_json' as const, path, lineage: 'caller_quiescent' as const,
    bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 1000 };
  const valid = { accessToken: 'synthetic-secret', refreshToken: 'synthetic-refresh', expiresAt: 4102444800000 };
  try {
    for (const content of ['synthetic-secret', '{}', JSON.stringify({ claudeAiOauth: { ...valid, refreshToken: '' } }),
      JSON.stringify({ apiKey: 'synthetic-secret' })]) {
      await writeFile(path, content, { mode: 0o600 });
      await assert.rejects(async () => createSandboxClaudeRun(sdk.sdk, sandbox, { ...request, credential }),
        (error: unknown) => error instanceof TypeError && !error.message.includes('synthetic-secret'));
      assert.equal(sdk.calls, 0); assert.equal(physical.processCalls, 0);
    }
  } finally { await physical.owner.destroy(); }
});
