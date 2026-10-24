import { join } from 'node:path';
import type { AgentHistory } from '../../contracts/index.js';
import { createAgentHistory } from '../../lifecycle/create.js';
import { AgentHistoryCleanupError, AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistorySource } from '../../validation/parse.js';
import type { CreateGrokHistoryOptions, CreateGrokHistoryProcessOptions } from './contracts.js';
import { grokDriver } from './driver.js';
import { assertGrokExecutable, assertGrokSandbox, captureGrokStore, grokDirectory, grokExecutablePath } from './identity.js';
import { parseBorrowedGrokOptions, parseGrokProcessOptions, type ResolvedGrokProcessOptions } from './options.js';
import { GrokProcessOwner } from './process.js';

function source(options: Pick<ResolvedGrokProcessOptions, 'sourceId' | 'generation' | 'scope'>, resourceOwnership: 'owned' | 'borrowed') {
  return parseAgentHistorySource({ providerKey: 'grok-build', sourceId: options.sourceId, generation: options.generation,
    kind: 'grok-build-local', scope: options.scope, resourceOwnership,
    storageEffects: resourceOwnership === 'owned' ? { kind: 'none' }
      : { kind: 'unknown', reason: 'The borrowed Grok process owns native initialization, configuration and auxiliary storage effects.' },
  });
}

export function createGrokHistory(input: CreateGrokHistoryOptions): AgentHistory {
  const { options, connection } = parseBorrowedGrokOptions(input), descriptor = source(options, 'borrowed');
  return createAgentHistory({ source: descriptor, limits: options.limits,
    management: options.management, driver: grokDriver(descriptor, { run: (operation) => operation(connection) }, options.limits.pageBytes,
      options.limits.maximumDeadlineMs, { contentSearch: connection.sessionSearch !== undefined }) });
}

export async function createGrokHistoryProcess(input: CreateGrokHistoryProcessOptions): Promise<AgentHistory> {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new AgentHistoryError('unsupported_scope', 'Owned Grok history requires the qualified Linux x86_64 resource policy.');
  const parsed = parseGrokProcessOptions(input);
  const nativeHome = await grokDirectory(parsed.nativeHome), temporaryRoot = await grokDirectory(parsed.resources.temporaryRoot);
  const executable = await grokExecutablePath(parsed.executable), resourceLauncher = await grokExecutablePath(parsed.resources.resourceLauncher),
    sandboxLauncher = await grokExecutablePath(parsed.resources.sandboxLauncher);
  const projectPath = await grokDirectory(parsed.scope.projectPath);
  if ([nativeHome, projectPath].some((root) => temporaryRoot === root || temporaryRoot.startsWith(`${root === '/' ? '' : root}/`))) {
    throw new AgentHistoryError('invalid_input', 'Grok scratch storage must be outside the selected native home and project.');
  }
  await assertGrokExecutable(executable);
  await assertGrokSandbox(sandboxLauncher, parsed.management.some((operation) => operation === 'rename' || operation === 'delete'));
  const store = await captureGrokStore(join(nativeHome, 'sessions'));
  const options = { ...parsed, nativeHome, executable, scope: { ...parsed.scope, projectPath },
    resources: { ...parsed.resources, temporaryRoot, resourceLauncher, sandboxLauncher } };
  const descriptor = source(options, 'owned'), owner = await GrokProcessOwner.create(options, store);
  try {
    return createAgentHistory({ source: descriptor, limits: options.limits, management: options.management,
      driver: grokDriver(descriptor, owner, options.limits.pageBytes, options.limits.maximumDeadlineMs,
        { contentSearch: true, ...(options.localManagement === undefined ? {} : { management: owner }) }, () => owner.dispose()) });
  } catch (error) {
    try { await owner.dispose(); }
    catch { throw new AgentHistoryCleanupError(() => owner.dispose()); }
    throw error;
  }
}
