// ------------------------------------------------------------------------------------------------
//                query.ts - Guarded sole-reader query ownership and retryable borrowed-workload cleanup
// ------------------------------------------------------------------------------------------------

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Sandbox } from '@agen-ai/sandbox';
import { admitSpawn, claudeOptions, parseClaudeSandboxRequest } from './config.js';
import { claudeEgress } from './egress.js';
import { createClaudeProcess } from './process.js';
import type { ClaudeProcessSettlement, ClaudeSandboxRequest, ClaudeSandboxRun, ClaudeSdk } from './types.js';

export function createSandboxClaudeRun(sdk: ClaudeSdk, sandbox: Sandbox, input: ClaudeSandboxRequest): ClaudeSandboxRun {
  const request = parseClaudeSandboxRequest(input);
  const egress = claudeEgress(sandbox);
  request.signal?.throwIfAborted();
  const controller = new AbortController();
  let bridge: ReturnType<typeof createClaudeProcess> | undefined;
  let query: ReturnType<ClaudeSdk['query']> | undefined;
  let queryFailure: Error | undefined;
  let cleanupWork: Promise<void> | undefined;
  let readerClaimed = false; let closed = false;
  let reader: AsyncGenerator<SDKMessage, void> | undefined;
  const processReady = Promise.withResolvers<ClaudeProcessSettlement>();
  const readerDone = Promise.withResolvers<void>();

  const cleanup = () => {
    if (!cleanupWork) {
      closed = true;
      cleanupWork = (async () => {
        const errors: unknown[] = [];
        try { query?.close(); } catch (error) { errors.push(error); }
        try { if (bridge) await bridge.cleanup(); } catch (error) { errors.push(error); }
        if (errors.length) throw new AggregateError(errors, 'Claude query cleanup failed; retain this run and retry cleanup.');
        if (reader) { await reader.return(); readerDone.resolve(); }
        if (readerClaimed) await readerDone.promise;
        request.signal?.removeEventListener('abort', abort);
      })().catch((error: unknown) => { cleanupWork = undefined; throw error; });
    }
    return cleanupWork;
  };
  const abort = () => { controller.abort(request.signal?.reason); void cleanup().catch(() => {}); };
  request.signal?.addEventListener('abort', abort, { once: true });
  try {
    const options = claudeOptions(request, sandbox.workspace, controller, egress);
    options.spawnClaudeCodeProcess = (spawn) => {
      if (bridge || closed) throw new Error('Claude permits exactly one sandbox process reservation.');
      bridge = createClaudeProcess(sandbox, admitSpawn(spawn, request, sandbox.workspace, egress));
      bridge.settled.then(processReady.resolve);
      return bridge.child;
    };
    query = sdk.query({ prompt: request.prompt, options });
    if (!bridge) throw new Error('The exact Claude SDK did not enter its synchronous spawn boundary.');
  } catch (error) {
    queryFailure = error instanceof Error ? error : new Error(String(error));
    if (!bridge) processReady.resolve({ kind: 'failed', error: queryFailure });
    void cleanup().catch(() => {});
  }
  const messages: AsyncIterable<SDKMessage> = {
    [Symbol.asyncIterator]() {
      if (readerClaimed) throw new Error('Claude messages permit one reader.');
      if (closed) throw queryFailure ?? new Error('Claude query is closed.');
      readerClaimed = true;
      reader = (async function* () {
        let completed = false;
        try {
          if (queryFailure) throw queryFailure;
          if (!query) throw new Error('Claude query is unavailable.');
          for await (const message of query) yield message;
          completed = true;
        } finally {
          readerDone.resolve();
          if (!completed) void cleanup().catch(() => {});
        }
      })();
      const enteredReader = reader;
      let pulling = false; let finished = false;
      return {
        next() {
          if (finished) return Promise.resolve({ done: true as const, value: undefined });
          if (pulling) return Promise.reject(new Error('Claude messages permit one outstanding read.'));
          pulling = true;
          return enteredReader.next().then((result) => { finished = result.done ?? false; return result; },
            (error: unknown) => { finished = true; throw error; }).finally(() => { pulling = false; });
        },
        async return() { await cleanup(); finished = true; return { done: true as const, value: undefined }; },
      };
    },
  };
  return { messages, settled: processReady.promise, cleanup, get stderr() { return bridge?.stderr ?? new Uint8Array(); } };
}
