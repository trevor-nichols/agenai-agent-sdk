import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import type { AgentHistory } from '../../contracts/index.js';
import { createAgentHistory } from '../../lifecycle/create.js';
import { AgentHistoryCleanupError, AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistorySource } from '../../validation/parse.js';
import { claudeDriver } from './driver.js';
import { inspectClaudeSdk } from './identity.js';
import { parseClaudeHistoryOptions, type CreateClaudeHistoryOptions } from './options.js';
import { ClaudeWorkerOwner } from './process.js';

async function directory(path: string): Promise<string> {
  try {
    const physical = await realpath(path);
    if (!(await stat(physical)).isDirectory()) throw new Error('Directory required');
    return physical;
  } catch { throw new AgentHistoryError('invalid_input', 'Claude history requires existing explicit configuration, project and temporary directories.'); }
}

export async function createClaudeHistory(input: CreateClaudeHistoryOptions): Promise<AgentHistory> {
  const parsed = parseClaudeHistoryOptions(input);
  const configHome = await directory(parsed.configHome);
  const temporaryRoot = await directory(parsed.resources.temporaryRoot);
  const scope = parsed.scope.kind === 'project'
    ? { ...parsed.scope, projectPath: await directory(parsed.scope.projectPath) } : parsed.scope;
  let executable: string;
  try {
    executable = await realpath(parsed.resources.executable);
    await access(executable, constants.X_OK);
    if (!(await stat(executable)).isFile()) throw new Error('Executable required');
  } catch { throw new AgentHistoryError('invalid_input', 'Claude history requires an explicit executable resource launcher.'); }
  await inspectClaudeSdk();
  const options = { ...parsed, configHome, scope, resources: { ...parsed.resources, temporaryRoot, executable } };
  const source = parseAgentHistorySource({ providerKey: 'claude', sourceId: options.sourceId, generation: options.generation,
    kind: 'claude-native', scope, storageEffects: { kind: 'none' }, resourceOwnership: 'owned' });
  const owner = await ClaudeWorkerOwner.create(options.resources);
  try { return createAgentHistory({ source, driver: claudeDriver(source, options, owner), limits: options.limits, management: options.management }); }
  catch (error) {
    try { await owner.dispose(); }
    catch { throw new AgentHistoryCleanupError(() => owner.dispose()); }
    throw error;
  }
}
