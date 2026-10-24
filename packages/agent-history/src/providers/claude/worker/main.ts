import { readFile } from 'node:fs/promises';
import { AgentHistoryError } from '../../../lifecycle/errors.js';
import { inspectClaudeSdk } from '../identity.js';
import { listClaudeSessions, lookupClaudeSession, type ClaudeHistorySdk } from '../session.js';
import { readClaudeTranscript } from '../transcript.js';
import { mutateClaudeSession } from '../mutations.js';
import { HistoryWorkerChannel } from '../../process/worker-channel.js';
import {
  parseClaudeWorkerRequest, parseClaudeWorkerResponse, type ClaudeWorkerResponse,
} from './protocol.js';

async function assertResourcePolicy(): Promise<void> {
  if (process.platform !== 'linux' || !process.execArgv.includes('--jitless')
    || !process.execArgv.includes('--max-old-space-size=128')) {
    throw new AgentHistoryError('unsupported_scope', 'Claude history requires the qualified Linux worker resource policy.');
  }
  const limits = await readFile('/proc/self/limits', 'utf8');
  const expected = [
    { name: 'address space', maximum: 4_294_967_296 }, { name: 'cpu time', maximum: 12 },
    { name: 'open files', maximum: 128 }, { name: 'core file size', maximum: 0 },
  ];
  for (const { name, maximum } of expected) {
    const match = new RegExp(`^Max ${name}\\s+(\\S+)\\s+(\\S+)`, 'mu').exec(limits);
    if (!match || ![match[1], match[2]].every((value) => value !== undefined && /^\d+$/u.test(value)
      && Number.isSafeInteger(Number(value)) && Number(value) <= maximum && (maximum === 0 || Number(value) > 0))) {
      throw new AgentHistoryError('unsupported_scope', 'Claude worker kernel resource limits are missing or exceed the qualified policy.');
    }
  }
}

async function loadSdk(): Promise<ClaudeHistorySdk> {
  const entry = await inspectClaudeSdk();
  const sdk: unknown = await import(entry);
  if (sdk === null || typeof sdk !== 'object'
    || !('listSessions' in sdk) || typeof sdk.listSessions !== 'function'
    || !('getSessionInfo' in sdk) || typeof sdk.getSessionInfo !== 'function'
    || !('getSessionMessages' in sdk) || typeof sdk.getSessionMessages !== 'function'
    || !('renameSession' in sdk) || typeof sdk.renameSession !== 'function'
    || !('deleteSession' in sdk) || typeof sdk.deleteSession !== 'function') {
    throw new AgentHistoryError('native_failure', 'The qualified Claude history helper interface is unavailable.');
  }
  const list = sdk.listSessions, info = sdk.getSessionInfo, messages = sdk.getSessionMessages;
  const rename = sdk.renameSession, remove = sdk.deleteSession;
  return {
    renameSession: async (id, title, options) => Reflect.apply(rename, sdk, [id, title, options]),
    deleteSession: async (id, options) => Reflect.apply(remove, sdk, [id, options]),
    listSessions: async (options): Promise<unknown> => Reflect.apply(list, sdk, [options]),
    getSessionInfo: async (id, options): Promise<unknown> => Reflect.apply(info, sdk, [id, options]),
    getSessionMessages: async (id, options): Promise<unknown> => Reflect.apply(messages, sdk, [id, options]),
  };
}

async function execute(channel: HistoryWorkerChannel): Promise<ClaudeWorkerResponse> {
  const request = parseClaudeWorkerRequest(await channel.read());
  if (process.env.CLAUDE_CONFIG_DIR !== request.configHome) {
    throw new AgentHistoryError('invalid_input', 'Claude configuration must be set before loading the native SDK.');
  }
  await assertResourcePolicy();
  const sdk = await loadSdk();
  switch (request.operation.kind) {
    case 'rename': case 'delete': return { version: 1, kind: 'mutation', result: await mutateClaudeSession(sdk, request.source, request.operation, channel) };
    case 'catalog': return { version: 1, kind: 'catalog', page: await listClaudeSessions(sdk, request.source,
      request.includeProgrammatic, request.operation.input, request.pageBytes) };
    case 'lookup': return { version: 1, kind: 'lookup', summary: await lookupClaudeSession(sdk, request.source,
      request.operation.input.conversation.conversationId) };
    case 'transcript': return { version: 1, kind: 'transcript', page: await readClaudeTranscript(sdk, request.source,
      request.operation.input, request.pageBytes) };
  }
}

function failure(error: unknown): ClaudeWorkerResponse {
  return { version: 1, kind: 'error', code: error instanceof AgentHistoryError ? error.code : 'native_failure',
    message: error instanceof AgentHistoryError ? error.message : 'The native Claude history operation failed.' };
}

const channel = new HistoryWorkerChannel();
let response: ClaudeWorkerResponse;
try { response = parseClaudeWorkerResponse(await execute(channel)); }
catch (error) { response = failure(error); }
await channel.write(response);
