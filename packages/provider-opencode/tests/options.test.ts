import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentInstanceId, parseAgentProviderKey } from '@agen-ai/agent-protocol';
import type { NodeOpenCodeProviderOptions } from '../src/index.js';
import { createNodeOpenCodeProviderDriver, NodeOpenCodeProviderOptionsError } from '../src/node/index.js';

const SECRET = 'sk-test-0123456789';
const valid: NodeOpenCodeProviderOptions = {
  executablePath: '/opt/opencode/opencode',
  provider: 'openai',
  credential: { kind: 'api_key', value: SECRET },
  tools: {
    workspace: { storeDirectory: '/srv/store', workspaceDirectory: '/srv/store/work' },
    stateParentDirectory: '/srv/state', bubblewrapPath: '/usr/bin/bwrap', filesystemHelperPath: '/opt/agenai/helper',
  },
};

test('the factory is inert and accepts both model routes and the documented endpoint forms', () => {
  for (const provider of ['anthropic', 'openai'] as const) {
    for (const apiBaseUrl of [undefined, 'https://gateway.example.com/route', 'http://127.0.0.1:8080', 'http://[::1]:9000', 'http://localhost:4000']) {
      const driver = createNodeOpenCodeProviderDriver({ ...valid, provider, ...(apiBaseUrl ? { apiBaseUrl } : {}),
        usageLimits: { maxOutputTokensPerRequest: 4_096, maxModelStepsPerTurn: 12 } });
      assert.equal(driver.providerKey, 'opencode');
      assert.equal(driver.supportsMultipleInstances, false);
    }
  }
});

test('invalid options are refused by field name without disclosing the credential', () => {
  const cases: Array<[string, unknown]> = [
    ['provider', { ...valid, provider: 'opencode' }],
    ['apiBaseUrl', { ...valid, apiBaseUrl: 'http://gateway.example.com' }],
    ['apiBaseUrl', { ...valid, apiBaseUrl: `https://user:${SECRET}@api.example.com` }],
    ['apiBaseUrl', { ...valid, apiBaseUrl: 'https://api.example.com/?key=1' }],
    ['credential', { ...valid, credential: { kind: 'api_key', value: `${SECRET} ` } }],
    ['credential', { ...valid, credential: { kind: 'oauth', value: SECRET } }],
    ['executablePath', { ...valid, executablePath: 'opencode' }],
    ['executablePath', { ...valid, executablePath: '/opt/opencode/../opencode' }],
    ['environment', { ...valid, environment: { OPENAI_API_KEY: SECRET } }],
    ['plugins', { ...valid, plugins: ['file:///tmp/plugin'] }],
    ['usageLimits', { ...valid, usageLimits: { maxOutputTokensPerRequest: 0 } }],
    ['usageLimits', { ...valid, usageLimits: { maxOutputTokensPerRequest: 256_001 } }],
    ['usageLimits', { ...valid, usageLimits: { maxModelStepsPerTurn: 1.5 } }],
    ['maxBudgetUsdPerSession', { ...valid, usageLimits: { maxBudgetUsdPerSession: 1 } }],
  ];
  for (const [field, options] of cases) {
    assert.throws(() => createNodeOpenCodeProviderDriver(options as NodeOpenCodeProviderOptions), (error: unknown) =>
      error instanceof NodeOpenCodeProviderOptionsError && error.message.includes(field) && !error.message.includes(SECRET)
      && !JSON.stringify(error).includes(SECRET), field);
  }
});

test('driver configuration carries exactly one model identifier', async () => {
  const driver = createNodeOpenCodeProviderDriver(valid);
  const providerKey = parseAgentProviderKey('opencode');
  const instanceId = parseAgentInstanceId('opencode-options');
  for (const driverConfiguration of [{}, { model: '' }, { model: 'gpt-5', apiKey: SECRET }, { model: 'has space' }, { model: 'gpt-5', provider: 'anthropic' }]) {
    await assert.rejects(Promise.resolve().then(() => driver.materialize({ providerKey, instanceId, driverConfiguration })),
      (error: unknown) => error instanceof Error && error.cause instanceof NodeOpenCodeProviderOptionsError && !error.cause.message.includes(SECRET));
  }
});
