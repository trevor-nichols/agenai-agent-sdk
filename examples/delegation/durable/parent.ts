// ------------------------------------------------------------------------------------------------
//                parent.ts - Fresh parent authority and an owned public-runtime continuation
// ------------------------------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { parseAgentSessionId, parseAgentTurnId } from '@agen-ai/agent-protocol';
import type { AgentProviderRegistry, AgentProviderSession } from '@agen-ai/agent-runtime';
import type { DelegationTarget } from '@agen-ai/agent-orchestration';
import type { ParentInboxHost } from '../inbox/index.js';
import { readAuthority } from './state.js';

export const parentSessionPrefix = 'durable:parent:';

export function createDurableParent(root: string, registry?: AgentProviderRegistry, target?: DelegationTarget): ParentInboxHost {
  let owned = false;
  return {
    inspectParent: () => readAuthority(root),
    acquireTurn() {
      if (owned || !registry || !target) return undefined;
      const revision = readAuthority(root).revision;
      owned = true;
      const controller = new AbortController();
      let session: AgentProviderSession | undefined;
      function assertCurrent() {
        const current = readAuthority(root);
        if (!owned || current.revision !== revision || current.lifecycle !== 'idle' || !current.executionAllowed || !current.resultAccess) {
          throw new Error('Current parent continuation authority is unavailable.');
        }
      }
      return { signal: controller.signal, assertCurrent,
        async dispatch({ envelope, signal }) {
          assertCurrent();
          signal.throwIfAborted();
          session = await registry.requireInstance(target.instanceId).adapter.createSession({
            sessionId: parseAgentSessionId(`${parentSessionPrefix}${randomUUID()}`), workingDirectory: root,
            configuration: target.application.configuration, onBindingCreated() {}, signal,
          });
          for (const selection of target.application.beforeFirstTurn) {
            if (session.configuration.kind !== 'selectable') throw new Error('The example parent configuration is not selectable.');
            const applied = await session.configuration.applyConfigurationSelection({ selection, signal, onProviderExecutionStarted: assertCurrent });
            if (applied.status !== 'completed') throw new Error('The example parent configuration is uncertain.');
          }
          let completed = false;
          for await (const output of session.startTurn({ turnId: parseAgentTurnId(`durable:completion:${envelope.notificationId}`),
            interactionMode: 'default', parts: [{ type: 'text', text: JSON.stringify(envelope) }],
            signal, onProviderExecutionStarted: assertCurrent }).outputs) {
            if (output.kind === 'event' && output.event.type === 'turn.completed') completed = output.event.payload.outcome === 'completed';
          }
          return { status: completed ? 'acknowledged' : 'uncertain' };
        },
        async release() {
          if (session) { await session.close({ reason: 'shutdown' }); session = undefined; }
          owned = false;
        },
      };
    },
  };
}
