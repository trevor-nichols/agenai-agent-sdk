import { PassThrough } from 'node:stream';
import { createAcpClient, type AcpClient, type AcpExtensionRegistry } from '@agen-ai/acp-transport';

export interface AcpHistoryPeerRequest {
  readonly id: string | number;
  readonly method: string;
  readonly params: unknown;
}
export type AcpHistoryPeerResponse =
  | { readonly result: unknown }
  | { readonly error: { readonly code: number; readonly message: string } };

export interface AcpHistoryPeer {
  readonly client: AcpClient;
  readonly requests: readonly AcpHistoryPeerRequest[];
  readonly notifications: readonly { readonly method: string; readonly params: unknown }[];
  nextNotification(): Promise<{ readonly method: string; readonly params: unknown }>;
  sendNotification(method: string, params: unknown): void;
  sendRaw(bytes: string | Uint8Array): void;
  close(): Promise<void>;
}

export function createAcpHistoryPeer(options: {
  readonly respond: (request: AcpHistoryPeerRequest) => AcpHistoryPeerResponse | Promise<AcpHistoryPeerResponse>;
  readonly extensions?: AcpExtensionRegistry;
  readonly maxInboundFrameBytes?: number;
}): AcpHistoryPeer {
  const stdout = new PassThrough(), stdin = new PassThrough();
  const requests: AcpHistoryPeerRequest[] = [];
  const notifications: { method: string; params: unknown }[] = [], queuedNotifications: { method: string; params: unknown }[] = [];
  const notificationWaiters: ((value: { method: string; params: unknown }) => void)[] = [];
  const cancelled = new Set<string | number>();
  let buffered = '';
  const responses = new Set<Promise<void>>();
  const send = (value: unknown) => stdout.write(`${JSON.stringify(value)}\n`);
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let newline: number;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffered.slice(0, newline)) as { id?: string | number; method: string; params: unknown };
      buffered = buffered.slice(newline + 1);
      if (message.id === undefined) {
        const notification = { method: message.method, params: message.params };
        notifications.push(notification);
        if (message.method === '$/cancel_request' && message.params !== null && typeof message.params === 'object'
          && 'requestId' in message.params && (typeof message.params.requestId === 'string' || typeof message.params.requestId === 'number')) {
          cancelled.add(message.params.requestId);
        }
        const waiter = notificationWaiters.shift();
        if (waiter === undefined) queuedNotifications.push(notification); else waiter(notification);
        continue;
      }
      const request = { id: message.id, method: message.method, params: message.params };
      requests.push(request);
      const response = Promise.resolve().then(() => options.respond(request)).then((value) => {
        if (!cancelled.delete(request.id)) send({ jsonrpc: '2.0', id: request.id, ...value });
      });
      responses.add(response);
      void response.then(() => responses.delete(response), () => responses.delete(response));
    }
  });
  const client = createAcpClient({ stdout, stdin, schemaChannel: 'stable', schemaProfile: 'schema-v1.23.0',
    unknownExtensionPolicy: 'standard', ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
    limits: { maxInboundFrameBytes: options.maxInboundFrameBytes ?? 1_048_576, maxOutstandingRequests: 1 } });
  return { client, requests, notifications,
    nextNotification: () => {
      const value = queuedNotifications.shift();
      return value === undefined ? new Promise((resolve) => notificationWaiters.push(resolve)) : Promise.resolve(value);
    },
    sendNotification: (method, params) => { send({ jsonrpc: '2.0', method, params }); },
    sendRaw: (bytes) => { stdout.write(bytes); },
    async close() { await client.dispose(); await Promise.all(responses); stdout.destroy(); stdin.destroy(); },
  };
}

export function acpHistoryInitialization(list: boolean, name = 'synthetic-history-peer') {
  return { protocolVersion: 1, agentCapabilities: { sessionCapabilities: list ? { list: {} } : {} },
    authMethods: [], agentInfo: { name, version: '1.0.0' } };
}
