import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parseAgentApprovalRequest } from '@agen-ai/agent-protocol';
import { runApprovalPolicyWalkthrough, selectFixtureOnce } from './walkthrough.js';

test('the public policy walkthrough leaves independently readable exact effects and truthful admission and cleanup results', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'approval-policy-walkthrough-test-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const artifactDirectory = join(parent, 'artifacts');
  const report = await runApprovalPolicyWalkthrough({ artifactDirectory });
  assert.deepEqual({ example: report.example, evidence: report.evidence, nativeReview: report.nativeReview, nativeProcesses: report.nativeProcesses },
    { example: 'approval-policy', evidence: 'synthetic_contract_demonstration', nativeReview: 'not_exercised', nativeProcesses: 0 });
  assert.deepEqual(report.scenarios.map(({ name, requested, effective, resolution, marker, dispatch, cleanup }) =>
    ({ name, requested, effective, resolution, marker, dispatch, cleanup })), [
    ...['omitted', 'host', 'provider_auto_review', 'provider_bypass'].map((name) => ({
      name, requested: name === 'omitted' ? null : name,
      effective: name === 'omitted' ? null : { policy: { kind: name }, verification: 'controlled_configuration' },
      resolution: { optionId: 'approval:allow-once', decision: 'approved', receipt: 'delivered' },
      marker: { path: `${name}/marker.txt`, contents: `bounded-marker:${name}\n` },
      dispatch: { sessions: 1, turns: 1, outputReaders: 1 }, cleanup: { sessionsClosed: 1, instancesDisposed: 1 },
    })),
    { name: 'residual-denied', requested: 'provider_auto_review',
      effective: { policy: { kind: 'provider_auto_review' }, verification: 'controlled_configuration' },
      resolution: { optionId: 'approval:deny-once', decision: 'denied', receipt: 'delivered' }, marker: null,
      dispatch: { sessions: 1, turns: 1, outputReaders: 1 }, cleanup: { sessionsClosed: 1, instancesDisposed: 1 } },
  ]);
  for (const name of ['omitted', 'host', 'provider_auto_review', 'provider_bypass']) {
    assert.equal(await readFile(join(artifactDirectory, name, 'marker.txt'), 'utf8'), `bounded-marker:${name}\n`);
  }
  for (const scenario of report.scenarios) {
    assert.deepEqual(scenario.support, { kind: 'supported', policies: [
      { policy: 'host', operations: ['create'] }, { policy: 'provider_auto_review', operations: ['create'] },
      { policy: 'provider_bypass', operations: ['create'] },
    ] });
  }
  await assert.rejects(stat(join(artifactDirectory, 'residual-denied', 'marker.txt')), { code: 'ENOENT' });
  assert.deepEqual(report.genericAcp, { support: { kind: 'unsupported' }, requested: 'provider_auto_review',
    rejection: 'approval_policy_unsupported', refusal: { sessionOpenings: 0, prompts: 0, marker: false },
    omitted: { effective: null, sessionOpenings: 1, prompts: 1,
      marker: { path: 'generic-acp/marker.txt', contents: 'generic-acp-omitted\n' } }, cleanup: { connectionsReleased: 1 } });
  assert.equal(await readFile(join(artifactDirectory, 'generic-acp', 'marker.txt'), 'utf8'), 'generic-acp-omitted\n');
  await assert.rejects(runApprovalPolicyWalkthrough({ artifactDirectory }), { code: 'EEXIST' });
  assert.equal(await readFile(join(artifactDirectory, 'host', 'marker.txt'), 'utf8'), 'bounded-marker:host\n');
});

test('the teaching decision selects the exact once-only offer and refuses a missing offer despite remembered approval', () => {
  const request = parseAgentApprovalRequest({ requestKind: 'approval', requestId: 'chooser:request', prompt: 'Owned teaching action',
    subject: { kind: 'other', title: 'Teaching marker', itemId: 'chooser:item' }, options: [
      { optionId: 'approval:remember', label: 'Remember approval', decision: 'approved', consequence: {
        kind: 'provider_managed_remembrance', duration: { kind: 'unknown' }, applicability: { kind: 'unknown' },
        explanation: 'Provider-managed remembering is outside this teaching choice.' } },
      { optionId: 'approval:allow-once', label: 'Once', decision: 'approved',
        consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } },
      { optionId: 'approval:deny-once', label: 'Deny once', decision: 'denied',
        consequence: { kind: 'scoped', persistence: 'once', scope: { kind: 'exact_action' } } },
    ] });
  assert.deepEqual(selectFixtureOnce(request, 'approved'), { requestKind: 'approval', requestId: 'chooser:request',
    disposition: 'selected', optionId: 'approval:allow-once' });
  assert.deepEqual(selectFixtureOnce(request, 'denied'), { requestKind: 'approval', requestId: 'chooser:request',
    disposition: 'selected', optionId: 'approval:deny-once' });
  assert.throws(() => selectFixtureOnce({ ...request, options: request.options.filter((option) => option.optionId !== 'approval:allow-once') }, 'approved'),
    { message: 'The exact once-only fixture option was not offered.' });
});
