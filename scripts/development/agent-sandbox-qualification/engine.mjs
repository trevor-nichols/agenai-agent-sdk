// ------------------------------------------------------------------------------------------------
//                engine.mjs - Bounded control transport for explicitly selected qualification fixtures
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export class Engine {
  constructor(socketPath, apiVersion = '1.52', limits = {}) {
    this.socketPath = socketPath;
    this.apiVersion = apiVersion;
    this.limits = { requestMs: 5000, outputBytes: 1048576, frameBytes: 65536, ...limits };
  }

  request(method, path, body, { allowed = [200, 201, 204], binary = false, signal } = {}) {
    const payload = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const request = http.request({
        socketPath: this.socketPath, path: `/v${this.apiVersion}${path}`, method, signal,
        headers: payload ? { 'content-type': Buffer.isBuffer(body) ? 'application/x-tar' : 'application/json', 'content-length': payload.length } : {},
      }, (response) => {
        if (settled) { response.destroy(); return; }
        let bytes = 0;
        const chunks = [];
        response.on('data', (chunk) => {
          bytes += chunk.length;
          if (bytes > this.limits.outputBytes) response.destroy(new Error('Engine response exceeds byte limit'));
          else chunks.push(chunk);
        });
        response.on('error', (error) => settle(error));
        response.on('end', () => {
          const data = Buffer.concat(chunks);
          if (!allowed.includes(response.statusCode)) {
            settle(new Error(`Engine ${method} ${path.split('?')[0]} returned ${response.statusCode}`));
            return;
          }
          try {
            settle(null, { status: response.statusCode, data: binary ? data : data.length ? JSON.parse(data) : null });
          } catch { settle(new Error('invalid Engine JSON response')); }
        });
      });
      timer = setTimeout(() => {
        const error = new Error('Engine request deadline');
        request.destroy(error);
        settle(error);
      }, this.limits.requestMs);
      request.on('error', (error) => settle(error));
      request.end(payload);
    });
  }

  hijack(path, body) {
    const payload = body ? Buffer.from(JSON.stringify(body)) : undefined;
    return new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(value);
      };
      const request = http.request({
        socketPath: this.socketPath, path: `/v${this.apiVersion}${path}`, method: 'POST',
        headers: { connection: 'Upgrade', upgrade: 'tcp', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
      });
      timer = setTimeout(() => {
        const error = new Error('Engine attach handshake deadline');
        request.destroy(error);
        settle(error);
      }, this.limits.requestMs);
      request.once('error', (error) => settle(error));
      request.once('response', (response) => { response.destroy(); settle(new Error(`Engine did not upgrade stream: ${response.statusCode}`)); });
      request.once('upgrade', (response, socket, head) => {
        if (settled) { socket.destroy(); return; }
        socket.setTimeout(0);
        try { settle(null, new AttachedStream(socket, head, this.limits)); } catch (error) { socket.destroy(); settle(error); }
      });
      request.end(payload);
    });
  }
}

class AttachedStream {
  constructor(socket, head, limits) {
    this.socket = socket;
    this.limits = limits;
    this.pending = Buffer.alloc(0);
    this.stdout = Buffer.alloc(0);
    this.stderr = Buffer.alloc(0);
    this.failure = null;
    this.closed = false;
    this.completion = new Promise((resolve) => {
      socket.on('data', (chunk) => {
        try { this.consume(chunk); } catch (error) { this.failure = error; socket.destroy(); }
      });
      socket.on('error', (error) => { this.failure = error; });
      socket.on('close', () => { this.closed = true; resolve(); });
    });
    this.consume(head);
  }

  consume(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    while (this.pending.length >= 8) {
      const kind = this.pending[0];
      assert((kind === 1 || kind === 2) && this.pending.subarray(1, 4).equals(Buffer.alloc(3)), 'invalid Engine stream header');
      const length = this.pending.readUInt32BE(4);
      assert(length <= this.limits.frameBytes, 'Engine frame exceeds limit');
      if (this.pending.length < length + 8) break;
      assert(this.stdout.length + this.stderr.length + length <= this.limits.outputBytes, 'Engine output exceeds limit');
      const field = kind === 1 ? 'stdout' : 'stderr';
      this[field] = Buffer.concat([this[field], this.pending.subarray(8, length + 8)]);
      this.pending = this.pending.subarray(length + 8);
    }
  }

  async waitFor(predicate, timeoutMs) {
    await until(() => {
      if (this.failure) throw this.failure;
      return predicate(this);
    }, timeoutMs, 'stream observation deadline');
  }

  async close() {
    this.socket.destroy();
    await this.completion;
    if (this.failure) throw this.failure;
  }
}

export async function until(observe, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  do {
    const value = await observe();
    if (value) return value;
    await delay(25);
  } while (Date.now() < deadline);
  throw new Error(message);
}
