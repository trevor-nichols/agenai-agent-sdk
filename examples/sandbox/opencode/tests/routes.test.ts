import assert from 'node:assert/strict';
import test from 'node:test';
import { createCredentialFixture } from '../../credentials/tests/fixture.js';
import { reserveSandboxOpenCode } from '../index.js';

export const configuration = {
  guestExecutable: '/opt/agenai/native/opencode' as const, task: '--help is task text',
  selection: { provider: 'openai', model: 'openai/gpt-5.4', httpsDestinations: ['https://api.openai.com'] },
  preparation: { bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 2000 },
};

test('OpenCode imports a selected non-Anthropic API key without ambient account or endpoint overrides', async (t) => {
  const fixture = createCredentialFixture({ bootstrap: true }); t.after(() => fixture.owner.destroy());
  const { reservation, preflight } = await reserveSandboxOpenCode(await fixture.owner.start(), {
    ...configuration, credential: { kind: 'api_key', value: 'synthetic-selected-openai-key' },
  });
  await reservation.start();
  assert(fixture.credentialFile);
  assert.equal(fixture.credentialFile.name, 'auth-export.json');
  assert.deepEqual(JSON.parse(fixture.credentialFile.bytes.toString()), [{ id: 'cred_agenai-sandbox-selected', integrationID: 'openai',
    label: 'Explicit sandbox API key', active: true, value: { type: 'key', key: 'synthetic-selected-openai-key' } }]);
  const spec = fixture.specification; assert(spec);
  assert.equal(spec.env.ANTHROPIC_API_KEY, undefined); assert.equal(spec.env.OPENAI_API_KEY, undefined);
  assert.equal(spec.env.OPENCODE_DB, '/home/sandbox/.agenai-credentials/opencode.db');
  assert.equal(JSON.parse(spec.env.OPENCODE_CONFIG_CONTENT!).providers, undefined);
  assert.deepEqual(spec.args.slice(0, 4), ['/bin/sh', '/opt/agenai/examples/opencode/launch-opencode.sh', '2.000s', 'run']);
  assert.deepEqual(spec.args.slice(-2), ['--', configuration.task]);
  assert.equal(preflight.nativeProvider, 'openai'); assert.equal(preflight.credentialRoute, 'api_key');
  assert(!JSON.stringify(preflight).includes('synthetic-selected-openai-key'));
  assert.equal(fixture.processCalls, 1);
  await reservation.stop(); assert.deepEqual([...fixture.resources], ['storage']);
});

test('OpenCode rejects mismatched models, incomplete import preparation and non-HTTPS origins before reservation', async (t) => {
  const fixture = createCredentialFixture(); t.after(() => fixture.owner.destroy()); const sandbox = await fixture.owner.start();
  for (const overrides of [
    { selection: { ...configuration.selection, model: 'anthropic/other' } },
    { selection: { ...configuration.selection, httpsDestinations: ['http://api.openai.com'] } },
    { preparation: { ...configuration.preparation, preparationTimeoutMs: 0 } },
  ]) await assert.rejects(reserveSandboxOpenCode(sandbox, { ...configuration, ...overrides, credential: { kind: 'api_key', value: 'synthetic-key' } }), TypeError);
  assert.equal(fixture.processCalls, 0);
});
