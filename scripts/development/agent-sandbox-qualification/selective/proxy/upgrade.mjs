// ------------------------------------------------------------------------------------------------
//                upgrade.mjs - Unbuffered Docker attach upgrade and owned duplex socket retirement
// ------------------------------------------------------------------------------------------------

import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { finished, pipeline } from 'node:stream/promises';

async function upgradeBody(request, socket, head, signal) {
  assert.equal(request.headers['transfer-encoding'], undefined, 'Qualified upgrade requests require an explicit bounded JSON content length.');
  const length = request.headers['content-length'] ?? '0';
  assert(typeof length === 'string' && /^(0|[1-9][0-9]*)$/u.test(length));
  const size = Number(length);
  assert(Number.isSafeInteger(size) && size <= 64 * 1024, 'Upgrade control body exceeds 64 KiB.');
  const body = Buffer.alloc(size);
  let offset = Math.min(size, head.length);
  head.copy(body, 0, 0, offset);
  const remainingHead = head.subarray(offset);
  socket.pause();
  while (offset < size) {
    signal.throwIfAborted();
    if (socket.destroyed || socket.readableEnded) throw new Error('Upgrade control body ended early.');
    if (!socket.readableLength) {
      await new Promise((resolve, reject) => {
        const clean = () => { socket.removeListener('readable', ready); socket.removeListener('close', closed); signal.removeEventListener('abort', aborted); };
        const ready = () => { clean(); resolve(); };
        const closed = () => { clean(); reject(new Error('Upgrade control body closed early.')); };
        const aborted = () => { clean(); reject(signal.reason); };
        socket.once('readable', ready); socket.once('close', closed); signal.addEventListener('abort', aborted, { once: true });
      });
      continue;
    }
    const chunk = socket.read(Math.min(size - offset, socket.readableLength));
    chunk.copy(body, offset); offset += chunk.length;
  }
  return { body, remainingHead };
}

export async function forwardUpgrade({ request, socket, head, socketPath, record, trace, signal, observeUpgrade }) {
  let peer;
  let upstream;
  const local = new AbortController();
  const activeSignal = AbortSignal.any([signal, local.signal]);
  const cancellation = () => { local.abort(new Error('Owned upgrade forwarding cancelled.')); socket.destroy(); peer?.destroy(); upstream?.destroy(local.signal.reason); };
  signal.addEventListener('abort', cancellation, { once: true });
  socket.once('close', cancellation);
  upstream = http.request({ socketPath, method: request.method, path: request.url, headers: request.headers, agent: false });
  const closed = finished(socket, { cleanup: true });
  void closed.catch(() => {});
  try {
    const opening = new Promise((resolve, reject) => {
      upstream.once('error', reject);
      upstream.once('response', (response) => { response.on('error', () => {}); resolve({ kind: 'response', response }); });
      upstream.once('upgrade', (response, target, initial) => resolve({ kind: 'upgrade', response, target, initial }));
    });
    void opening.catch(() => {});
    const input = await upgradeBody(request, socket, head, activeSignal);
    record.uploadedBytes = input.body.length;
    upstream.end(input.body);
    const opened = await opening;
    record.status = opened.response.statusCode;
    const lines = [];
    for (let index = 0; index < opened.response.rawHeaders.length; index += 2) lines.push(`${opened.response.rawHeaders[index]}: ${opened.response.rawHeaders[index + 1]}`);
    const write = async (bytes) => { if (!socket.write(bytes)) await once(socket, 'drain', { signal: activeSignal }); };
    await write(`HTTP/${opened.response.httpVersion} ${opened.response.statusCode} ${opened.response.statusMessage}\r\n${lines.join('\r\n')}\r\n\r\n`);
    if (opened.kind === 'response') {
      // IncomingMessage decodes chunked framing; restore it when retaining those wire headers.
      const chunked = /(?:^|,)\s*chunked\s*$/iu.test(opened.response.headers['transfer-encoding'] ?? '');
      for await (const chunk of opened.response) {
        activeSignal.throwIfAborted();
        record.upstreamBodyBytes += chunk.length;
        if (chunked) await write(`${chunk.length.toString(16)}\r\n`);
        await write(chunk);
        if (chunked) await write('\r\n');
        record.forwardedBodyBytes += chunk.length;
      }
      if (chunked) {
        const trailers = [];
        for (let index = 0; index < opened.response.rawTrailers.length; index += 2) trailers.push(`${opened.response.rawTrailers[index]}: ${opened.response.rawTrailers[index + 1]}`);
        await write(`0\r\n${trailers.length ? `${trailers.join('\r\n')}\r\n` : ''}\r\n`);
      }
      socket.end();
      await closed;
      return;
    }
    peer = opened.target;
    const peerClosed = finished(peer, { cleanup: true });
    void peerClosed.catch(() => {});
    const connection = () => ({
      downstream: { destroyed: socket.destroyed, readableEnded: socket.readableEnded, writableEnded: socket.writableEnded },
      upstream: { destroyed: peer.destroyed, readableEnded: peer.readableEnded, writableEnded: peer.writableEnded },
    });
    const observer = observeUpgrade?.({ method: request.method, target: request.url, status: opened.response.statusCode, record, connection });
    let observing; let observingInput;
    if (observer) {
      const observeInput = async (bytes) => {
        activeSignal.throwIfAborted();
        await observer.input(bytes);
        if (peer.destroyed) cancellation();
        activeSignal.throwIfAborted();
      };
      if (input.remainingHead.length) { await observeInput(input.remainingHead); peer.write(input.remainingHead); }
      observingInput = pipeline(socket, async function* (source) {
        for await (const chunk of source) { await observeInput(chunk); yield chunk; }
      }, peer, { signal: activeSignal });
      void observingInput.catch(() => { socket.destroy(); peer.destroy(); });
      observing = (async () => {
        if (opened.initial.length && await observer.response(opened.initial, write) === 'close') { socket.destroy(); peer.destroy(); return; }
        for await (const chunk of peer) {
          if (await observer.response(chunk, write) === 'close') { socket.destroy(); peer.destroy(); return; }
        }
      })();
      void observing.catch(() => { socket.destroy(); peer.destroy(); });
    } else {
      if (input.remainingHead.length) peer.write(input.remainingHead);
      socket.pipe(peer);
      if (opened.initial.length) socket.write(opened.initial);
      peer.pipe(socket);
    }
    socket.once('close', () => peer.destroy());
    peer.once('close', () => socket.destroy());
    await Promise.allSettled([closed, peerClosed, observing, observingInput]);
    await observing;
  } catch (error) {
    record.failure = { name: error instanceof Error ? error.name : 'ThrownValue', message: String(error instanceof Error ? error.message : error).slice(0, 512) };
  } finally {
    signal.removeEventListener('abort', cancellation);
    socket.removeListener('close', cancellation);
    upstream.destroy();
    cancellation();
    await closed.catch(() => {});
    await trace.finish(record);
  }
}
