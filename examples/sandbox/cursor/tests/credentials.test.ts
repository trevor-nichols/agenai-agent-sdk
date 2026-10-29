import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialFixture } from '../../credentials/tests/fixture.js';
import { reserveSandboxCursor } from '../index.js';

const request = { guestExecutable: '/opt/agenai/native/cursor-agent' as const, model: 'selected-account-model', task: 'Perform the selected local task.' };

test('Cursor selects an explicit existing token without API-key exchange input', async (t) => {
  const fixture = createCredentialFixture(); t.after(() => fixture.owner.destroy());
  const { reservation, preflight } = reserveSandboxCursor(await fixture.owner.start(), {
    ...request, credential: { kind: 'auth_token', value: 'synthetic-existing-cursor-token' },
  });
  assert.equal(fixture.specification?.env.CURSOR_AUTH_TOKEN, 'synthetic-existing-cursor-token');
  assert.equal(fixture.specification?.env.CURSOR_API_KEY, undefined);
  assert.equal(fixture.specification?.env.AGENT_CLI_CREDENTIAL_STORE, 'memory');
  assert.equal(preflight.credentialRoute, 'auth_token');
  assert.equal(fixture.processCalls, 1);
  await reservation.stop(); assert.deepEqual([...fixture.resources], ['storage']);
});

test('Cursor saved account projects only native account tokens into private file preparation', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cursor-auth-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.json');
  const account = { accessToken: 'synthetic-cursor-access', refreshToken: 'synthetic-cursor-refresh' };
  await writeFile(path, JSON.stringify({ ...account, apiKey: 'unselected-cursor-api-key', bedrockCredentials: { token: 'unselected-cloud-token' } }), { mode: 0o600 });
  const fixture = createCredentialFixture({ bootstrap: true }); t.after(() => fixture.owner.destroy());
  const { reservation } = await reserveSandboxCursor(await fixture.owner.start(), { ...request, credential: {
    kind: 'auth_json', path, lineage: 'caller_quiescent', bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 1000,
  } });
  await reservation.start();
  assert.deepEqual(fixture.credentialFile, { name: 'auth.json', bytes: Buffer.from(JSON.stringify(account)) });
  assert.equal(fixture.specification?.env.XDG_CONFIG_HOME, '/home/sandbox/.agenai-credentials');
  assert.equal(fixture.specification?.env.AGENT_CLI_CREDENTIAL_STORE, 'file');
  assert.equal(fixture.specification?.env.CURSOR_AUTH_TOKEN, undefined);
  assert.equal(fixture.specification?.env.CURSOR_API_KEY, undefined);
  assert.deepEqual(fixture.specification?.args.slice(0, 3), ['/bin/sh', '/opt/agenai/examples/cursor/launch-cursor.sh', 'agent']);
  await reservation.stop(); assert.deepEqual([...fixture.resources], ['storage']);
});

test('Cursor key-only and incomplete saved stores fail before reserving a process', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cursor-invalid-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.json'); const fixture = createCredentialFixture(); t.after(() => fixture.owner.destroy());
  const sandbox = await fixture.owner.start();
  for (const source of [{ apiKey: 'synthetic-competing-key' }, { accessToken: 'synthetic-access' }, { accessToken: '', refreshToken: 'synthetic-refresh' }]) {
    await writeFile(path, JSON.stringify(source), { mode: 0o600 });
    await assert.rejects(reserveSandboxCursor(sandbox, { ...request, credential: {
      kind: 'auth_json', path, lineage: 'caller_quiescent', bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 1000,
    } }), (error: unknown) => {
      assert(error instanceof TypeError); assert.equal(error.message, 'Unsupported or malformed selected native credential file.'); return true;
    });
  }
  assert.equal(fixture.processCalls, 0);
});
