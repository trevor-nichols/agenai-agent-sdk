import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { AcceptEditsConfigError, parseAcceptEditsConfig } from '../config.js';

const template = JSON.parse(await readFile(new URL('../run-config.example.json', import.meta.url), 'utf8')) as Record<string, unknown>;

test('the shipped configuration template is a valid starting point', () => {
  const config = parseAcceptEditsConfig(template);
  assert.equal(config.policy, 'provider_accept_edits');
  assert.deepEqual(config.approvals, { kind: 'exact', commands: ['wc -l notes.txt'], edits: [], reads: [] });
});

test('configuration refuses ambiguous paths, unknown fields and unsupported provider routes', () => {
  const invalid = [
    { ...template, workspace: { storeDirectory: 'relative/store', stateParentDirectory: '/state' } },
    { ...template, workspace: { storeDirectory: '/store/../elsewhere', stateParentDirectory: '/state' } },
    { ...template, credential: { kind: 'api_key', value: 'inline-keys-are-not-accepted' } },
    { ...template, approvals: { kind: 'exact', commands: [], edits: ['../outside.txt'], reads: [] } },
    { ...template, approvals: { kind: 'always' } },
    { ...template, route: 'openai' },
    { ...template, fallbackPolicy: 'host' },
    { ...template, workspace: { storeDirectory: '/store', stateParentDirectory: '/state', shared: true } },
    { ...template, limits: { ...(template.limits as object), maxToolItems: 0 } },
    { ...template, nativeLimits: { provider: 'opencode', maxOutputTokensPerRequest: 4_096 } },
    { ...template, nativeLimits: { provider: 'claude', maxBudgetUsdPerSession: 0 } },
    { ...template, nativeLimits: { provider: 'claude', maxOutputTokensPerRequest: 4_096 } },
    { ...template, provider: 'opencode', route: 'openai', nativeLimits: { provider: 'opencode', maxModelStepsPerTurn: 0 } },
  ];
  for (const value of invalid) assert.throws(() => parseAcceptEditsConfig(value), AcceptEditsConfigError);
  assert.equal(parseAcceptEditsConfig({ ...template, provider: 'opencode', route: 'openai',
    nativeLimits: { provider: 'opencode', maxOutputTokensPerRequest: 4_096, maxModelStepsPerTurn: 12 } }).route, 'openai');
});
