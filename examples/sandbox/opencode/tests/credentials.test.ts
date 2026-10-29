import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialFixture } from '../../credentials/tests/fixture.js';
import { reserveSandboxOpenCode } from '../index.js';

const configuration = { guestExecutable: '/opt/agenai/native/opencode' as const, task: 'Perform the selected task.',
  selection: { provider: 'openai', model: 'openai/gpt-5.4', httpsDestinations: ['https://chatgpt.com', 'https://auth.openai.com'] },
  preparation: { bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 2000 } };
const selected = { id: 'cred_selected-account', integrationID: 'openai', label: 'Private user label', active: false,
  value: { type: 'oauth', methodID: 'chatgpt-headless', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 0,
    metadata: { clientID: 'native-client', scopes: ['native-scope'], models: ['gpt-5.4'] } } };

test('OpenCode imports only the explicitly selected account and preserves native refresh metadata', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'opencode-auth-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'export.json');
  const source = JSON.stringify([selected, { ...selected, id: 'cred_unselected-key', value: { type: 'key', key: 'unselected-api-key' } }]);
  await writeFile(path, source, { mode: 0o600 });
  const fixture = createCredentialFixture({ bootstrap: true }); t.after(() => fixture.owner.destroy());
  const launch = await reserveSandboxOpenCode(await fixture.owner.start(), { ...configuration,
    credential: { kind: 'auth_export', path, credentialId: selected.id, lineage: 'caller_quiescent' } });
  await launch.reservation.start(); assert(fixture.credentialFile);
  assert.deepEqual(JSON.parse(fixture.credentialFile.bytes.toString()), [{ ...selected, label: 'Explicit sandbox account', active: true }]);
  assert.equal(await readFile(path, 'utf8'), source);
  assert.equal(fixture.specification?.env.OPENAI_API_KEY, undefined); assert.equal(fixture.specification?.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(launch.preflight.credentialRoute, 'auth_export');
  for (const excluded of [path, selected.label, selected.value.access, selected.value.refresh, 'unselected-api-key']) assert(!JSON.stringify(launch.preflight).includes(excluded));
  await launch.reservation.stop(); assert.deepEqual([...fixture.resources], ['storage']);
});

test('OpenCode missing, ambiguous, external and key-only account selections fail without fallback', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'opencode-invalid-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'export.json'); const fixture = createCredentialFixture(); t.after(() => fixture.owner.destroy());
  const sandbox = await fixture.owner.start();
  for (const source of [[], [selected, selected], [{ ...selected, integrationID: 'anthropic' }],
    [{ ...selected, value: { type: 'key', key: 'secret-api-key' } }],
    [{ ...selected, value: { type: 'external', methodID: 'external-store' } }]]) {
    const bytes = JSON.stringify(source); await writeFile(path, bytes, { mode: 0o600 });
    await assert.rejects(reserveSandboxOpenCode(sandbox, { ...configuration,
      credential: { kind: 'auth_export', path, credentialId: selected.id, lineage: 'caller_quiescent' } }), (error: unknown) => {
      assert(error instanceof TypeError); assert.equal(error.message, 'Unsupported or malformed selected native credential file.'); return true;
    });
    assert.equal(await readFile(path, 'utf8'), bytes);
  }
  assert.equal(fixture.processCalls, 0);
});

test('OpenCode shared OpenAI account reuse imports access authority without refresh credentials', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'opencode-token-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.json');
  const expires = Date.now() + 10 * 60 * 1000;
  const account = { ...selected, value: { ...selected.value, expires,
    metadata: { accountID: 'synthetic-account', clientID: 'unselected-client', secret: 'unselected-metadata' } } };
  const source = JSON.stringify([account]);
  await writeFile(path, source, { mode: 0o600 });
  const fixture = createCredentialFixture({ bootstrap: true }); t.after(() => fixture.owner.destroy());
  const sandbox = await fixture.owner.start();
  await writeFile(path, JSON.stringify([{ ...account, value: { ...account.value, expires: Date.now() + 4 * 60 * 1000 } }]), { mode: 0o600 });
  await assert.rejects(reserveSandboxOpenCode(sandbox, { ...configuration,
    credential: { kind: 'auth_export', path, credentialId: selected.id, lineage: 'access_token_only' } }), TypeError);
  assert.equal(fixture.processCalls, 0);
  await writeFile(path, source, { mode: 0o600 });
  const launch = await reserveSandboxOpenCode(sandbox, { ...configuration,
    credential: { kind: 'auth_export', path, credentialId: selected.id, lineage: 'access_token_only' } });
  await launch.reservation.start(); assert(fixture.credentialFile);
  const [guest] = JSON.parse(fixture.credentialFile.bytes.toString());
  assert.deepEqual(guest.value, { ...selected.value, expires, refresh: '', metadata: { accountID: 'synthetic-account' } });
  assert.equal(launch.preflight.refresh, 'not_supplied'); assert.equal(await readFile(path, 'utf8'), source);
  await launch.reservation.stop(); assert.deepEqual([...fixture.resources], ['storage']);
});
