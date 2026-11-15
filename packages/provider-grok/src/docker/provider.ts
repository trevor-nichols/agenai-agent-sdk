import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { parseSandboxPolicy, parseSandboxRecoveryPolicy, SandboxRunError, type SandboxPolicyInput } from '@agen-ai/sandbox';
import type { GrokDockerBackendOptions, GrokDockerProvider, GrokDockerProviderOptions } from './contracts.js';
import { admitImage } from './admission.js';
import { captureCredential } from './credentials.js';
import { dataValue, descriptors, digest, fields, invalid, text } from './data.js';
import { ownProvider } from './owner.js';
import { captureProfile } from './prepare.js';
import { profile } from './profile.js';

/** Captures all inputs, inspects the actual image, then starts its owned workspace sandbox. */
export async function prepareGrokDockerProvider(options: GrokDockerProviderOptions): Promise<GrokDockerProvider> {
  const input = descriptors(options, ['profile', 'backend', 'workload', 'credential', 'recovery']);
  const selected = captureProfile(dataValue(input.profile));
  const backend = descriptors(dataValue(input.backend), ['profile', 'endpoint', 'imageDigest', 'namespace', 'user', 'spillDirectory', 'egress']);
  const selectedProfile = profile(dataValue(backend.profile));
  const imageDigest = digest(dataValue(backend.imageDigest));
  const endpoint = dataValue(backend.endpoint);
  const namespace = dataValue(backend.namespace);
  const spillDirectory = dataValue(backend.spillDirectory);
  if (!text(endpoint) || !text(namespace) || !text(spillDirectory)) invalid();
  const backendOptions: GrokDockerBackendOptions = { profile: selectedProfile, imageDigest, endpoint, namespace, spillDirectory,
    user: dataValue(backend.user), egress: dataValue(backend.egress) };
  const workload = fields(dataValue(input.workload), ['resources', 'temporaryStorage', 'deadlines', 'transfers', 'streams'], ['execution']);
  const policy: SandboxPolicyInput = parseSandboxPolicy({ ...workload,
    network: { kind: 'restricted_https', destinations: [{ hostname: 'cli-chat-proxy.grok.com', port: 443 }] },
    files: { kind: 'disabled' }, workspaceDiskQuota: { kind: 'not_requested' },
  });
  const recovery = parseSandboxRecoveryPolicy(dataValue(input.recovery));
  // The neutral backend captures and validates its actual authority here, without acquiring resources.
  const actualBackend = createDockerSandboxBackend(backendOptions);
  const credential = captureCredential(dataValue(input.credential));
  try {
    await admitImage(selected, { profile: selectedProfile, endpoint, imageDigest });
    const reservation = actualBackend.reserve({ policy }, recovery);
    try {
      const sandbox = await reservation.start();
      return ownProvider(selected, sandbox, credential);
    } catch (error) {
      try { await reservation.destroy(); }
      catch (cleanupError) { throw new SandboxRunError({ primaryError: error, cleanupError, owner: reservation }); }
      throw error;
    }
  } catch (error) {
    credential.fill(0);
    throw error;
  }
}
