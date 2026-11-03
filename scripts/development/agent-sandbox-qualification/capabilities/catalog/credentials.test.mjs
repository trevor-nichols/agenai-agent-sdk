import assert from 'node:assert/strict';
import test from 'node:test';
import { acquireAccessCredential, CatalogCredentialRefusal, credentialScope, projectAccessCredential, selectedCredentialPath } from './credentials.mjs';

const now = Date.parse('2026-11-03T12:00:00Z');
const account = () => ({ key: 'access-only.fixture', auth_mode: 'oidc', create_time: '2026-11-02T12:00:00Z',
  user_id: 'fixture-user', email: 'fixture@example.test', principal_id: null, expires_at: '2026-11-04T12:00:00Z',
  oidc_issuer: 'https://auth.x.ai', can_administer_team: false });
const bytes = (record = account()) => Buffer.from(JSON.stringify({ [credentialScope]: record }));

test('access snapshot strips refresh and unknown fields and destroys its private bytes after preparation', () => {
  const record = account(); record.refresh_token = 'never-serialize'; record.endpoint = 'https://alternate.invalid';
  const input = bytes(record), acquired = projectAccessCredential(input, now);
  const projected = JSON.parse(acquired.bytes.toString('utf8'));
  assert.deepEqual(projected, { [credentialScope]: account() });
  assert(input.some((value) => value !== 0));
  acquired.prepared(); assert(acquired.bytes.every((value) => value === 0));
  acquired.dispose(); assert(acquired.bytes.every((value) => value === 0));
});

test('access snapshot refuses other routes, malformed account facts, and expired access without renewal', () => {
  const invalid = [
    [Buffer.from('{}'), 'unsupported_account'],
    [Buffer.from('not-json'), 'malformed_credentials'],
    [bytes({ ...account(), auth_mode: 'api_key' }), 'malformed_credentials'],
    [bytes({ ...account(), oidc_issuer: 'https://other.invalid' }), 'malformed_credentials'],
    [bytes({ ...account(), email: null, principal_id: null }), 'unsupported_account'],
    [bytes({ ...account(), key: 'invalid\naccess' }), 'malformed_credentials'],
    [bytes({ ...account(), expires_at: '2028-02-31T12:00:00Z' }), 'malformed_credentials'],
    [bytes({ ...account(), team_blocked_reasons: ['bad\u200bvalue'] }), 'malformed_credentials'],
    [bytes({ ...account(), expires_at: '2026-11-03T12:05:00Z' }), 'expired_credentials'],
    [bytes({ ...account(), create_time: '2026-10-01T12:00:00Z', expires_at: null }), 'expired_credentials'],
    [Buffer.alloc(65537), 'credential_payload_too_large'],
  ];
  for (const [input, code] of invalid) assert.throws(() => projectAccessCredential(input, now),
    (error) => error instanceof CatalogCredentialRefusal && error.code === code && !error.message.includes('fixture'));
  const fallback = projectAccessCredential(bytes({ ...account(), expires_at: undefined }), now);
  assert.equal(JSON.parse(fallback.bytes.toString())[credentialScope].expires_at, undefined); fallback.dispose();
});

test('public stable-reader bytes are zeroed on acquisition success and refusal', async () => {
  for (const valid of [true, false]) {
    const record = account(); record.expires_at = '2099-01-01T00:00:00Z';
    const source = valid ? bytes(record) : Buffer.from('malformed');
    const sdk = { async readSandboxCredentialFile() { return source; } };
    if (valid) { const credential = await acquireAccessCredential(sdk, '/private/fixture'); credential.dispose(); }
    else await assert.rejects(acquireAccessCredential(sdk, '/private/fixture'), { code: 'malformed_credentials' });
    assert(source.every((value) => value === 0));
  }
  assert.equal(selectedCredentialPath({ GROK_AUTH_PATH: '/private/auth', GROK_HOME: '/private/profile' }, '/private/home'), '/private/auth');
  assert.equal(selectedCredentialPath({ GROK_HOME: '/private/profile' }, '/private/home'), '/private/profile/auth.json');
  assert.equal(selectedCredentialPath({}, '/private/home'), '/private/home/.grok/auth.json');
  assert.throws(() => selectedCredentialPath({ GROK_AUTH_PATH: '../auth' }, '/private/home'));
});
