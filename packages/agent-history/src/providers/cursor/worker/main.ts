import { readFile } from 'node:fs/promises';
import { AgentHistoryError } from '../../../lifecycle/errors.js';
import { inspectCursorSdk } from '../identity.js';
import { listCursorAgents, listCursorViews, lookupCursorAgent } from '../session.js';
import { readCursorTranscript } from '../transcript.js';
import { connectCursorSdk } from './sdk.js';
import { mutateCursorAgent } from '../mutations.js';
import { HistoryWorkerChannel } from '../../process/worker-channel.js';
import {
  parseCursorWorkerRequest, parseCursorWorkerResponse, type CursorWorkerResponse,
} from './protocol.js';

async function assertResourcePolicy(): Promise<void> {
  if (process.platform !== 'linux' || !process.execArgv.includes('--jitless') || !process.execArgv.includes('--max-old-space-size=128')) {
    throw new AgentHistoryError('unsupported_scope', 'Cursor local history requires the qualified Linux worker resource policy.');
  }
  const limits = await readFile('/proc/self/limits', 'utf8');
  for (const { name, maximum } of [
    { name: 'address space', maximum: 4_294_967_296 }, { name: 'cpu time', maximum: 12 },
    { name: 'open files', maximum: 128 }, { name: 'core file size', maximum: 0 },
  ]) {
    const match = new RegExp(`^Max ${name}\\s+(\\S+)\\s+(\\S+)`, 'mu').exec(limits);
    if (!match || ![match[1], match[2]].every((value) => value !== undefined && /^\d+$/u.test(value)
      && Number.isSafeInteger(Number(value)) && Number(value) <= maximum && (maximum === 0 || Number(value) > 0))) {
      throw new AgentHistoryError('unsupported_scope', 'Cursor worker kernel limits are missing or exceed the qualified policy.');
    }
  }
}

let receiptWritten = false;
async function execute(channel: HistoryWorkerChannel): Promise<CursorWorkerResponse | undefined> {
  const request = parseCursorWorkerRequest(await channel.read());
  await assertResourcePolicy();
  const entries = await inspectCursorSdk();
  const native: unknown = await import(entries.entry);
  const sqlite: unknown = request.store.kind === 'sqlite' ? await import(entries.sqliteEntry) : undefined;
  const sdk = await connectCursorSdk(native, sqlite, request);
  try {
    switch (request.operation.kind) {
      case 'archive': case 'restore': case 'delete': {
        const response = parseCursorWorkerResponse({ version: 1, kind: 'mutation',
          result: await mutateCursorAgent(sdk, request.source, request.operation, channel) });
        await channel.write(response);
        receiptWritten = true;
        return undefined;
      }
      case 'catalog': return { version: 1, kind: 'catalog', page: await listCursorAgents(sdk, request.source, request.operation.input, request.pageBytes) };
      case 'lookup': return { version: 1, kind: 'lookup', summary: await lookupCursorAgent(sdk, request.source, request.operation.input.conversation.conversationId) };
      case 'views': return { version: 1, kind: 'views', page: await listCursorViews(sdk, request.source, request.operation.input, request.pageBytes) };
      case 'transcript': return { version: 1, kind: 'transcript', page: await readCursorTranscript(sdk, request.source, request.operation.input, request.pageBytes) };
    }
  } finally { await sdk.dispose(); }
}

function failure(error: unknown): CursorWorkerResponse {
  if (error instanceof AgentHistoryError) return { version: 1, kind: 'error', code: error.code, message: error.message };
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== 'object') break;
    if ('code' in current && current.code === 'agent_not_found') return { version: 1, kind: 'error', code: 'not_found', message: 'The Cursor local agent is missing.' };
    if ('code' in current && (current.code === 'EACCES' || current.code === 'EPERM')) return { version: 1, kind: 'error', code: 'access_denied', message: 'The configured Cursor store is not accessible.' };
    current = 'cause' in current ? current.cause : undefined;
  }
  return { version: 1, kind: 'error', code: 'native_failure', message: 'The native Cursor history operation failed.' };
}

const channel = new HistoryWorkerChannel();
try {
  const response = await execute(channel);
  if (response !== undefined) await channel.write(parseCursorWorkerResponse(response));
} catch (error) {
  if (receiptWritten) process.exitCode = 1;
  else await channel.write(failure(error));
}
