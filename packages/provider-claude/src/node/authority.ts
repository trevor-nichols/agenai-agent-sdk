// ------------------------------------------------------------------------------------------------
//                authority.ts - Worker observations that end a turn's authority when they arrive
// ------------------------------------------------------------------------------------------------

import type { AgentError } from '@agen-ai/agent-protocol';
import { CLAUDE_CODE_VERSION } from '../index.js';
import { display } from './events.js';
import type { WorkerEvent } from './process.js';

/** The worker always runs Claude in this mode; host and accept-edits approval live in the owned tools. */
const PERMISSION_MODE = 'default';

/** What the session was opened with; Claude must keep reporting exactly this. */
export interface BoundConfiguration {
  readonly model: string;
  readonly ownedTools: ReadonlySet<string>;
}

export interface Revocation {
  readonly error: AgentError;
  /** Why the session is no longer usable. */
  readonly reason: string;
}

const failure = (category: AgentError['category'], code: string, message: string, reason: string): Revocation =>
  ({ error: { category, code, message, recovery: { kind: 'unknown' } }, reason });
const drift = (message: string) => failure('protocol', 'claude_configuration_drift', message, 'configuration_drift');

/**
 * The revocation an observation inside a turn carries, if any. Claude's model, permission mode, version
 * and tools must equal the bound configuration exactly; an alias or remapping Claude resolves to another
 * model is a mismatch. Any worker failure or lifecycle report ends the worker's authority.
 */
export function revocationFor(bound: BoundConfiguration, event: WorkerEvent): Revocation | undefined {
  switch (event.type) {
    case 'init': {
      const residual = event.tools.filter((tool) => !bound.ownedTools.has(tool));
      if (residual.length) {
        return failure('protocol', 'claude_residual_tools', `Claude offered tools outside the owned set: ${display(residual.join(', '), 400)}`, 'residual_tools');
      }
      if (event.model === bound.model && event.permissionMode === PERMISSION_MODE && event.claudeCodeVersion === CLAUDE_CODE_VERSION) return undefined;
      return drift(`Claude reported model ${display(event.model, 256)} with ${display(event.permissionMode, 64)} permissions on Claude Code ${display(event.claudeCodeVersion, 64)}.`);
    }
    case 'status':
      return event.permissionMode === PERMISSION_MODE ? undefined : drift(`Claude changed to ${display(event.permissionMode, 64)} permissions.`);
    case 'model_fallback':
      return event.model === bound.model ? undefined : drift(`Claude fell back to model ${display(event.model, 256)}.`);
    case 'ready': case 'failed': case 'closed': case 'transport_failed':
      return failure('transport', 'claude_worker_failed', event.type === 'failed' ? `Claude failed: ${event.message}` : 'The Claude worker stopped.', 'worker_failed');
    default:
      return undefined;
  }
}
