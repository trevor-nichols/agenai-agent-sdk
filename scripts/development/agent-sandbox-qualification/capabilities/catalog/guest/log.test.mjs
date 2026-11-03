import assert from 'node:assert/strict';
import { appendFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { limits } from '../protocol.mjs';
import { logProjection, projectLogLine } from './log.mjs';

const oai = 'xai_grok_shell::remote::model_source::oai';
const fetch = 'xai_grok_shell::agent::remote_config::fetch';
const endpoint = 'https://cli-chat-proxy.grok.com/v1/models';
const line = (target, message, level = 'INFO') => `2026-11-03T15:00:00.123456Z  ${level} ${target}: ${message}`;

test('native full-format source records project only exact endpoint/count facts and discard ETag/span contents', () => {
  assert.deepEqual(projectLogLine(line(oai, `Fetching models from ${endpoint}`)), { kind: 'http_fetch_started', count: null });
  assert.deepEqual(projectLogLine(line(oai, `Fetched 300 models from ${endpoint}`)), { kind: 'http_fetch_completed', count: 300 });
  assert.deepEqual(projectLogLine(line(fetch, 'Prefetched models count=280 etag=Some("PRIVATE-ETAG")')),
    { kind: 'prefetch_completed', count: 280 });
  const spanned = line(`startup{private="PRIVATE-SPAN: quoted \\\"field\\\""}: ${fetch}`, 'Prefetched models count=280 etag=None');
  assert.deepEqual(projectLogLine(spanned), { kind: 'prefetch_completed', count: 280 });
  const failure = projectLogLine(line(fetch, 'Failed to fetch models error="PRIVATE-HTTP-BODY"', 'WARN'));
  assert.deepEqual(failure, { kind: 'remote_fetch_failed', count: null });
  assert(!JSON.stringify([projectLogLine(spanned), failure]).includes('PRIVATE'));
});

test('quoted success text, wrong source/endpoint, manager messages and unsupported formats cannot prove a refresh', () => {
  for (const text of [
    line(oai, `Fetching models from ${endpoint}`, 'WARN'),
    line('untrusted::source', `${oai}: Fetched 300 models from ${endpoint}`),
    line(oai, `Fetched 300 models from ${endpoint}?alternate=true`),
    line(oai, `Fetched 300 models from ${endpoint}/extra`),
    line(fetch, `request_error="${oai}: Fetched 300 models from ${endpoint}"`),
    JSON.stringify({ level: 'INFO', target: oai, fields: { message: `Fetched 300 models from ${endpoint}` } }),
  ]) assert.equal(projectLogLine(text), null);
  assert.deepEqual(projectLogLine(line(oai, `Failed to fetch models: 403 - ${line(fetch, 'Prefetched models count=2 etag=None')}`, 'WARN')),
    { kind: 'remote_fetch_failed', count: null });
});

test('incremental private log reader requires ordered HTTP/prefetch and rejects a failure through final catalog drain', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'catalog-log-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'debug.log'); const projection = logProjection(file);
  await writeFile(file, line(oai, `Fetching models from ${endpoint}`), { mode: 0o600 });
  await projection.poll(); assert.deepEqual(projection.events, []); assert.equal(projection.confirmed(), false);
  await appendFile(file, '\n' + line(oai, `Fetched 300 models from ${endpoint}`) + '\n' + line(fetch, 'Prefetched models count=280 etag=None') + '\n');
  await projection.poll(); assert.equal(projection.confirmed(), true);
  projection.append({ kind: 'catalog_requested', count: null });
  await appendFile(file, line(fetch, 'Failed to fetch models error="PRIVATE-LATE-BODY"', 'WARN') + '\n');
  await projection.poll(true); projection.append({ kind: 'catalog_observed', count: null });
  assert.equal(projection.confirmed(), false);
  assert.deepEqual(projection.events.map(({ kind }) => kind),
    ['http_fetch_started', 'http_fetch_completed', 'prefetch_completed', 'catalog_requested', 'remote_fetch_failed', 'catalog_observed']);
});

test('debug and projected-event limits fail without turning truncated evidence into success', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'catalog-log-bound-'))); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'debug.log');
  await writeFile(file, Buffer.alloc(limits.debugBytes + 1, 120), { mode: 0o600 });
  await assert.rejects(logProjection(file).poll(), { code: 'debug_limit' });
  await writeFile(file, (line(oai, `Fetching models from ${endpoint}`) + '\n').repeat(65));
  const projection = logProjection(file);
  await assert.rejects(projection.poll(), { code: 'projection_limit' });
  assert.equal(projection.events.length, 64); assert.equal(projection.confirmed(), false);
});
