import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AcpInspectedToolchain, AcpInstalledPackage, AcpPreparedInstallation } from '../contracts.js';
import type { AcpInstallPreparationContext } from '../internal.js';
import { AcpInstallationError } from '../errors.js';
import type { AcpLockedPackage } from '../../../planning/contracts.js';

export async function packageEnvironment(context: AcpInstallPreparationContext): Promise<Readonly<Record<string, string>>> {
  const home = join(context.workRoot, 'home');
  const temporary = join(context.workRoot, 'temporary');
  await mkdir(home, { mode: 0o700 });
  await mkdir(temporary, { mode: 0o700 });
  return { HOME: home, USERPROFILE: home, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', NO_COLOR: '1', PYTHONDONTWRITEBYTECODE: '1' };
}

export function packageTool(context: AcpInstallPreparationContext, kind: AcpInspectedToolchain['kind']): AcpInspectedToolchain {
  const tool = context.toolchains.find((item) => item.kind === kind);
  const expected = context.plan.toolchains.find((item) => item.kind === kind);
  if (!tool || !expected || tool.version !== expected.version || tool.sha256 !== expected.sha256) {
    throw new AcpInstallationError('toolchain_mismatch', 'Package installation requires the exact inspected toolchain identities in its plan.');
  }
  return tool;
}

export function packagePolicy(context: AcpInstallPreparationContext, kind: 'npx' | 'uvx'): void {
  if (context.plan.distribution.kind !== kind || context.plan.packageResolution?.kind !== kind) throw new AcpInstallationError('invalid_input', 'The package adapter does not match this installation plan.');
  if (context.plan.policy.packageScripts !== 'deny') throw new AcpInstallationError('policy_denied', 'This installation profile cannot run package lifecycle scripts or Python source builds.');
  context.signal?.throwIfAborted();
}

export async function runPackageTool(context: AcpInstallPreparationContext, executable: string, args: readonly string[], env: Readonly<Record<string, string>>, cwd = context.payloadRoot): Promise<string> {
  const result = await context.runTool({ executable, args, env, cwd, signal: context.signal,
    timeoutMs: context.limits.toolTimeoutMs, maxOutputBytes: context.limits.maxToolOutputBytes });
  if (result.exitCode !== 0) throw new AcpInstallationError('tool_failed', 'The isolated offline package tool rejected this installation.');
  return result.stdout;
}

export function verifyPackageClosure(packages: readonly AcpInstalledPackage[], expected: readonly AcpLockedPackage[] | undefined, root: { readonly name: string; readonly version: string }): void {
  const byId = new Map(packages.map((item) => [`${item.name}@${item.version}`, item]));
  if (byId.size !== packages.length) throw new AcpInstallationError('integrity_mismatch', 'Duplicate installed package identities cannot establish one dependency closure.');
  const pending = [`${root.name}@${root.version}`];
  const visited = new Set<string>();
  while (pending.length) {
    const identity = pending.pop()!;
    if (visited.has(identity)) continue;
    const item = byId.get(identity);
    if (!item) throw new AcpInstallationError('integrity_mismatch', 'The installed dependency closure contains an unresolved package.');
    visited.add(identity);
    pending.push(...item.dependencies);
  }
  if (visited.size !== byId.size) throw new AcpInstallationError('integrity_mismatch', 'Unexpected packages are outside the installed root dependency closure.');
  if (expected) {
    if (expected.length !== packages.length) throw new AcpInstallationError('integrity_mismatch', 'The installed dependency count differs from the declared lock.');
    for (const item of expected) {
      const installed = byId.get(`${item.name}@${item.version}`);
      if (!installed || JSON.stringify([...installed.dependencies].sort()) !== JSON.stringify([...item.dependencies].sort())) {
        throw new AcpInstallationError('integrity_mismatch', 'Actual package metadata contradicts the declared dependency lock.');
      }
    }
  }
}

export function packageVerification(context: AcpInstallPreparationContext): AcpPreparedInstallation['verification'] {
  return { expectedArtifactIntegrity: 'verified', dependencyClosure: 'verified', packageCommand: 'verified', toolchains: 'verified',
    reproducibility: context.plan.reproducibility.classification, gaps: context.plan.reproducibility.gaps };
}

export async function npmConfiguration(context: AcpInstallPreparationContext): Promise<readonly string[]> {
  const userConfig = join(context.workRoot, 'empty-user-npmrc');
  const globalConfig = join(context.workRoot, 'empty-global-npmrc');
  await writeFile(userConfig, '', { flag: 'wx', mode: 0o600 });
  await writeFile(globalConfig, '', { flag: 'wx', mode: 0o600 });
  return ['--offline', '--ignore-scripts', '--bin-links=false', '--audit=false', '--fund=false', '--update-notifier=false',
    '--userconfig', userConfig, '--globalconfig', globalConfig, '--cache', join(context.workRoot, 'npm-cache'), '--registry', 'https://registry.invalid'];
}
