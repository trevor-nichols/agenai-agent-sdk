// ------------------------------------------------------------------------------------------------
//                index.ts - Optional one-connection ACP execution composition
// ------------------------------------------------------------------------------------------------

import type { AcpHostFacilities } from '@agen-ai/provider-acp';
import type { NodeAcpExecutionBoundary, NodeAcpExecutionReservation } from '@agen-ai/provider-acp/node';
import type { Sandbox } from '../contracts.js';
import { SandboxStateError } from '../errors.js';

/** One native connection, with host facilities disabled and workspace retention after release. */
export function createSandboxAcpIntegration(sandbox: Sandbox): Readonly<{
  executionBoundary: NodeAcpExecutionBoundary;
  host: AcpHostFacilities;
}> {
  let reserved = false;
  const executionBoundary = Object.freeze<NodeAcpExecutionBoundary>({
    reserve(input) {
      if (reserved) throw new SandboxStateError('Sandbox ACP integration admits one native connection.');
      reserved = true;
      const process = sandbox.reserveProcess({ executable: input.executable, args: input.args, env: input.env, cwd: input.cwd });
      return Object.freeze<NodeAcpExecutionReservation>({
        async start(context) {
          const { stdin, stdout, stderr } = await process.start({ signal: context.signal });
          return Object.freeze({ stdin, stdout, stderr });
        },
        async release() { await sandbox.stop(); },
      });
    },
  });
  const host: AcpHostFacilities = Object.freeze({});
  return Object.freeze({ executionBoundary, host });
}
