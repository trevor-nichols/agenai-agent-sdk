import { AgentHistoryError } from '../../../lifecycle/errors.js';
import type { CursorHistorySdk } from '../native.js';
import type { CursorWorkerRequest } from './protocol.js';

function member(value: unknown, name: string): unknown {
  if ((value === null || typeof value !== 'object') && typeof value !== 'function') {
    throw new AgentHistoryError('native_failure', 'Cursor SDK history interface is unavailable.');
  }
  return Reflect.get(value, name);
}

function call(value: unknown, name: string): (args: readonly unknown[]) => unknown {
  const method = member(value, name);
  if (typeof method !== 'function') throw new AgentHistoryError('native_failure', 'Cursor SDK history interface is unavailable.');
  return (args) => Reflect.apply(method, value, args);
}

export async function connectCursorSdk(native: unknown, sqlite: unknown, request: CursorWorkerRequest): Promise<CursorHistorySdk> {
  if (request.source.scope.kind !== 'project') throw new AgentHistoryError('unsupported_scope', 'Cursor local history requires one explicit project.');
  const agent = member(native, 'Agent');
  const list = call(agent, 'list'), get = call(agent, 'get'), listRuns = call(agent, 'listRuns'), getRun = call(agent, 'getRun');
  const messages = call(member(agent, 'messages'), 'list');
  const archive = call(agent, 'archive'), restore = call(agent, 'unarchive'), remove = call(agent, 'delete');
  let store: unknown;
  if (request.store.kind === 'jsonl') {
    const constructor = member(native, 'JsonlLocalAgentStore');
    if (typeof constructor !== 'function') throw new AgentHistoryError('native_failure', 'Cursor JSONL store interface is unavailable.');
    store = Reflect.construct(constructor, [request.store.path]);
  } else {
    store = await call(member(sqlite, 'SqliteLocalAgentStore'), 'open')([
      { stateRoot: request.store.path, workspaceRef: request.source.scope.projectPath },
    ]);
  }
  const dispose = request.store.kind === 'sqlite' ? call(store, 'dispose') : () => undefined;
  try {
    const agentDocument = call(member(store, 'agents'), 'get'), runDocument = call(member(store, 'runs'), 'get');
    const options = { runtime: 'local', store, cwd: request.source.scope.projectPath, apiKey: '' };
    return {
      archiveAgent: async (id) => archive([id, options]),
      restoreAgent: async (id) => restore([id, options]),
      deleteAgent: async (id) => remove([id, options]),
      listAgents: async (input) => list([{ ...options, ...input }]),
      getAgent: async (id) => get([id, options]),
      listRuns: async (id, input) => listRuns([id, { ...options, ...input }]),
      getRun: async (id) => {
        const result = await getRun([id, options]);
        const conversation = call(result, 'conversation');
        return { runInfo: result, conversation: async () => conversation([]) };
      },
      messages: async (id, input) => messages([id, { ...options, ...input }]),
      agentDocument: async (agentId) => agentDocument([{ agentId }]),
      runDocument: async (agentId, runId) => runDocument([{ agentId, runId }]),
      dispose: async () => { await dispose([]); },
    };
  } catch (error) {
    await dispose([]);
    throw error;
  }
}
