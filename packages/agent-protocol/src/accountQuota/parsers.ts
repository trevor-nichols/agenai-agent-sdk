// ------------------------------------------------------------------------------------------------
//                parsers.ts - Validator-neutral account allowance parsers
// ------------------------------------------------------------------------------------------------

import type { AgentProtocolParseResult } from '../foundation/types.js';
import { parseWithSchema, safeParseWithSchema } from '../internal/parsers.js';
import { AgentAccountQuotaSnapshotSchema, AgentAccountQuotaWindowSchema } from '../zod/accountQuota.js';
import type { AgentAccountQuotaSnapshot, AgentAccountQuotaWindow } from './types.js';

export function parseAgentAccountQuotaSnapshot(input: unknown): AgentAccountQuotaSnapshot {
  return parseWithSchema(AgentAccountQuotaSnapshotSchema, input);
}

export function safeParseAgentAccountQuotaSnapshot(input: unknown): AgentProtocolParseResult<AgentAccountQuotaSnapshot> {
  return safeParseWithSchema(AgentAccountQuotaSnapshotSchema, input);
}

export function parseAgentAccountQuotaWindow(input: unknown): AgentAccountQuotaWindow {
  return parseWithSchema(AgentAccountQuotaWindowSchema, input);
}

export function safeParseAgentAccountQuotaWindow(input: unknown): AgentProtocolParseResult<AgentAccountQuotaWindow> {
  return safeParseWithSchema(AgentAccountQuotaWindowSchema, input);
}
