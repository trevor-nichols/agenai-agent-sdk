// ------------------------------------------------------------------------------------------------
//                admission.ts - Process-lifetime CLI exclusion through owned-directory retirement
// ------------------------------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { DelegationOperationError } from '@agen-ai/agent-orchestration';
import { qualifiedTuple, readState, type DemoState } from './state.js';

/** Linux abstract sockets leave no stale file and retain admission until close or process exit. */
export async function withDemoAdmission<Value>(inspected: DemoState, action: (state: DemoState) => Promise<Value>): Promise<Value> {
  qualifiedTuple(inspected.root);
  const digest = createHash('sha256').update(JSON.stringify([
    inspected.root, inspected.identity.dev, inspected.identity.ino, process.getuid!(),
  ])).digest('hex');
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    const failed = (error: NodeJS.ErrnoException) => reject(error.code === 'EADDRINUSE'
      ? new DelegationOperationError('owner_lost', 'Another live durable example command owns this directory.') : error);
    server.once('error', failed);
    server.listen(`\0agenai-delegation:${digest}`, () => { server.off('error', failed); resolve(); });
  });
  // A caller may have inspected the marker before another command retired its directory.
  const current = readState(inspected.root);
  if (current.identity.dev !== inspected.identity.dev || current.identity.ino !== inspected.identity.ino) {
    throw new DelegationOperationError('owner_lost', 'The inspected durable example directory changed before admission.');
  }
  const result = await action(current);
  // A rejected action may retain native producers. Its CLI exits with this admission still held.
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return result;
}
