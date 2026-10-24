import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import type { AgentHistory } from '../../contracts/index.js';
import { createAgentHistory } from '../../lifecycle/create.js';
import { AgentHistoryCleanupError, AgentHistoryError } from '../../lifecycle/errors.js';
import { parseAgentHistorySource } from '../../validation/parse.js';
import type { CreateCursorHistoryOptions } from './contracts.js';
import { cursorDriver } from './driver.js';
import { inspectCursorSdk } from './identity.js';
import { parseCursorHistoryOptions } from './options.js';
import { CursorWorkerOwner } from './process.js';

async function directory(path: string): Promise<string> {
  try {
    const physical = await realpath(path);
    if (!(await stat(physical)).isDirectory()) throw new Error('Directory required');
    await access(physical, constants.R_OK | constants.X_OK);
    return physical;
  } catch { throw new AgentHistoryError('invalid_input', 'Cursor local history requires existing explicit store, project and temporary directories.'); }
}

export async function createCursorHistory(input: CreateCursorHistoryOptions): Promise<AgentHistory> {
  const parsed = parseCursorHistoryOptions(input);
  const store = { ...parsed.store, path: await directory(parsed.store.path) };
  const scope = { ...parsed.scope, projectPath: await directory(parsed.scope.projectPath) };
  const temporaryRoot = await directory(parsed.resources.temporaryRoot);
  let executable: string;
  try {
    executable = await realpath(parsed.resources.executable);
    await access(executable, constants.X_OK);
    if (!(await stat(executable)).isFile()) throw new Error('Executable required');
  } catch { throw new AgentHistoryError('invalid_input', 'Cursor local history requires an explicit executable resource launcher.'); }
  await inspectCursorSdk();
  const options = { ...parsed, store, scope, resources: { ...parsed.resources, executable, temporaryRoot } };
  const source = parseAgentHistorySource({ providerKey: 'cursor', sourceId: options.sourceId, generation: options.generation,
    kind: 'cursor-local-sdk', scope, resourceOwnership: 'owned',
    storageEffects: store.kind === 'jsonl' ? { kind: 'none' }
      : { kind: 'possible', effects: ['initializes_store', 'migrates_store', 'updates_auxiliary_files'] } });
  const owner = await CursorWorkerOwner.create(options.resources);
  try { return createAgentHistory({ source, driver: cursorDriver(source, options, owner), limits: options.limits, management: options.management }); }
  catch (error) {
    try { await owner.dispose(); }
    catch { throw new AgentHistoryCleanupError(() => owner.dispose()); }
    throw error;
  }
}
