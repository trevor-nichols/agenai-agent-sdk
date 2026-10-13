import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { plainInput } from '../../../selection/input.js';
import type { AcpToolchainIdentity } from '../../../planning/contracts.js';
import type { AcpInspectedToolchain, AcpInstallationLimits, AcpToolchainLocation } from '../contracts.js';
import { AcpInstallationError } from '../errors.js';
import { resolveAcpInstallationLimits } from '../limits.js';
import { runAcpInstallTool } from './run.js';

export interface InspectAcpToolchainsInput {
  readonly toolchains: readonly AcpToolchainLocation[];
  readonly workRoot: string;
  readonly limits?: Partial<AcpInstallationLimits>;
  readonly signal?: AbortSignal;
}

export async function hashAcpToolchain(path: string): Promise<string> {
  try { return await hashToolchainEntry(path); }
  catch (cause) {
    if (cause instanceof AcpInstallationError) throw cause;
    throw new AcpInstallationError('toolchain_mismatch', 'The exact toolchain entry cannot be inspected.', { cause });
  }
}

async function hashToolchainEntry(path: string): Promise<string> {
  const candidate = await lstat(path);
  if (!candidate.isFile()) throw new AcpInstallationError('toolchain_mismatch', 'A toolchain entry must be a regular file.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await handle.stat();
    if (before.dev !== candidate.dev || before.ino !== candidate.ino || !before.isFile() || before.size < 1 || before.size > 256 * 1_024 * 1_024) throw new AcpInstallationError('toolchain_mismatch', 'Toolchain entry must be a bounded regular file.');
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1_024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > before.size) throw new AcpInstallationError('toolchain_mismatch', 'Toolchain entry changed during inspection.');
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const current = await lstat(path);
    if (total !== before.size || before.dev !== current.dev || before.ino !== current.ino || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || after.size !== before.size || !current.isFile()) {
      throw new AcpInstallationError('toolchain_mismatch', 'Toolchain entry changed during inspection.');
    }
    return `sha256:${digest.digest('hex')}`;
  } finally { await handle.close(); }
}

export function inspectAcpToolchains(input: InspectAcpToolchainsInput): Promise<readonly AcpInspectedToolchain[]> {
  return inspectToolchains(input);
}

export function inspectPlannedAcpToolchains(input: InspectAcpToolchainsInput, expected: readonly AcpToolchainIdentity[]): Promise<readonly AcpInspectedToolchain[]> {
  return inspectToolchains(input, expected);
}

async function inspectToolchains(input: InspectAcpToolchainsInput, expected?: readonly AcpToolchainIdentity[]): Promise<readonly AcpInspectedToolchain[]> {
  const tools = plainInput(input.toolchains) as unknown;
  if (!Array.isArray(tools) || tools.length > 4) throw new AcpInstallationError('invalid_input', 'Supply at most four explicit toolchain locations.');
  const locations: AcpToolchainLocation[] = [];
  for (const value of tools) {
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'kind,path'
      || !['node', 'npm', 'python', 'uv'].includes(value.kind) || typeof value.path !== 'string'
      || value.path.length > 8_192 || !isAbsolute(value.path) || /[\p{Cc}\p{Cf}]/u.test(value.path)
      || locations.some((tool) => tool.kind === value.kind)) throw new AcpInstallationError('invalid_input', 'Toolchain locations require unique kinds and explicit absolute paths.');
    try { locations.push({ kind: value.kind, path: await realpath(value.path) }); }
    catch (cause) { throw new AcpInstallationError('toolchain_mismatch', 'The explicitly selected toolchain location is unavailable.', { cause }); }
  }
  if (locations.some((tool) => tool.kind === 'npm') && !locations.some((tool) => tool.kind === 'node')) throw new AcpInstallationError('invalid_input', 'Inspect npm together with its explicit Node executable.');
  const measured = new Map<string, string>();
  for (const location of locations) {
    const sha256 = await hashAcpToolchain(location.path);
    const pinned = expected?.find((tool) => tool.kind === location.kind);
    if (expected && (!pinned || pinned.sha256 !== sha256)) throw new AcpInstallationError('toolchain_mismatch', 'A supplied toolchain entry differs from the plan and cannot be executed.');
    measured.set(location.kind, sha256);
  }
  const limits = resolveAcpInstallationLimits(input.limits);
  const signal = input.signal;
  if (signal?.aborted) throw new AcpInstallationError('aborted', 'Toolchain inspection was canceled.');
  const workRoot = input.workRoot;
  if (typeof workRoot !== 'string' || !isAbsolute(workRoot)) throw new AcpInstallationError('invalid_input', 'Toolchain inspection requires an absolute caller-owned scratch directory.');
  const scratch = await mkdtemp(join(workRoot, 'acp-toolchains-'));
  try {
    const home = join(scratch, 'home');
    await mkdir(home, { mode: 0o700 });
    const env = { HOME: home, USERPROFILE: home, TMPDIR: scratch, TMP: scratch, TEMP: scratch, LANG: 'C', LC_ALL: 'C', NO_COLOR: '1' };
    const result: AcpInspectedToolchain[] = [];
    for (const location of locations) {
      const sha256 = measured.get(location.kind)!;
      if (await hashAcpToolchain(location.path) !== sha256) throw new AcpInstallationError('toolchain_mismatch', 'A toolchain entry changed before its version probe.');
      const node = locations.find((tool) => tool.kind === 'node');
      const executable = location.kind === 'npm' ? node!.path : location.path;
      if (node && location.kind === 'npm' && await hashAcpToolchain(node.path) !== measured.get('node')) throw new AcpInstallationError('toolchain_mismatch', 'The npm interpreter changed before its version probe.');
      const args = location.kind === 'npm' ? [location.path, '--version']
        : location.kind === 'python' ? ['-I', '-S', '--version'] : location.kind === 'uv' ? ['--no-config', '--version'] : ['--version'];
      const probe = await runAcpInstallTool({ executable, args, cwd: scratch, env, signal, timeoutMs: limits.toolTimeoutMs, maxOutputBytes: limits.maxToolOutputBytes });
      const output = probe.stdout.trim();
      const match = location.kind === 'node' ? /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(output)
        : location.kind === 'python' ? /^Python (\d+\.\d+\.\d+(?:[abrc0-9]+)?)$/u.exec(output)
          : location.kind === 'uv' ? /^uv (\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?: \([^\r\n]+\))?$/u.exec(output)
            : /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.exec(output);
      if (probe.exitCode !== 0 || !match || await hashAcpToolchain(location.path) !== sha256) throw new AcpInstallationError('toolchain_mismatch', 'Toolchain version or executable identity could not be established.');
      const pinned = expected?.find((tool) => tool.kind === location.kind);
      if (pinned && pinned.version !== match[1]) throw new AcpInstallationError('toolchain_mismatch', 'The toolchain version differs from its plan.');
      result.push(Object.freeze({ ...location, version: match[1]!, sha256 }));
    }
    return Object.freeze(result);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
