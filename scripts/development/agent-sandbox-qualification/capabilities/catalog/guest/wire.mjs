import { limits, reject } from '../protocol.mjs';

export function metadataWire(child, signal) {
  let pending = null; let nextId = 0; let failed = null; let stdoutJoined = false; let stderrJoined = false; let messages = 0; let stderrBytes = 0; let closing = false;
  const requests = []; const writes = new Set(); const lost = Promise.withResolvers(); void lost.promise.catch(() => {});
  const fail = (code) => {
    if (failed) return; failed = code; const error = Object.assign(new Error('Native metadata transport failed.'), { code });
    pending?.reject(error); pending = null; lost.reject(error);
  };
  const stdout = (async () => {
    let bytes = Buffer.alloc(0);
    try {
      for await (const chunk of child.stdout) {
        if (failed) continue;
        bytes = Buffer.concat([bytes, chunk]);
        for (;;) {
          const newline = bytes.indexOf(10); if (newline < 0) break;
          if (newline > limits.inboundFrameBytes) { fail('frame_limit'); break; }
          const line = bytes.subarray(0, newline); bytes = bytes.subarray(newline + 1);
          if (++messages > limits.inboundMessages) { fail('inbound_limit'); break; }
          let value;
          try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)); }
          catch { fail('protocol'); break; }
          if (!value || Array.isArray(value) || value.jsonrpc !== '2.0') { fail('protocol'); break; }
          if (Object.hasOwn(value, 'method')) {
            if (Object.hasOwn(value, 'id')) { fail('native_request'); break; }
            if (typeof value.method !== 'string' || value.method.length > 256) { fail('protocol'); break; }
            continue;
          }
          if (!pending || value.id !== pending.id || Object.hasOwn(value, 'error') || !Object.hasOwn(value, 'result')) { fail('protocol'); break; }
          const response = pending; pending = null; response.resolve(value.result);
        }
        if (bytes.length > limits.inboundFrameBytes) fail('frame_limit');
      }
      stdoutJoined = true;
      if (bytes.length && !failed) fail('protocol');
      if (pending) fail('native_exit');
    } catch { fail('protocol'); }
  })();
  const stderr = (async () => {
    try { for await (const chunk of child.stderr) { stderrBytes += chunk.length; if (stderrBytes > limits.debugBytes) fail('debug_limit'); } stderrJoined = true; }
    catch { fail('protocol'); }
  })();
  child.stdin.on('error', () => { if (!closing || pending || writes.size) fail('protocol'); });
  return {
    requests, lost: lost.promise, fail,
    get failure() { return failed; },
    get cleanup() { return { stdoutJoined, stderrJoined, writesJoined: writes.size === 0 }; },
    readers: Promise.all([stdout, stderr]),
    closeInput() { closing = true; child.stdin.end(); },
    async request(method, params) {
      if (failed) reject(failed);
      const expected = nextId === 0 ? 'initialize' : requests.includes('_x.ai/auth/info') ? '_x.ai/models/list'
        : nextId === 1 && method === 'authenticate' ? 'authenticate' : '_x.ai/auth/info';
      if (pending || method !== expected || nextId >= limits.outboundRequests || requests.includes(method)) reject('request_limit');
      if (signal.aborted) reject(signal.reason?.code ?? 'cancelled');
      const id = ++nextId; const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      if (frame.length > limits.outboundFrameBytes) reject('frame_limit');
      const response = Promise.withResolvers(); void response.promise.catch(() => {}); pending = { id, ...response }; requests.push(method);
      const abort = () => fail(signal.reason?.code ?? 'cancelled'); signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => fail('request_timeout'), limits.requestMs);
      try {
        const writing = new Promise((resolve, rejectWrite) => child.stdin.write(frame, (error) => error ? rejectWrite(error) : resolve()));
        writes.add(writing); void writing.then(() => writes.delete(writing), () => writes.delete(writing));
        await Promise.race([writing, lost.promise]);
        return await response.promise;
      } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
    },
  };
}
