// ------------------------------------------------------------------------------------------------
//                acp-session-cleanup.ts - ACP example retains its bootstrap and parent opening owners
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentProviderSessionCleanupError, type AgentProviderDriver } from '@agen-ai/agent-runtime';
import { createFakeAgentProvider } from '@agen-ai/agent-runtime/testing';
import { runAcpDelegationExample } from '../delegation/acp.js';
import { exampleConfiguration } from '../delegation/provider.js';

function containsError(error: unknown, expected: unknown): boolean {
  return error === expected || (error instanceof AggregateError
    && error.errors.some((nested: unknown) => containsError(nested, expected)));
}

// Successful ACP execution cannot observe ownership after a failed bootstrap or parent opening.
const failures: unknown[] = [];
for (const phase of ['bootstrap-opening', 'bootstrap-close', 'parent-opening'] as const) {
  const fake = createFakeAgentProvider();
  const workingDirectory = await mkdtemp(join(tmpdir(), `acp-cleanup-${phase}-`));
  let cleanupAttempts = 0;
  let originalOpeningFailure: unknown;
  const driver: AgentProviderDriver = { ...fake.driver, async materialize(definition) {
    const instance = await fake.driver.materialize(definition);
    return { ...instance, adapter: { ...instance.adapter,
      hostBinding: { kind: 'supported', toolTransport: 'callback', instructionPlacements: ['tool_context'] },
      async createSession(input) {
        const session = await instance.adapter.createSession(input);
        const bootstrap = input.sessionId === 'example-acp:catalog';
        if ((phase === 'bootstrap-opening' && bootstrap) || (phase === 'parent-opening' && !bootstrap)) {
          const failure = createAgentProviderSessionCleanupError({
            providerKey: fake.driver.providerKey, openingInput: input,
            errors: [new Error(`The ${phase} native owner remains retained.`)],
            async retryCleanup() {
              cleanupAttempts += 1;
              if (cleanupAttempts === 1) throw new Error('ACP example native cleanup is still pending.');
              await session.close({ reason: 'shutdown' });
            },
          });
          originalOpeningFailure = failure;
          throw failure;
        }
        return { ...session,
          configuration: { kind: 'selectable', listConfiguration: exampleConfiguration,
            applyConfigurationSelection() { throw new Error('This cleanup fixture must not start a child.'); } },
          async close(input) {
            if (phase === 'bootstrap-close' && bootstrap) {
              cleanupAttempts += 1;
              if (cleanupAttempts <= 2) throw new Error('ACP example native cleanup is still pending.');
            }
            await session.close(input);
          },
        };
      },
    } };
  } };
  try {
    let retained: unknown;
    try { await runAcpDelegationExample(driver, workingDirectory); }
    catch (error) { retained = error; }
    if (phase !== 'bootstrap-close') assert.ok(originalOpeningFailure, 'The fixture must enter the exact native opening');
    else assert.ok(cleanupAttempts > 0, 'The fixture must enter bootstrap close');
    assert.equal(fake.snapshot().instanceDisposeCount, 0, `${phase}: registry disposal must wait for native cleanup`);
    assert.equal(cleanupAttempts, phase === 'bootstrap-close' ? 1 : 0, 'Failed propagation cannot automatically retry cleanup');
    assert.ok(retained instanceof AggregateError && 'retryCleanup' in retained && typeof retained.retryCleanup === 'function',
      'The ACP example must return an executable cleanup owner');
    if (originalOpeningFailure) assert.ok(containsError(retained, originalOpeningFailure), 'Retain the exact opening failure');
    await assert.rejects(retained.retryCleanup(), /ACP example native cleanup is still pending/u);
    assert.equal(fake.snapshot().instanceDisposeCount, 0, 'A failed cleanup retry must retain the registry');
    await retained.retryCleanup();
    assert.equal(fake.snapshot().instanceDisposeCount, 1);
    const expectedClosedSessions = phase === 'parent-opening' ? 2 : 1;
    assert.equal(Object.values(fake.snapshot().closeCounts).reduce((sum, count) => sum + count, 0), expectedClosedSessions);
    assert.equal(fake.snapshot().turnIds.length, 0, 'Opening and cleanup proof must not invoke a provider turn');
    await retained.retryCleanup();
    assert.equal(fake.snapshot().instanceDisposeCount, 1, 'Completed cleanup remains idempotent');
    assert.equal(cleanupAttempts, phase === 'bootstrap-close' ? 3 : 2);
  } catch (error) {
    failures.push(error);
  } finally {
    // This fixture's provider owns no native process; the caller alone owns its temporary root.
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
if (failures.length > 0) throw new AggregateError(failures, 'ACP example cleanup ownership qualification failed.');
console.log(JSON.stringify({ example: 'acp-session-cleanup', bootstrapOpeningRetry: true,
  bootstrapCloseRetry: true, parentOpeningRetry: true, cleanup: 'closed' }));
