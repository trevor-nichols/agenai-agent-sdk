import type { AgentHistory } from '../../contracts/index.js';
import { createAgentHistory } from '../../lifecycle/create.js';
import { AgentHistoryCleanupError } from '../../lifecycle/errors.js';
import { parseAgentHistorySource } from '../../validation/parse.js';
import type { CreateCodexHistoryOptions, CreateCodexHistoryProcessOptions } from './contracts.js';
import { codexDriver } from './driver.js';
import { assertCodexExecutable, codexDirectory, codexExecutablePath } from './identity.js';
import { parseBorrowedCodexOptions, parseCodexProcessOptions, type ResolvedCodexHistoryOptions } from './options.js';
import { CodexProcessOwner } from './process.js';

function source(options: ResolvedCodexHistoryOptions, resourceOwnership: 'owned' | 'borrowed') {
  return parseAgentHistorySource({ providerKey: 'codex', sourceId: options.sourceId, generation: options.generation,
    kind: 'codex-app-server-local', scope: options.scope, resourceOwnership,
    storageEffects: { kind: 'possible', effects: ['initializes_store', 'migrates_store', 'updates_auxiliary_files',
      ...(options.catalogPolicy === 'scan_and_repair' ? ['updates_index'] : [])] },
  });
}

export function createCodexHistory(input: CreateCodexHistoryOptions): AgentHistory {
  const { options, connection } = parseBorrowedCodexOptions(input);
  const descriptor = source(options, 'borrowed');
  return createAgentHistory({ source: descriptor, limits: options.limits, management: options.management,
    driver: codexDriver(descriptor, { ...options, pageBytes: options.limits.pageBytes },
      { run: (operation) => operation(connection) }),
  });
}

export async function createCodexHistoryProcess(input: CreateCodexHistoryProcessOptions): Promise<AgentHistory> {
  const parsed = parseCodexProcessOptions(input);
  const configHome = await codexDirectory(parsed.configHome);
  const temporaryRoot = await codexDirectory(parsed.resources.temporaryRoot);
  const executable = await codexExecutablePath(parsed.executable);
  const resourceLauncher = await codexExecutablePath(parsed.resources.resourceLauncher);
  const sandboxLauncher = await codexExecutablePath(parsed.resources.sandboxLauncher);
  const scope = parsed.scope.kind === 'project'
    ? { ...parsed.scope, projectPath: await codexDirectory(parsed.scope.projectPath) } : parsed.scope;
  await assertCodexExecutable(executable);
  const options = { ...parsed, configHome, executable, scope,
    resources: { ...parsed.resources, temporaryRoot, resourceLauncher, sandboxLauncher } };
  const descriptor = source(options, 'owned');
  const owner = await CodexProcessOwner.create(options);
  try {
    return createAgentHistory({ source: descriptor, limits: options.limits, management: options.management,
      driver: codexDriver(descriptor, { ...options, pageBytes: options.limits.pageBytes }, owner, () => owner.dispose()),
    });
  } catch (error) {
    try { await owner.dispose(); }
    catch { throw new AgentHistoryCleanupError(() => owner.dispose()); }
    throw error;
  }
}
