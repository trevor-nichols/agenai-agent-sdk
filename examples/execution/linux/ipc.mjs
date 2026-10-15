import { connect } from 'node:net';

export const MAX_MESSAGE_BYTES = 4_194_304;

export function receiveMessage(socket, callback) {
  let buffered = '';
  socket.setEncoding('utf8');
  const onData = (chunk) => {
    buffered += chunk;
    if (Buffer.byteLength(buffered) > MAX_MESSAGE_BYTES) {
      socket.destroy(new Error('Execution control message exceeds its bound.'));
      return;
    }
    const end = buffered.indexOf('\n');
    if (end < 0) return;
    socket.off('data', onData);
    try { callback(JSON.parse(buffered.slice(0, end))); }
    catch { socket.destroy(new Error('Invalid execution control message.')); }
  };
  socket.on('data', onData);
}

export function request(path, message, timeoutMs = 10_000) {
  const encoded = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) throw new Error('Execution recipe exceeds its bound.');
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const timer = setTimeout(() => socket.destroy(new Error('Execution control request timed out.')), timeoutMs);
    let settled = false;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.on('error', (error) => settle(error));
    socket.on('close', () => settle(new Error('Execution control closed without a response.')));
    socket.on('connect', () => socket.write(encoded));
    receiveMessage(socket, (response) => {
      if (response.ok === true) settle(null, response.value);
      else settle(new Error(response.error ?? 'Execution control failed.'));
    });
  });
}

export function connectStream(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    // The reservation owns errors even in the gap before SDK transport listeners
    // exist. The connected socket still exposes its error/closed state.
    socket.on('error', () => {});
    socket.once('connect', () => { socket.off('error', reject); resolve(socket); });
    socket.once('error', reject);
  });
}
