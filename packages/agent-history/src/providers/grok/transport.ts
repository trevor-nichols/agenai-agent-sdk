import type { ChildProcess } from 'node:child_process';
import { AgentHistoryError } from '../../lifecycle/errors.js';
import type { AgentHistoryMutationOperation } from '../../contracts/index.js';
import { terminateProcessGroup, waitForGroupExit } from '../process/group.js';
import type { GrokHistoryConnection, GrokManagementConnection } from './contracts.js';
import { grokHistoryExtensions } from './extensions.js';
import { assertGrokInitialization, GROK_RAW_BYTES } from './native.js';

export async function openGrokTransport(child: ChildProcess, management: readonly AgentHistoryMutationOperation[] = []) {
  if (!child.stdout || !child.stdin || !child.stderr) throw new AgentHistoryError('native_failure', 'Grok history requires owned process pipes.');
  let launchError = false;
  const closed = new Promise<void>((resolve) => {
    child.once('error', () => { launchError = true; });
    child.once('close', () => resolve());
  });
  const pid = child.pid;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    if (pid !== undefined) terminateProcessGroup(pid);
    stopped = true;
  };
  const transport = await import('@agen-ai/acp-transport');
  const client = transport.createAcpClient({ stdout: child.stdout, stdin: child.stdin, stderr: child.stderr,
    schemaChannel: 'stable', schemaProfile: 'schema-v1.23.0', unknownExtensionPolicy: 'standard',
    extensions: transport.createAcpExtensionRegistry(grokHistoryExtensions({ management })),
    limits: { maxInboundFrameBytes: GROK_RAW_BYTES, maxOutboundFrameBytes: GROK_RAW_BYTES,
      maxOutboundBufferedBytes: GROK_RAW_BYTES + 1, maxOutstandingRequests: 1, maxInboundRequestConcurrency: 1,
      maxNotificationHandlerConcurrency: 1, maxStderrBufferedBytes: 131_072, shutdownDrainMs: 2000 },
  });
  const standard = transport.createAcpStandardSessionOperations(client);
  const request = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (launchError) throw new AgentHistoryError('native_failure', 'The owned Grok history process failed to start.');
      throw error;
    }
  };
  return {
    async initialize(signal: AbortSignal, timeoutMs: number): Promise<GrokHistoryConnection & GrokManagementConnection> {
      const initialization = await request(() => standard.initialize({ protocolVersion: 1, clientCapabilities: {},
        clientInfo: { name: 'agenai-history', version: '0.4.4' } }, { signal, timeoutMs }));
      assertGrokInitialization(initialization);
      return { protocolProfile: 'schema-v1.23.0', runtimeVersion: '1.0.62', initialization,
        resources: { kind: 'caller_owned', maxInboundFrameBytes: GROK_RAW_BYTES },
        listSessions: (params, options) => request(() => standard.listSessions(params, options)),
        sessionState: (params, options) => request(() => client.request('_x.ai/session/state', params, options)),
        sessionUpdates: (params, options) => request(() => client.request('_x.ai/session/updates', params, options)),
        sessionSearch: (params, options) => request(() => client.request('_x.ai/session/search', params, options)),
        sessionRename: (params, options) => request(() => client.request('_x.ai/session/rename', params, options)),
        sessionDelete: (params, options) => request(() => client.request('_x.ai/session/delete', params, options)),
      };
    },
    stop,
    async dispose(): Promise<void> {
      stop();
      await client.dispose();
      await closed;
      if (pid !== undefined) await waitForGroupExit(pid);
    },
  };
}
