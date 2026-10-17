import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAgentConfigurationRevisionId, parseAgentInstanceId, parseAgentSessionBinding,
  parseAgentSessionId, type AgentSessionPlanReviewResponse,
} from '@agen-ai/agent-protocol';
import {
  createAgentProviderRegistry, isAgentProviderSessionCleanupErrorFor,
  type AgentProviderSession, type AgentProviderSessionCleanupError, type AgentResumeSessionInput,
  type AgentSessionInteraction,
} from '@agen-ai/agent-runtime';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';
import { assertPeerGone, controlledPeerBoundary } from './fixtures/session-continuations/peer-boundary.js';
import { ContinuationExampleCleanupError, deferred, within } from './fixtures/session-continuations/shared.js';

// Synthetic composition proof for one explicitly selected mapping. This does not qualify Grok,
// change a production provider tuple, or establish any private execution authority.
const mapping = 'grok-build-1.0.60-session-requests-v1';
const workingDirectory = await mkdtemp(join(tmpdir(), 'agent-sdk-session-continuations-'));
const executable = join(workingDirectory, 'controlled-peer.mjs');
const auditPath = join(workingDirectory, 'native-frames.jsonl');
const transcript: string[] = [];
try {
  const peer = await readFile(new URL('./fixtures/session-continuations/acp-peer.mjs', import.meta.url), 'utf8');
  await writeFile(executable, `#!${await realpath(process.execPath)}\n${peer}`, { mode: 0o700 });
  const driver = createNodeAcpProviderDriver({ providerKey: 'example-session-continuations-acp',
    sessionInteractions: { mapping }, executionBoundary: controlledPeerBoundary(),
    launch: { executable, args: ['agent', '--no-leader', 'stdio'], cwd: workingDirectory,
      env: { SESSION_CONTINUATIONS_AUDIT: auditPath }, shutdownTimeoutMs: 1_000 },
    limits: { initializationTimeoutMs: 3_000 },
  });
  const instanceId = parseAgentInstanceId('session-continuations-acp:instance');
  const registry = await createAgentProviderRegistry({ drivers: [driver],
    definitions: [{ providerKey: driver.providerKey, instanceId, driverConfiguration: {} }] });
  let retainedSession: AgentProviderSession | undefined;
  let retainedOpening: AgentProviderSessionCleanupError | undefined;
  let cleanupHeld = false;
  let operationFailure: { error: unknown } | undefined;
  const closeSession = async () => {
    if (!retainedSession) return;
    await within(Promise.resolve(retainedSession.close({ reason: 'shutdown', signal: AbortSignal.timeout(2_000) })), 'ACP cleanup', 3_000);
    retainedSession = undefined;
  };
  const cleanup = async () => {
    if (retainedOpening) {
      await within(retainedOpening.retryCleanup(), 'ACP opening cleanup', 3_000);
      retainedOpening = undefined;
    }
    await closeSession();
    await registry.dispose();
  };
  const offer = deferred<AgentSessionInteraction>();
  const consumed = deferred<void>();
  void consumed.promise.catch(() => {});
  const output: string[] = [];
  let openingReturned = false;
  let parkedBeforeResponse = false;
  let continuations = 0;
  let callbacksJoined = 0;
  let outcome: string | undefined;
  let report;
  let resultReport;
  try {
    const adapter = registry.requireInstance(instanceId).adapter;
    assert.ok(adapter.resumption.kind === 'supported');
    if (adapter.resumption.kind !== 'supported') throw new Error('The selected mapping requires exact resumption.');
    const openingInput: AgentResumeSessionInput = {
      sessionId: parseAgentSessionId('session-continuations-acp:session'), workingDirectory,
      binding: parseAgentSessionBinding({ conversationId: 'controlled-session-continuations' }),
      configuration: { kind: 'managed', revision: parseAgentConfigurationRevisionId('session-continuations-acp:configuration') },
      signal: AbortSignal.timeout(10_000),
      interactions: { humanWait: { kind: 'until_withdrawn_or_closed' },
        limits: { responseTimeoutMs: 2_000, cleanupTimeoutMs: 2_000 },
        onRequest(interaction) {
          assert.equal(openingReturned, true);
          transcript.push('review.offered');
          offer.resolve(interaction);
        },
      },
      nativeContinuations: { async onExecution(continuation) {
        continuations += 1;
        const iterator = continuation.execution.outputs[Symbol.asyncIterator]();
        const first = iterator.next();
        parkedBeforeResponse = true;
        transcript.push('reader.parked');
        try {
          for (let next = await first; !next.done; next = await iterator.next()) {
            if (next.value.kind !== 'event') continue;
            const event = next.value.event;
            transcript.push(`output:${event.type}`);
            if (event.type === 'content.delta') output.push(event.payload.delta);
            if (event.type === 'turn.completed') assert.equal(event.payload.outcome, 'completed');
          }
          outcome = (await continuation.outcome).kind;
          consumed.resolve();
        } catch (cause) { consumed.reject(cause); throw cause; }
        finally { callbacksJoined += 1; transcript.push('host.reader.joined'); }
      } },
    };
    try { retainedSession = await adapter.resumption.resumeSession(openingInput); }
    catch (cause) {
      if (isAgentProviderSessionCleanupErrorFor(cause, openingInput)) {
        retainedOpening = cause;
        cleanupHeld = true;
        // Propagating a failed opening does not trigger a cleanup retry or dispose its registry.
        throw new ContinuationExampleCleanupError([cause], cleanup);
      }
      throw cause;
    }
    openingReturned = true;
    transcript.push('opening.returned');
    try {
      const interaction = await within(offer.promise, 'Restored review presentation');
      assert.equal(interaction.request.kind, 'plan_review');
      if (interaction.request.kind !== 'plan_review') throw new Error('Expected the exact restored review.');
      const request = interaction.request;
      assert.deepEqual(interaction.deadline, { kind: 'no_deadline' });
      assert.equal(request.plan.content.text, '# Restored plan\n\nPerform the reviewed task.\n');
      const choice = request.choices.find((offered) => offered.action === 'approve');
      assert.ok(choice);
      // Present the immutable snapshot and the actual offered actions before collecting a user choice.
      const response: AgentSessionPlanReviewResponse = { kind: 'plan_review', action: 'approve', choiceId: choice.choiceId,
        planId: request.plan.planId, revision: request.plan.revision };
      transcript.push(`host.selected:${response.action}:${response.choiceId}`);
      const receipt = await within(interaction.respond(response), 'Restored review response');
      assert.equal(receipt.status, 'delivered', 'Do not resend an uncertain answer.');
      transcript.push('answer.delivered');
      await within(consumed.promise, 'Original continuation reader');
      assert.equal(outcome, 'started');
      assert.equal(continuations, 1);
      assert.deepEqual(output, ['Controlled continuation output.']);
      report = { operation: 'resume', requestKind: request.kind, timing: 'after_open_return',
        planId: response.planId, revision: response.revision, action: response.action, choiceId: response.choiceId,
        deadline: interaction.deadline, receipt: receipt.status, outcome, continuations, output,
      };
    } catch (cause) {
      operationFailure = { error: cause };
      throw cause;
    } finally {
      try { await closeSession(); }
      catch (cause) {
        cleanupHeld = true;
        throw new ContinuationExampleCleanupError(operationFailure ? [operationFailure.error, cause] : [cause], cleanup);
      }
      transcript.push('session.closed');
    }
    // Read the peer's actual wire audit and independently probe it before registry/outer cleanup.
    const audit: unknown[] = (await readFile(auditPath, 'utf8')).trim().split(/\r?\n/u).map((line: string) => JSON.parse(line));
    const started = audit.find((entry) => typeof entry === 'object' && entry !== null && 'kind' in entry && entry.kind === 'started');
    assert.ok(started && typeof started === 'object' && 'pid' in started && typeof started.pid === 'number');
    assertPeerGone(started.pid);
    transcript.push('peer.process_gone');
    const hostFrames = audit.flatMap((entry) => entry && typeof entry === 'object' && 'kind' in entry
      && entry.kind === 'host_to_peer' && 'frame' in entry && entry.frame && typeof entry.frame === 'object' ? [entry.frame] : []);
    const loads = hostFrames.filter((frame) => 'method' in frame && frame.method === 'session/load').length;
    const prompts = hostFrames.filter((frame) => 'method' in frame && frame.method === 'session/prompt').length;
    const nativeResponses = hostFrames.filter((frame) => 'id' in frame && frame.id === 'controlled-review').length;
    assert.deepEqual({ loads, prompts, nativeResponses }, { loads: 1, prompts: 0, nativeResponses: 1 });
    assert.equal(callbacksJoined, 1);
    assert.equal(parkedBeforeResponse, true);
    resultReport = { example: 'session-continuations-acp', evidence: 'synthetic', mapping,
      ...report, loads, prompts, nativeResponses, parkedBeforeResponse, callbacksJoined,
      peerProcessGone: true, nativeQualification: 'not_performed', transcript, cleanup: 'joined' };
  } finally {
    if (!cleanupHeld) {
      try { await registry.dispose(); }
      catch (cause) { throw new ContinuationExampleCleanupError([cause], cleanup); }
    }
  }
  console.log(JSON.stringify(resultReport));
  await rm(workingDirectory, { recursive: true, force: true });
} catch (cause) {
  console.error(`Inspect retained synthetic wire evidence at ${workingDirectory}. Transcript: ${JSON.stringify(transcript)}`);
  throw cause;
}
