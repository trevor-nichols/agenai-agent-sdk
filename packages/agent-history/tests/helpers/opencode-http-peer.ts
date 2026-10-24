import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

export interface OpenCodeHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
}

export async function createOpenCodeHttpPeer(handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>) {
  const requests: OpenCodeHttpRequest[] = [];
  const sockets = new Set<Socket>(), pending = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    requests.push({ method: request.method ?? 'GET', path: url.pathname, query: url.searchParams });
    pending.add(response);
    response.once('close', () => pending.delete(response));
    Promise.resolve(handler(request, response)).catch(() => response.destroy());
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('HTTP fixture has no loopback address.');
  return { endpoint: `http://127.0.0.1:${address.port}`, requests,
    get pendingRequests() { return pending.size; },
    close: async () => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}

export function openCodeHttpSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'ses_ms005_http', projectID: 'project_ms005_http', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1767268800000, updated: 1767268860000 },
    title: 'Stored HTTP fixture conversation', location: { directory: '/synthetic/opencode-project' }, ...overrides };
}

export function openCodeJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}
