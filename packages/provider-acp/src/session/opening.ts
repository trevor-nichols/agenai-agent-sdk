import {
  createAcpStandardSessionOperations,
  type AcpClient,
  type AcpJsonObject,
  type AcpResponseReceived,
} from '@agen-ai/acp-transport';
import { parseAgentProviderConversationId, parseAgentSessionBinding, type AgentSessionBinding } from '@agen-ai/agent-protocol';

import type { CreateAcpProviderSessionInput } from './create.js';
import { AcpProviderSessionError } from './errors.js';
import { nativeBytes, nativeObject, nativeString } from './native.js';

/** Only session control RPCs use this client; active prompts cannot acquire request-scope host interaction authority. */
export function acpSessionControlClient(input: CreateAcpProviderSessionInput): AcpClient {
  return {
    ...input.connection.client,
    request: (method, params, options) => input.connection.requestWithScope(method, params, {
      kind: 'session', sessionId: input.context.sessionId, workingDirectory: input.context.workingDirectory,
    }, options),
  };
}

export class AcpHistoryReplay {
  active = false;
  private messages = 0;
  private bytes = 0;

  constructor(private readonly limits: { readonly maxQueuedMessages: number; readonly maxQueuedBytes: number }) {}

  observe(params: AcpJsonObject): void {
    if (!this.active) return;
    this.messages += 1;
    this.bytes += nativeBytes(params);
    if (this.messages > this.limits.maxQueuedMessages || this.bytes > this.limits.maxQueuedBytes) {
      throw new AcpProviderSessionError('acp_history_limit_exceeded', 'ACP historical replay exceeds the session opening budget.');
    }
  }
}

export async function openAcpNativeSession(input: CreateAcpProviderSessionInput, hooks: {
  readonly replay: AcpHistoryReplay;
  readonly bind: (binding: AgentSessionBinding) => void;
  readonly observeSetup: (result: AcpJsonObject) => void;
  readonly completeOpeningResponse?: () => void;
}): Promise<void> {
  const client = acpSessionControlClient(input);
  const operations = createAcpStandardSessionOperations(client);
  const resumed = input.resume;
  const sessionInteractions = input.context.interactions ? input.connection.sessionInteractions : undefined;
  if (resumed) {
    hooks.bind(resumed.binding);
    hooks.replay.active = resumed.method === 'session/load';
  }
  const params = { cwd: input.context.workingDirectory, mcpServers: [...input.mcpServers ?? []] };
  const options = {
    ...(input.context.signal === undefined ? {} : { signal: input.context.signal }),
    timeoutMs: input.limits.initializationTimeoutMs,
    ...(sessionInteractions ? { onRequestDispatch: () => sessionInteractions.onOpeningDispatched() } : {}),
    onResponseReceived: (response: AcpResponseReceived) => {
      hooks.replay.active = false;
      if (response.kind === 'error') return;
      const result = nativeObject(response.result, 'session setup response');
      if (!resumed) {
        const binding = parseAgentSessionBinding({ conversationId: parseAgentProviderConversationId(nativeString(result.sessionId, 'session identity')) });
        hooks.bind(binding);
        if (!('onBindingCreated' in input.context)) throw new TypeError('Creating an ACP session requires a binding observer.');
        input.context.onBindingCreated(binding);
      }
      hooks.observeSetup(result);
      hooks.completeOpeningResponse?.();
    },
  };
  if (resumed?.method === 'session/resume') await client.request('session/resume', { ...params, sessionId: resumed.binding.conversationId }, options);
  else if (resumed) await operations.loadSession({ ...params, sessionId: resumed.binding.conversationId }, options);
  else await operations.newSession(params, options);
}
