// ------------------------------------------------------------------------------------------------
//                reconcile.ts - Exact original-resource matching - Cleanup-only recovery admission
// ------------------------------------------------------------------------------------------------

import { SandboxStateError, parseSandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { OperationOptions, SandboxReconciliation, SandboxRecoveryRecord } from '@agen-ai/sandbox';
import type { DockerSandboxConfig } from '../policy/config.js';
import { verifyDaemon } from '../policy/preflight.js';
import type { DockerApi } from '../resources/api.js';
import { inspectResource } from '../resources/inspect.js';
import { DockerResourceOwner } from '../resources/owner.js';
import { validateRecord } from './identity.js';

export async function reconcileDocker(api: DockerApi, config: DockerSandboxConfig, original: SandboxRecoveryRecord,
  options?: OperationOptions): Promise<SandboxReconciliation> {
  if (!validateRecord(original, config)) return Object.freeze({ kind: 'conflict', reason: 'Recovery record does not match this Docker backend profile, namespace, image or reserved identity.' });
  const backendIdentity = await verifyDaemon(api, config, options?.signal);
  if (original.authority.kind === 'verified' && original.authority.backendIdentity !== backendIdentity) {
    return Object.freeze({ kind: 'conflict', reason: 'Recovery record belongs to another Docker daemon identity.' });
  }
  let current = original;
  let present = false;
  let uncertain = false;
  for (const resource of original.resources) {
    const reference = resource.identity.kind === 'identified' ? resource.identity.id : resource.name;
    try {
      const inspection = await inspectResource(api, current, resource, reference, options?.signal);
      if (!inspection) {
        if (resource.identity.kind === 'creating') uncertain = true;
        continue;
      }
      if (resource.identity.kind === 'planned') {
        return Object.freeze({ kind: 'conflict', reason: 'A planned resource name is already present; recover from the latest durable record after the previous controller is quiescent.' });
      }
      present = true;
      if (resource.identity.kind === 'creating') current = parseSandboxRecoveryRecord({ ...current,
        resources: current.resources.map((candidate) => candidate.role === resource.role ? { ...candidate,
          identity: { kind: 'identified', id: inspection.id, fingerprint: inspection.fingerprint } } : candidate) });
    } catch (error) {
      if (!(error instanceof SandboxStateError)) throw error;
      return Object.freeze({ kind: 'conflict', reason: 'Docker resource identity, configuration or original recovery binding does not match.' });
    }
  }
  if (!present && !uncertain) return Object.freeze({ kind: 'absent', record: current });
  return Object.freeze({ kind: uncertain ? 'uncertain' : 'matched', owner: new DockerResourceOwner(api, config, undefined, current) });
}
