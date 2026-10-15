import path from 'node:path';
import { AcpProviderConnectionError } from '../connection/errors.js';
import type { CreateNodeAcpProviderDriverOptions, NodeAcpLaunchOptions } from './contracts.js';
import type { AcpSessionInteractionSelection } from '../sessionInteractions/contracts.js';
import type { NodeAcpExecutionInput } from './execution/types.js';

export type ResolvedNodeAcpLaunch = NodeAcpExecutionInput;

function validArgument(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 65_536 && !value.includes('\0');
}

export function resolveNodeAcpLaunch(launch: NodeAcpLaunchOptions): ResolvedNodeAcpLaunch {
  if (process.platform === 'win32') throw new AcpProviderConnectionError(
    'acp_provider_process_platform_unsupported',
    'The built-in ACP launcher requires POSIX process groups. On Windows, use createAcpProviderDriver with an explicitly owned connection.',
  );
  if (!validArgument(launch.executable) || !path.isAbsolute(launch.executable)
    || !validArgument(launch.cwd) || !path.isAbsolute(launch.cwd)) {
    throw new TypeError('ACP executable and working directory must be explicit absolute paths.');
  }
  const args = launch.args ?? [];
  if (!Array.isArray(args) || args.length > 1_024 || !args.every(validArgument)) {
    throw new TypeError('ACP process arguments must be a bounded literal string array.');
  }
  const env = launch.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env) || Reflect.ownKeys(env).length > 1_024
    || Object.entries(env).some(([key, value]) => !key || /[=\0]/u.test(key) || !validArgument(value))) {
    throw new TypeError('ACP process environment must contain explicit bounded string variables.');
  }
  const shutdownTimeoutMs = launch.shutdownTimeoutMs ?? 2_000;
  if (!Number.isSafeInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 10 || shutdownTimeoutMs > 30_000) {
    throw new TypeError('ACP process shutdown timeout is outside its supported range.');
  }
  return Object.freeze({
    executable: launch.executable,
    args: Object.freeze([...args]),
    cwd: launch.cwd,
    env: Object.freeze({ ...env }),
    shutdownTimeoutMs,
  });
}

export function resolveNodeAcpSessionInteractions(
  options: CreateNodeAcpProviderDriverOptions,
  launch: ResolvedNodeAcpLaunch,
): AcpSessionInteractionSelection | undefined {
  const selection = options.sessionInteractions;
  if (selection === undefined && !Object.hasOwn(options, 'sessionInteractions')) return undefined;
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)
    || Reflect.ownKeys(selection).length !== 1 || !Object.hasOwn(selection, 'mapping')
    || selection.mapping !== 'grok-folder-trust-v1') {
    throw new TypeError('ACP session interaction selection must name the supported mapping without additional fields.');
  }
  if (launch.args.length !== 3 || launch.args[0] !== 'agent'
    || launch.args[1] !== '--no-leader' || launch.args[2] !== 'stdio') {
    throw new TypeError('The Grok folder-trust mapping requires exact direct arguments: agent --no-leader stdio.');
  }
  return Object.freeze({ mapping: 'grok-folder-trust-v1' });
}
