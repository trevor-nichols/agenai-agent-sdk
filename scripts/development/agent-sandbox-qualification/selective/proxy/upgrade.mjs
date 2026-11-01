// ------------------------------------------------------------------------------------------------
//                upgrade.mjs - Unbuffered Docker attach upgrade and owned duplex socket retirement
// ------------------------------------------------------------------------------------------------

import http from 'node:http';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';

// Above this backlog the relay pauses Docker again. Observers bound their own attach volumes far lower; an unobserved
// upgrade to a slow reader can hold the whole backlog.
const UPGRADE_QUEUE_BYTES = 8 * 1024 * 1024;

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
    record.droppedInputBytes = 0;
    const peerClosed = finished(peer, { cleanup: true });
    void peerClosed.catch(() => {});
    const connection = () => ({
      downstream: { destroyed: socket.destroyed, readableEnded: socket.readableEnded, writableEnded: socket.writableEnded },
      upstream: { destroyed: peer.destroyed, readableEnded: peer.readableEnded, writableEnded: peer.writableEnded },
    });
    // An unobserved upgrade relays through the same bounded queue, so Docker's tail is read before late input can meet its
    // full close and an abnormal upstream close is recorded rather than silently cutting the client.
    const observer = observeUpgrade?.({ method: request.method, target: request.url, status: opened.response.statusCode, record, connection })
      ?? { input: async () => {}, response: (bytes, forward) => forward(bytes) };
    let inputFailure;
    const observeInput = async (bytes) => {
      activeSignal.throwIfAborted();
      try { await observer.input(bytes); } catch (error) { inputFailure ??= error; throw error; }
      activeSignal.throwIfAborted();
    };
    // Upstream bytes leave the socket as they arrive: a late input write that fails against Docker's full close destroys
    // that socket, but not bytes already queued here for the observer. Input after upstream EOF has no recipient.
    const received = []; let receivedBytes = 0; let upstreamEnded = false; let upstreamClosed = false; let upstreamFailure; let wake;
    const notify = () => { const resolve = wake; wake = undefined; resolve?.(); };
    peer.on('data', (chunk) => { received.push(chunk); receivedBytes += chunk.length; if (receivedBytes >= UPGRADE_QUEUE_BYTES) peer.pause(); notify(); });
    peer.once('end', () => { upstreamEnded = true; notify(); });
    peer.on('error', (error) => { upstreamFailure ??= error; notify(); });
    peer.once('close', () => { upstreamClosed = true; notify(); });
    const upstreamInput = new Writable({
      write(chunk, _encoding, done) {
        if (upstreamEnded || peer.destroyed || peer.writableEnded) { record.droppedInputBytes += chunk.length; done(); return; }
        if (peer.write(chunk)) { done(); return; }
        const resume = () => { peer.off('drain', resume); peer.off('close', resume); done(); };
        peer.once('drain', resume); peer.once('close', resume);
      },
      final(done) { if (!peer.destroyed && !peer.writableEnded) peer.end(); done(); },
    });
    if (input.remainingHead.length) { await observeInput(input.remainingHead); peer.write(input.remainingHead); }
    const observingInput = pipeline(socket, async function* (source) {
      for await (const chunk of source) { await observeInput(chunk); yield chunk; }
    }, upstreamInput, { signal: activeSignal });
    void observingInput.catch(() => { socket.destroy(); peer.destroy(); });
    // A client that closes while its write waits for drain has cancelled the upgrade, as one that closes while idle has.
    let downstreamLost = false;
    const forward = (bytes) => write(bytes).catch((error) => { if (socket.destroyed) downstreamLost = true; throw error; });
    const respond = (bytes) => observer.response(bytes, forward).catch((error) => { if (downstreamLost) return 'lost'; throw error; });
    const observing = (async () => {
      const initial = opened.initial.length ? await respond(opened.initial) : undefined;
      if (initial === 'lost') return;
      if (initial === 'close') { socket.destroy(); peer.destroy(); return; }
      for (;;) {
        const chunk = received.shift();
        if (chunk === undefined) {
          if (upstreamEnded || upstreamClosed) break;
          await new Promise((resolve) => { wake = resolve; });
          continue;
        }
        receivedBytes -= chunk.length;
        if (peer.isPaused() && receivedBytes < UPGRADE_QUEUE_BYTES / 2) peer.resume();
        const outcome = await respond(chunk);
        if (outcome === 'lost') return;
        if (outcome === 'close') { socket.destroy(); peer.destroy(); return; }
      }
      if (!upstreamEnded && !activeSignal.aborted) throw upstreamFailure ?? new Error('Upgrade upstream closed before EOF.');
      socket.end();
    })();
    void observing.catch(() => { socket.destroy(); peer.destroy(); });
    socket.once('close', () => peer.destroy());
    await Promise.allSettled([closed, peerClosed, observing, observingInput]);
    await observing;
    if (inputFailure) throw inputFailure;
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
