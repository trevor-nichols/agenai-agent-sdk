import type { AgentApprovalConsequence, AgentApprovalCapability } from '@agen-ai/agent-protocol';
import type { AgentApprovalConsequence as RequestConsequence } from '@agen-ai/agent-protocol/requests';
import type { AgentApprovalCapability as ApprovalCapability } from '@agen-ai/agent-protocol/capabilities';

// Installed declarations must expose the new neutral types through both ordinary entrypoints.
const remembrance: AgentApprovalConsequence = { kind: 'provider_managed_remembrance',
  duration: { kind: 'unknown' }, applicability: { kind: 'unknown' }, explanation: 'The provider owns future matching.' };
const requestConsequence: RequestConsequence = remembrance;
const rememberedOnly: AgentApprovalCapability = { kind: 'supported', providerManagedRemembrance: true, modes: [] };
const preciseOnly: ApprovalCapability = { kind: 'supported', providerManagedRemembrance: false,
  modes: [{ persistence: 'once', scopeKinds: ['exact_action'] }] };
// @ts-expect-error Supported precise-only capabilities require a nonempty tuple in installed declarations.
const emptyPreciseOnly: AgentApprovalCapability = { kind: 'supported', providerManagedRemembrance: false, modes: [] };
// @ts-expect-error The remembered branch requires an explicit unknown duration, not a guessed lifetime.
const guessedDuration: RequestConsequence = { kind: 'provider_managed_remembrance', duration: { kind: 'session' }, applicability: { kind: 'unknown' }, explanation: 'Unsupported guess.' };
void [requestConsequence, rememberedOnly, preciseOnly, emptyPreciseOnly, guessedDuration];
