import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createCredentialFixture } from '../../credentials/tests/fixture.js';
import { reserveSandboxGrok } from '../launch.js';

const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const account = { key: 'synthetic-grok-account', auth_mode: 'oidc', create_time: '2026-10-28T00:00:00Z', user_id: 'synthetic-user',
  refresh_token: 'synthetic-grok-refresh', expires_at: '2100-01-01T00:00:00Z', oidc_issuer: 'https://auth.x.ai',
  oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828' };

test('Grok saved login reaches the private native store without an API override or second process', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'grok-auth-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.json'); const bytes = Buffer.from(JSON.stringify({ [scope]: account }));
  await writeFile(path, JSON.stringify({ [scope]: account, 'xai::api_key': { key: 'unselected-api-key', auth_mode: 'api_key' } }), { mode: 0o600 });
  const fixture = createCredentialFixture({ bootstrap: true }); t.after(() => fixture.owner.destroy());
  const sandbox = await fixture.owner.start();
  const { reservation, preflight } = await reserveSandboxGrok(sandbox, { guestExecutable: '/opt/agenai/native/grok',
    credential: { kind: 'auth_json', path, lineage: 'caller_quiescent',
      bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 1000 } });
  const streams = await reservation.start();
  assert.deepEqual(fixture.credentialFile, { name: 'auth.json', bytes });
  assert.equal(fixture.specification?.executable, '/opt/agenai/bin/agenai-credential-bootstrap');
  assert.deepEqual(fixture.specification?.args, ['/bin/sh', '/opt/agenai/examples/grok/launch-grok.sh', 'auth_json']);
  assert.equal(fixture.specification?.env.GROK_AUTH_PATH, '/home/sandbox/.agenai-credentials/auth.json');
  assert.equal(fixture.specification?.env.XAI_API_KEY, undefined);
  assert.equal(fixture.specification?.env.GROK_XAI_API_BASE_URL, undefined);
  assert.deepEqual(preflight.httpsDestinations, ['https://cli-chat-proxy.grok.com:443', 'https://auth.x.ai:443']);
  assert.equal(preflight.credentialRoute, 'auth_json');
  assert.equal(fixture.processCalls, 1);
  await new Promise<void>((resolve, reject) => streams.stdin.write(Buffer.from('original ACP input\n'), error => error ? reject(error) : resolve()));
  assert.equal(Buffer.concat(fixture.nativeInput).toString(), 'original ACP input\n');
  await reservation.stop(); assert.deepEqual([...fixture.resources], ['storage']);
});

test('Grok rejects API-key caches, missing account scopes and malformed selected files before reservation', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'grok-auth-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.json');
  const fixture = createCredentialFixture(); t.after(() => fixture.owner.destroy());
  const sandbox = await fixture.owner.start();
  for (const content of ['synthetic-secret', '{}', JSON.stringify({ [scope]: { ...account, auth_mode: 'api_key' } }),
    JSON.stringify({ 'xai::api_key': { ...account, auth_mode: 'api_key' } }),
    JSON.stringify({ [scope]: { ...account, oidc_issuer: 'https://unselected.invalid' } })]) {
    await writeFile(path, content, { mode: 0o600 });
    await assert.rejects(async () => reserveSandboxGrok(sandbox, { guestExecutable: '/opt/agenai/native/grok', credential: {
      kind: 'auth_json', path, lineage: 'caller_quiescent', bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 1000 } }),
    (error: unknown) => error instanceof TypeError && !error.message.includes('synthetic-secret'));
    assert.equal(fixture.processCalls, 0);
  }
});

test('Grok access-token-only reuse withholds refresh authority and preserves the active host store', async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'grok-token-'))); t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.json'); const original = JSON.stringify({ [scope]: account });
  await writeFile(path, original, { mode: 0o600 });
  const fixture = createCredentialFixture({ bootstrap: true }); t.after(() => fixture.owner.destroy());
  const launch = await reserveSandboxGrok(await fixture.owner.start(), { guestExecutable: '/opt/agenai/native/grok', credential: {
    kind: 'auth_json', path, lineage: 'access_token_only', bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 1000 } });
  await launch.reservation.start(); assert(fixture.credentialFile);
  const guest = JSON.parse(fixture.credentialFile.bytes.toString())[scope];
  assert.equal(guest.key, account.key); assert.equal(guest.refresh_token, undefined);
  assert.equal(launch.preflight.refresh, 'disabled'); assert.equal(await readFile(path, 'utf8'), original);
  await launch.reservation.stop(); assert.deepEqual([...fixture.resources], ['storage']);
});
