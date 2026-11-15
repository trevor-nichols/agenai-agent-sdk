import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentApprovalRequest } from '@agen-ai/agent-protocol';
import { exactAction, exactListDecider, onceResolution } from '../decisions.js';

// Teaching fixture: the option shapes a provider may offer, including broader grants that must never be chosen.
const once = { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } as const;
const session = { kind: 'scoped', persistence: 'session', scope: { kind: 'exact_action' } } as const;
function request(options: ReadonlyArray<Readonly<{ optionId: string; decision: 'approved' | 'denied'; consequence: unknown }>>): AgentApprovalRequest {
  return { requestKind: 'approval', requestId: 'request-1', prompt: 'Run this command once?', subject: { kind: 'command', title: 'Run command' },
    options: options.map((option) => ({ label: option.optionId, ...option })) } as unknown as AgentApprovalRequest;
}

test('approval picks the single exact once-only option and never a broader grant', () => {
  const offered = request([
    { optionId: 'approve-session', decision: 'approved', consequence: session },
    { optionId: 'approve-once', decision: 'approved', consequence: once },
    { optionId: 'deny-once', decision: 'denied', consequence: once },
  ]);
  assert.deepEqual(onceResolution(offered, 'approve_once'), {
    resolution: { requestKind: 'approval', requestId: 'request-1', disposition: 'selected', optionId: 'approve-once' }, exact: true });
  assert.deepEqual(onceResolution(offered, 'deny_once').resolution, {
    requestKind: 'approval', requestId: 'request-1', disposition: 'selected', optionId: 'deny-once' });
});

test('a request without exactly one matching once-only option is canceled, not answered', () => {
  const broaderOnly = request([{ optionId: 'approve-session', decision: 'approved', consequence: session }]);
  const ambiguous = request([
    { optionId: 'approve-a', decision: 'approved', consequence: once },
    { optionId: 'approve-b', decision: 'approved', consequence: once },
  ]);
  for (const offered of [broaderOnly, ambiguous]) {
    assert.deepEqual(onceResolution(offered, 'approve_once'), {
      resolution: { requestKind: 'approval', requestId: 'request-1', disposition: 'canceled' }, exact: false });
  }
});

test('the exact action comes from the provider request context, never from display text', () => {
  const offered = request([]);
  assert.deepEqual(exactAction(offered, { data: { action: { kind: 'command', command: "printf 'x\\n' > marker.txt" } } }),
    { kind: 'command', command: "printf 'x\\n' > marker.txt" });
  assert.deepEqual(exactAction(offered, { data: { action: { kind: 'edit', paths: ['a.txt', 'docs/b.md'], reason: 'restricted' } } }),
    { kind: 'edit', paths: ['a.txt', 'docs/b.md'], reason: 'restricted' });
  assert.equal(exactAction(offered, undefined), undefined);
  assert.equal(exactAction(offered, { data: { action: { kind: 'command', command: 'ls', extra: true } } }), undefined);
  assert.equal(exactAction(offered, { data: { action: { kind: 'delete', path: 'a.txt' } } }), undefined);
});

test('the exact-list decider approves byte-identical commands and fully listed paths only', async () => {
  const decide = exactListDecider({ kind: 'exact', commands: ['wc -l notes.txt'], edits: ['docs/a.md'], reads: ['secrets/token'] });
  const signal = new AbortController().signal;
  assert.equal(await decide({ kind: 'command', command: 'wc -l notes.txt' }, signal), 'approve_once');
  assert.equal(await decide({ kind: 'command', command: 'wc -l notes.txt ' }, signal), 'deny_once');
  assert.equal(await decide({ kind: 'command', command: 'wc -l notes.txt; rm -rf docs' }, signal), 'deny_once');
  assert.equal(await decide({ kind: 'edit', paths: ['docs/a.md'], reason: 'restricted' }, signal), 'approve_once');
  assert.equal(await decide({ kind: 'edit', paths: ['docs/a.md', '.env'], reason: 'host_policy' }, signal), 'deny_once');
  assert.equal(await decide({ kind: 'read', path: 'secrets/token' }, signal), 'approve_once');
  assert.equal(await decide({ kind: 'read', path: 'secrets/other' }, signal), 'deny_once');
});
