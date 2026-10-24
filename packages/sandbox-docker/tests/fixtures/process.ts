// ------------------------------------------------------------------------------------------------
//                process.ts - Real Unix Engine exec fixture - Public Docker process behavior
// ------------------------------------------------------------------------------------------------

import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { engineFixture, gate } from './engine.js';

export const execId = 'a'.repeat(64);

export function frame(channel: 1 | 2, bytes: Uint8Array): Buffer {
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(bytes.byteLength, 4);
  return Buffer.concat([header, bytes]);
}

export interface ProcessFixtureOptions {
  readonly pauseCreate?: PromiseWithResolvers<void>;
  readonly pauseUpgrade?: PromiseWithResolvers<void>;
  readonly pauseStart?: PromiseWithResolvers<void>;
  readonly loseUpgrade?: boolean;
  readonly failComputeDeleteAttempts?: number;
  readonly onAttachment?: (stream: Duplex) => void;
  readonly initialBytes?: Uint8Array;
  readonly runningExitCode?: number | null;
}

export async function processFixture(options: ProcessFixtureOptions = {}) {
  const createEntered = gate();
  const upgradeEntered = gate();
  const attached = gate<Duplex>();
  const inputEnded = gate();
  const inspectionEntered = gate();
  const started = gate();
  const inputBytes: Buffer[] = [];
  const sockets = new Set<Duplex>();
  const upgrades: Array<{ path: string; body: unknown }> = [];
  let containerId: string | undefined;
  let running = false;
  let exitCode: number | null = null;
  let createCount = 0;
  let deleteAttempts = 0;
  const fixture = await engineFixture({ async handleRequest({ method, path, body, response }) {
    const json = (status: number, value: unknown) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    const match = /^\/v1\.52\/containers\/([a-f0-9]{64})\/exec$/u.exec(path);
    if (match && method === 'POST') {
      createCount += 1;
      containerId = match[1];
      createEntered.resolve();
      await options.pauseCreate?.promise;
      if (!fixture.containers.has(containerId)) { json(404, {}); return true; }
      json(201, { Id: execId });
      return true;
    }
    if (path === `/v1.52/exec/${execId}/json`) {
      if (!containerId || !fixture.containers.has(containerId)) json(404, {});
      else {
        json(200, { ID: execId, ContainerID: containerId, Running: running,
          ExitCode: running && options.runningExitCode !== undefined ? options.runningExitCode : exitCode });
        inspectionEntered.resolve();
      }
      return true;
    }
    if (method === 'DELETE' && path === `/v1.52/containers/${containerId}`) {
      deleteAttempts += 1;
      if (deleteAttempts <= (options.failComputeDeleteAttempts ?? 0)) { json(500, {}); return true; }
      for (const socket of sockets) socket.destroy();
    }
    void body;
    return false;
  } });
  fixture.server.on('upgrade', (request, socket, head) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
    void upgrade(request, socket, head).catch(() => socket.destroy());
  });

  async function upgrade(request: IncomingMessage, socket: Duplex, initial: Uint8Array): Promise<void> {
    socket.allowHalfOpen = true;
    socket.pause();
    const length = Number(request.headers['content-length']);
    if (!Number.isInteger(length) || length > 1024) throw new Error('Invalid upgrade fixture body');
    let bytes = Buffer.from(initial);
    while (bytes.byteLength < length) {
      const chunk: unknown = socket.read(length - bytes.byteLength);
      if (chunk instanceof Uint8Array) bytes = Buffer.concat([bytes, chunk]);
      else await new Promise<void>((resolve) => socket.once('readable', resolve));
    }
    upgrades.push({ path: request.url ?? '', body: JSON.parse(bytes.subarray(0, length).toString('utf8')) });
    if (bytes.byteLength > length) inputBytes.push(bytes.subarray(length));
    upgradeEntered.resolve();
    await options.pauseUpgrade?.promise;
    if (!containerId || !fixture.containers.has(containerId)) {
      socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    if (options.loseUpgrade) { socket.destroy(); return; }
    const headers = Buffer.from('HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n');
    socket.write(Buffer.concat([headers, Buffer.from(options.initialBytes ?? [])]));
    socket.on('data', (chunk: Buffer) => inputBytes.push(Buffer.from(chunk)));
    socket.once('end', () => inputEnded.resolve());
    attached.resolve(socket);
    socket.resume();
    await options.pauseStart?.promise;
    if (!fixture.containers.has(containerId)) return;
    running = true;
    exitCode = 0;
    started.resolve();
    options.onAttachment?.(socket);
  }

  return { ...fixture, attached, createEntered, upgradeEntered, inputEnded, inspectionEntered, started, inputBytes, upgrades,
    get createCount() { return createCount; },
    exit(code: number | null = 0) { running = false; exitCode = code; },
    async close() { for (const socket of sockets) socket.destroy(); await fixture.close(); },
  };
}
