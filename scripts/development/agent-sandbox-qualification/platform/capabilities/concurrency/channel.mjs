import assert from 'node:assert/strict';

export function controllerChannel(timeoutMs, maximumMessages) {
  let sequence = 0; const pending = new Map();
  const received = (message) => {
    if (message?.kind !== 'reply') return;
    const current = pending.get(message.id); if (!current) return;
    pending.delete(message.id); clearTimeout(current.timer);
    if (message.failure) current.reject(Object.assign(new Error(message.failure.message), { cause: message.failure }));
    else current.resolve(message.value);
  };
  process.on('message', received);
  return { request(kind, value) {
    assert(process.send && process.connected && pending.size < 16, 'Original qualification supervisor channel is unavailable.');
    const id = ++sequence; assert(id <= maximumMessages, 'Original supervisor protocol message capacity exhausted.');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Original qualification supervisor receipt deadline.')); }, timeoutMs);
      pending.set(id, { kind, resolve, reject, timer });
      process.send({ kind, id, value }, (error) => { if (error) { clearTimeout(timer); pending.delete(id); reject(error); } });
    });
  }, outstanding() {
    return [...pending].map(([id, { kind }]) => ({ id, kind }));
  }, close() {
    process.off('message', received);
    for (const current of pending.values()) { clearTimeout(current.timer); current.reject(new Error('Original qualification supervisor channel closed.')); }
    pending.clear(); if (process.connected) process.disconnect();
  } };
}
