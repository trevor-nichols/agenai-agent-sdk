import type { AcpJsonObject } from '@agen-ai/acp-transport';
import type { AgentPlanStep } from '@agen-ai/agent-protocol';

import { AcpProviderSessionError } from './errors.js';
import { nativeObject, nativeString } from './native.js';

/** Every native plan is a replacement snapshot; ACP v1 supplies no persistent entry identity. */
export function acpPlanSteps(update: AcpJsonObject, revision: number): readonly AgentPlanStep[] {
  if (!Array.isArray(update.entries)) throw new AcpProviderSessionError('acp_plan_invalid', 'ACP plan entries must be an array.');
  return update.entries.map((value, index) => {
    const entry = nativeObject(value, 'plan entry');
    const status = nativeString(entry.status, 'plan entry status');
    const priority = nativeString(entry.priority, 'plan entry priority');
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
      throw new AcpProviderSessionError('acp_plan_invalid', 'ACP plan entry status is unsupported.');
    }
    if (priority !== 'low' && priority !== 'medium' && priority !== 'high') {
      throw new AcpProviderSessionError('acp_plan_invalid', 'ACP plan entry priority is unsupported.');
    }
    return { stepId: `acp:plan:${revision}:${index + 1}`, text: nativeString(entry.content, 'plan entry text'), status, priority };
  });
}
