import { createHash } from 'node:crypto';
import type { AcpJsonValue } from '@agen-ai/acp-transport';
import {
  compareStringsByUnicodeCodePoint,
  parseAgentCommandCatalog,
  parseAgentEnvironmentSnapshot,
  type AgentCommandCatalog,
  type AgentEnvironmentId,
  type AgentEnvironmentInvalidation,
} from '@agen-ai/agent-protocol';
import { throwIfAgentOperationAborted, type AgentEnvironmentObservationPort } from '@agen-ai/agent-runtime';
import type { AcpProviderLimits } from '../limits.js';
import { hostObject, hostText, invalidHostRequest } from '../host/validation.js';

interface Watcher {
  readonly environmentId: AgentEnvironmentId;
  pending: boolean;
  wake: (() => void) | undefined;
}

export function createAcpSessionEnvironment(input: {
  readonly limits: AcpProviderLimits;
  readonly now: () => string;
  readonly signal: AbortSignal;
}) {
  const watchers = new Set<Watcher>();
  let catalog: AgentCommandCatalog | undefined;
  let revision = 1;
  let closed = false;
  const close = () => { closed = true; for (const watcher of watchers) watcher.wake?.(); watchers.clear(); };
  input.signal.addEventListener('abort', close, { once: true });
  if (input.signal.aborted) close();
  const port: AgentEnvironmentObservationPort = Object.freeze({
    kind: 'read_and_watch', domains: Object.freeze(['commands'] as const),
    async readEnvironment(context) {
      throwIfAgentOperationAborted(context.signal);
      if (closed) throw input.signal.reason ?? new DOMException('Environment closed.', 'AbortError');
      return parseAgentEnvironmentSnapshot({
        schemaVersion: 1, environmentId: context.environmentId, revision,
        content: { kind: 'unsupported', reasons: [] }, extensions: { kind: 'unsupported', reasons: [] }, integrations: { kind: 'unsupported', reasons: [] },
        commands: catalog ? { kind: 'available', catalog, extent: 'session', completeness: 'complete', reasons: [] }
          : { kind: 'not_initialized', reasons: ['missing_metadata'] },
      });
    },
    async *watchEnvironment(context) {
      throwIfAgentOperationAborted(context.signal);
      if (closed) return;
      if (watchers.size >= input.limits.maxQueuedMessages) throw invalidHostRequest();
      const watcher: Watcher = { environmentId: context.environmentId, pending: false, wake: undefined };
      const abort = () => watcher.wake?.();
      watchers.add(watcher);
      context.signal.addEventListener('abort', abort, { once: true });
      try {
        while (!closed && !context.signal.aborted) {
          if (!watcher.pending) await new Promise<void>((resolve) => { watcher.wake = resolve; if (closed || context.signal.aborted || watcher.pending) resolve(); });
          watcher.wake = undefined;
          if (closed || context.signal.aborted) return;
          watcher.pending = false;
          const invalidation: AgentEnvironmentInvalidation = { environmentId: watcher.environmentId, domains: ['commands'] };
          yield Object.freeze(invalidation);
        }
      } finally { watchers.delete(watcher); context.signal.removeEventListener('abort', abort); }
    },
  });
  return {
    port,
    observeCommands(value: AcpJsonValue): void {
      if (closed) return;
      if (!Array.isArray(value) || value.length > 1_024 || Buffer.byteLength(JSON.stringify(value), 'utf8') > Math.min(input.limits.maxQueuedBytes, 512 * 1_024)) throw invalidHostRequest();
      const names = new Set<string>();
      const commands = value.map((entry) => {
        const command = hostObject(entry);
        const name = hostText(command.name, 200);
        const summary = hostText(command.description, 2_000, true);
        if (names.has(name)) throw invalidHostRequest();
        names.add(name);
        const id = `acp:command:${createHash('sha256').update(name).digest('hex')}`;
        const prior = catalog?.commands.find((item) => item.commandId === id);
        const description = summary === '' ? undefined : summary;
        const descriptorRevision = prior && prior.name === name && prior.summary === description ? prior.revision : revision + 1;
        return { commandId: id, revision: descriptorRevision, name, ...(description === undefined ? {} : { summary: description }),
          source: { scope: 'unknown', origin: 'unknown' }, availability: { kind: 'known', value: true } };
      }).sort((left, right) => compareStringsByUnicodeCodePoint(left.commandId, right.commandId));
      const next = parseAgentCommandCatalog({ revision: revision + 1, observedAt: input.now(), commands });
      catalog = next;
      revision += 1;
      for (const watcher of watchers) { watcher.pending = true; watcher.wake?.(); }
    },
    close() { input.signal.removeEventListener('abort', close); close(); },
  };
}
