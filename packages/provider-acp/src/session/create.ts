import type { AgentCapabilities, AgentSessionBinding } from '@agen-ai/agent-protocol';
import { createAgentProviderSessionCleanupError, type AgentProviderCreateSessionInput, type AgentProviderResumeSessionInput,
  type AgentProviderSession, type AgentProviderSessionContext } from '@agen-ai/agent-runtime';

import type { AcpInitializedConnection } from '../connection/contracts.js';
import type { AcpProviderLimits } from '../limits.js';
import { SessionState } from './session.js';
import type { AcpPermissionMappingSelection } from '../permissions/contracts.js';

export interface CreateAcpProviderSessionInput {
  readonly context: AgentProviderCreateSessionInput | AgentProviderResumeSessionInput;
  readonly openingInput: AgentProviderSessionContext;
  readonly resume?: Readonly<{ binding: AgentSessionBinding; method: 'session/resume' | 'session/load' }>;
  readonly mcpServers?: readonly import('@agen-ai/acp-transport').AcpStandardMcpServer[];
  readonly connection: AcpInitializedConnection;
  readonly capabilities: AgentCapabilities;
  readonly limits: AcpProviderLimits;
  readonly permissionMapping: AcpPermissionMappingSelection;
  readonly now: () => string;
  readonly onClosed: () => void;
  readonly closeResources: () => Promise<void>;
}

export interface AcpOpenedProviderSession {
  readonly session: AgentProviderSession;
  readonly cleanup: () => Promise<void>;
}

export async function createAcpProviderSession(input: CreateAcpProviderSessionInput): Promise<AcpOpenedProviderSession> {
  let state: SessionState | undefined;
  try {
    state = new SessionState(input);
    const session = await state.open();
    const owner = state;
    return Object.freeze({ session, cleanup: () => owner.close() });
  } catch (error) {
    const cleanup = () => state ? state.close() : input.closeResources();
    try { await cleanup(); }
    catch (cleanupError) {
      throw createAgentProviderSessionCleanupError({ providerKey: input.capabilities.providerKey,
        openingInput: input.openingInput, errors: [error, cleanupError], retryCleanup: cleanup });
    }
    throw error;
  }
}
