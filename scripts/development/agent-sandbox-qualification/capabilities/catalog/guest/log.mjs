import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { endpoint, limits, refreshConfirmed, reject } from '../protocol.mjs';

const targets = new Set(['xai_grok_shell::remote::model_source::oai', 'xai_grok_shell::agent::remote_config::fetch',
  'xai_grok_shell::agent::remote_config::manager']);
function record(line) {
  const prefix = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z +(?<level>TRACE|DEBUG|INFO|WARN|ERROR) +/u.exec(line);
  if (!prefix) return null;
  let rest = line.slice(prefix[0].length);
  for (let span = 0; span <= 8; span++) {
    let depth = 0; let quoted = false; let escaped = false; let boundary = -1;
    for (let index = 0; index < rest.length; index++) {
      const character = rest[index];
      if (escaped) { escaped = false; continue; }
      if (quoted && character === '\\') { escaped = true; continue; }
      if (character === '"') { quoted = !quoted; continue; }
      if (!quoted && character === '{') depth++;
      if (!quoted && character === '}') depth--;
      if (depth < 0 || depth > 4) return null;
      if (!quoted && depth === 0 && rest.slice(index, index + 2) === ': ') { boundary = index; break; }
    }
    if (boundary < 0) return null;
    const target = rest.slice(0, boundary); rest = rest.slice(boundary + 2);
    if (targets.has(target)) return { level: prefix.groups.level, target, message: rest };
    if (target.length > 2048 || !/^[A-Za-z0-9_.-]{1,128}\{[^\r\n]*\}$/u.test(target)) return null;
  }
  return null;
}
function positiveCount(value) { const count = Number(value); if (!Number.isSafeInteger(count) || count < 1 || count > 65535) reject('projection_limit'); return count; }

export function projectLogLine(line) {
  const entry = record(line); if (!entry) return null;
  const { level, target, message } = entry;
  if (target === 'xai_grok_shell::remote::model_source::oai') {
    if (level === 'INFO' && message === `Fetching models from ${endpoint}`) return { kind: 'http_fetch_started', count: null };
    const fetched = /^Fetched ([0-9]{1,10}) models from https:\/\/cli-chat-proxy\.grok\.com\/v1\/models$/u.exec(message);
    if (level === 'INFO' && fetched) return { kind: 'http_fetch_completed', count: positiveCount(fetched[1]) };
    if (level === 'WARN' && /^Failed to fetch models: /u.test(message)) return { kind: 'remote_fetch_failed', count: null };
  }
  if (target === 'xai_grok_shell::agent::remote_config::fetch') {
    const prefetched = /^Prefetched models count=([0-9]{1,10})(?: etag=(?:None|Some\("(?:[^"\\\r\n]|\\.)*"\)))?$/u.exec(message);
    if (level === 'INFO' && prefetched) return { kind: 'prefetch_completed', count: positiveCount(prefetched[1]) };
    if (level === 'WARN' && (message === 'Models endpoint returned empty list' || /^Failed to fetch models(?: |$)/u.test(message))) return { kind: 'remote_fetch_failed', count: null };
  }
  if (target === 'xai_grok_shell::agent::remote_config::manager') {
    if (/^model catalog: falling back to bundled defaults only(?: |$)/u.test(message)) return { kind: 'fallback', count: null };
    if (/^model catalog: fetch succeeded(?: |$)/u.test(message)) return { kind: 'manager_success', count: null };
    if (/^model refresh failed, leaving existing models unchanged(?: |$)/u.test(message)) return { kind: 'remote_fetch_failed', count: null };
  }
  return null;
}

export function logProjection(filename) {
  const events = []; let offset = 0; let pending = Buffer.alloc(0); let identity;
  const append = (event) => {
    const projected = { sequence: events.length + 1, ...event };
    if (events.length >= limits.projectedEvents || Buffer.byteLength(JSON.stringify([...events, projected])) > limits.projectedBytes) reject('projection_limit');
    events.push(projected);
  };
  return {
    events, append,
    confirmed: () => refreshConfirmed(events),
    async poll(final = false) {
      let before;
      try { before = await lstat(filename, { bigint: true }); }
      catch (error) { if (error.code === 'ENOENT') return; throw error; }
      if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid()) || before.size < BigInt(offset)) reject('remote_unproven');
      if (before.size > BigInt(limits.debugBytes)) reject('debug_limit');
      if (identity && (identity.dev !== before.dev || identity.ino !== before.ino)) reject('remote_unproven');
      identity = before;
      const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await file.stat({ bigint: true }); if (opened.dev !== before.dev || opened.ino !== before.ino) reject('remote_unproven');
        while (offset < Number(before.size)) {
          const bytes = Buffer.alloc(Math.min(64 * 1024, Number(before.size) - offset));
          const { bytesRead } = await file.read(bytes, 0, bytes.length, offset); if (!bytesRead) reject('remote_unproven'); offset += bytesRead;
          pending = Buffer.concat([pending, bytes.subarray(0, bytesRead)]);
          for (;;) {
            const newline = pending.indexOf(10); if (newline < 0) break;
            if (newline > limits.debugLineBytes) reject('debug_limit');
            const line = new TextDecoder('utf-8', { fatal: true }).decode(pending.subarray(0, newline));
            pending = pending.subarray(newline + 1); const event = projectLogLine(line); if (event) append(event);
          }
          if (pending.length > limits.debugLineBytes) reject('debug_limit');
        }
      } finally { await file.close(); }
      if (final && pending.length) reject('remote_unproven');
    },
  };
}
