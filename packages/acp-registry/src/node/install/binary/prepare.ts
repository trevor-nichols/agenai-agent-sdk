import { constants } from 'node:fs';
import { chmod, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcpInstalledArtifact, AcpPreparedInstallation } from '../contracts.js';
import { AcpInstallationError } from '../errors.js';
import type { AcpInstallPreparationContext } from '../internal.js';
import { acquireArtifact } from '../artifacts/acquire.js';
import { extractArchive } from './archive.js';
import { ArchiveSink } from './sink.js';

export async function prepareBinary(context: AcpInstallPreparationContext): Promise<AcpPreparedInstallation> {
  const { plan } = context;
  if (plan.distribution.kind !== 'binary' || !plan.binaryFormat) throw new AcpInstallationError('invalid_input', 'Binary preparation requires a plan-bound binary distribution and archive format.');
  if (plan.policy.integrity === 'require-expected-sha256' && plan.expectedIntegrity.sha256 === undefined) {
    throw new AcpInstallationError('policy_denied', 'The binary plan requires an expected artifact SHA-256 digest.');
  }
  const artifact = await acquireArtifact({ url: plan.distribution.archive, expectedSha256: plan.expectedIntegrity.sha256, context });
  if (plan.binaryFormat === 'raw') {
    const sink = new ArchiveSink({ payloadRoot: context.payloadRoot, limits: context.limits, signal: context.signal });
    await sink.initialize();
    const handle = await open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const source = handle.createReadStream({ autoClose: false, signal: context.signal });
    try {
      await sink.entry({ path: plan.launch.executable, kind: 'file', size: artifact.sizeBytes, mode: 0o700 }, source);
      await sink.finish();
    } finally { source.destroy(); await handle.close(); }
  } else {
    await extractArchive({ artifactPath: artifact.path, format: plan.binaryFormat, payloadRoot: context.payloadRoot,
      limits: context.limits, signal: context.signal, caseInsensitive: plan.target.startsWith('windows-') || plan.target.startsWith('darwin-') });
  }
  context.signal?.throwIfAborted();
  const executable = join(context.payloadRoot, plan.launch.executable);
  let executableStat;
  try { executableStat = await stat(executable); }
  catch (error) { throw new AcpInstallationError('unsafe_archive', 'The exact planned executable is absent from the extracted payload.', { cause: error }); }
  if (!executableStat.isFile()) throw new AcpInstallationError('unsafe_archive', 'The exact planned executable is not a regular payload file.');
  await chmod(executable, executableStat.mode & 0o777 | 0o100);
  const { path: _path, ...evidence } = artifact;
  const artifacts: readonly AcpInstalledArtifact[] = [evidence];
  return {
    launch: { command: { kind: 'payload', path: plan.launch.executable }, args: plan.launch.args.map((value) => ({ kind: 'literal', value })), env: plan.launch.env, shell: false },
    artifacts, toolchains: [], packages: [],
    verification: { expectedArtifactIntegrity: plan.expectedIntegrity.sha256 ? 'verified' : 'not-provided',
      dependencyClosure: 'not-applicable', packageCommand: 'not-applicable', toolchains: 'not-applicable',
      reproducibility: plan.expectedIntegrity.sha256 ? 'pinned-binary' : 'incomplete',
      gaps: plan.expectedIntegrity.sha256 ? [] : ['expected-sha256-missing'] },
  };
}
