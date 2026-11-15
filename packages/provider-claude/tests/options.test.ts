import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentInstanceId, parseAgentProviderKey } from '@agen-ai/agent-protocol';
import type { NodeClaudeProviderOptions } from '../src/index.js';
import { createNodeClaudeProviderDriver, NodeClaudeProviderOptionsError } from '../src/node/index.js';

const SECRET = 'sk-ant-test-0123456789';
const valid: NodeClaudeProviderOptions = {
  executablePath: '/opt/claude/claude',
  credential: { kind: 'api_key', value: SECRET },
  tools: {
    workspace: { storeDirectory: '/srv/store', workspaceDirectory: '/srv/store/work' },
    stateParentDirectory: '/srv/state', bubblewrapPath: '/usr/bin/bwrap', filesystemHelperPath: '/opt/agenai/helper',
  },
};

test('the factory is inert and accepts the documented endpoint forms', () => {
  for (const apiBaseUrl of [undefined, 'https://gateway.example.com/anthropic', 'http://127.0.0.1:8080', 'http://[::1]:9000', 'http://localhost:4000']) {
    const driver = createNodeClaudeProviderDriver({ ...valid, ...(apiBaseUrl ? { apiBaseUrl } : {}), usageLimits: { maxBudgetUsdPerSession: 1 } });
    assert.equal(driver.providerKey, 'claude');
    assert.equal(driver.supportsMultipleInstances, false);
  }
});

test('invalid options are refused by field name without disclosing the credential', () => {
  const cases: Array<[string, unknown]> = [
    ['apiBaseUrl', { ...valid, apiBaseUrl: 'http://gateway.example.com' }],
    ['apiBaseUrl', { ...valid, apiBaseUrl: `https://user:${SECRET}@api.example.com` }],
    ['apiBaseUrl', { ...valid, apiBaseUrl: 'https://api.example.com/?key=1' }],
    ['apiBaseUrl', { ...valid, apiBaseUrl: 'https://api.example.com/#fragment' }],
    ['credential', { ...valid, credential: { kind: 'api_key', value: `${SECRET} ` } }],
    ['credential', { ...valid, credential: { kind: 'oauth', value: SECRET } }],
    ['executablePath', { ...valid, executablePath: 'claude' }],
    ['executablePath', { ...valid, executablePath: '/opt/claude/../claude' }],
    ['environment', { ...valid, environment: { ANTHROPIC_API_KEY: SECRET } }],
    ['usageLimits', { ...valid, usageLimits: { maxBudgetUsdPerSession: 0 } }],
    ['usageLimits', { ...valid, usageLimits: { maxBudgetUsdPerSession: Number.POSITIVE_INFINITY } }],
    ['usageLimits', { ...valid, usageLimits: { maxBudgetUsdPerSession: '1' } }],
    ['maxTokens', { ...valid, usageLimits: { maxTokens: 4_096 } }],
  ];
  for (const [field, options] of cases) {
    assert.throws(() => createNodeClaudeProviderDriver(options as NodeClaudeProviderOptions), (error: unknown) =>
      error instanceof NodeClaudeProviderOptionsError && error.message.includes(field) && !error.message.includes(SECRET)
      && !JSON.stringify(error).includes(SECRET), field);
  }
});

test('driver configuration carries exactly one model identifier', async () => {
  const driver = createNodeClaudeProviderDriver(valid);
  const providerKey = parseAgentProviderKey('claude');
  const instanceId = parseAgentInstanceId('claude-options');
  for (const driverConfiguration of [{}, { model: '' }, { model: 'claude-sonnet', apiKey: SECRET }, { model: 'has space' }]) {
    await assert.rejects(Promise.resolve().then(() => driver.materialize({ providerKey, instanceId, driverConfiguration })),
      (error: unknown) => error instanceof Error && error.cause instanceof NodeClaudeProviderOptionsError && !error.cause.message.includes(SECRET));
  }
});
