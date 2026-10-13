import { join } from 'node:path';
import { plainInput } from '../../selection/input.js';
import { prepareBinary } from './binary/prepare.js';
import type { AcpInstallationStore, AcpInstalledProcessLaunch, OpenAcpInstallationStoreInput } from './contracts.js';
import { AcpInstallationError } from './errors.js';
import { captureInstallInput } from './input.js';
import { resolveAcpInstallationLimits } from './limits.js';
import { prepareNpm } from './packages/npm.js';
import { prepareUv } from './packages/uv.js';
import { openOwnedAcpInstallationStore } from './store/index.js';
import { hashAcpToolchain, inspectPlannedAcpToolchains } from './tools/inspect.js';
import { runAcpInstallTool } from './tools/run.js';

function assertCurrentTarget(target: string): void {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : process.arch;
  if (target !== `${os}-${arch}`) throw new AcpInstallationError('unsupported_platform', 'Installation and launch require the exact current operating system and architecture.');
}

/** Opening an explicitly owned store performs filesystem operations; metadata imports never open it. */
export async function openAcpInstallationStore(input: OpenAcpInstallationStoreInput): Promise<AcpInstallationStore> {
  const options = plainInput(input) as unknown as OpenAcpInstallationStoreInput;
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => key !== 'root' && key !== 'limits')
    || typeof options.root !== 'string') throw new AcpInstallationError('invalid_input', 'Supply an explicit store root and optional finite limits.');
  const limits = resolveAcpInstallationLimits(options.limits);
  const store = await openOwnedAcpInstallationStore({ root: options.root, limits });
  return Object.freeze({
    async install(input) {
      const options = captureInstallInput(input, limits);
      assertCurrentTarget(options.plan.target);
      if (options.signal?.aborted) throw new AcpInstallationError('aborted', 'Installation was canceled before admission.');
      try { return await store.publish({ plan: options.plan, signal: options.signal, prepare: async ({ payloadRoot, workRoot, signal }) => {
        const toolchains = options.toolchains.length ? await inspectPlannedAcpToolchains({ toolchains: options.toolchains, workRoot, limits, signal }, options.plan.toolchains) : [];
        for (const expected of options.plan.toolchains) {
          const tool = toolchains.find((candidate) => candidate.kind === expected.kind);
          if (!tool || tool.sha256 !== expected.sha256 || tool.version !== expected.version) throw new AcpInstallationError('toolchain_mismatch', 'Installed toolchains must match the exact plan identities.');
        }
        const context = { plan: options.plan, payloadRoot, workRoot, limits, signal, toolchains,
          localArtifacts: options.localArtifacts, packageArtifacts: options.packageArtifacts, artifactBudget: { bytes: 0, count: 0 }, runTool: runAcpInstallTool };
        const prepared = options.plan.distribution.kind === 'binary' ? await prepareBinary(context)
          : options.plan.distribution.kind === 'npx' ? await prepareNpm(context) : await prepareUv(context);
        for (const tool of toolchains) if (await hashAcpToolchain(tool.path) !== tool.sha256) throw new AcpInstallationError('toolchain_mismatch', 'A toolchain entry changed while installing the payload.');
        return prepared;
      } }); } catch (cause) {
        if (!(cause instanceof AcpInstallationError) && options.signal?.aborted
          && (cause === options.signal.reason || cause instanceof Error && cause.name === 'AbortError')) {
          throw new AcpInstallationError('aborted', 'Installation was canceled.', { cause });
        }
        throw cause;
      }
    },
    async read(identity) { return (await store.read(identity)).receipt; },
    acquire: (input) => store.acquire(input),
    async resolveLaunch(reference): Promise<AcpInstalledProcessLaunch> {
      const { receipt, payloadRoot } = await store.readReference(reference);
      assertCurrentTarget(receipt.plan.target);
      for (const tool of receipt.prepared.toolchains) {
        if (await hashAcpToolchain(tool.path) !== tool.sha256) throw new AcpInstallationError('toolchain_mismatch', 'An installed toolchain entry changed; launch cannot resolve a replacement.');
      }
      const recipe = receipt.prepared.launch;
      const command = recipe.command;
      const executable = command.kind === 'payload' ? join(payloadRoot, command.path)
        : receipt.prepared.toolchains.find((tool) => tool.kind === command.toolchain)!.path;
      return Object.freeze({ executable, args: Object.freeze(recipe.args.map((arg) => arg.kind === 'literal' ? arg.value : join(payloadRoot, arg.path))),
        env: receipt.prepared.launch.env, shell: false, target: receipt.plan.target });
    },
    release: (reference) => store.release(reference),
    remove: (identity) => store.remove(identity),
    inspectAttempt: (planDigest) => store.inspectAttempt(planDigest),
    recoverAttempt: (input) => store.recoverAttempt(input),
  } satisfies AcpInstallationStore);
}
