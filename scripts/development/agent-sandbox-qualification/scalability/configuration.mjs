// ------------------------------------------------------------------------------------------------
//                configuration.mjs - Explicit large-workspace invocation and qualification budgets
// ------------------------------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, normalize } from 'node:path';
import { parseArgs } from 'node:util';

export const usage = `Usage:
  node scripts/development/agent-sandbox-qualification/scalability/run.mjs --engine unix:///absolute/socket --output /new/absolute/run --consumer /absolute/installed/consumer --prepare-source-image sha256:<exact-local-ID> --rss-budget-mib 1024 --external-budget-mib 256 [--retain-source-fixture]
  node scripts/development/agent-sandbox-qualification/scalability/run.mjs --engine unix:///absolute/socket --output /new/absolute/run --consumer /absolute/installed/consumer --image sha256:<exact-trusted-ID> --rss-budget-mib 1024 --external-budget-mib 256

Requires the qualified Linux Engine 29.1.3 / Node 24.18.0 tuple and freshly built
installed @agen-ai/sandbox and sandbox-docker. The source image is already local;
this lane never pulls images, discovers Docker contexts or changes a daemon.
It writes over 12 GiB in 25,001 real dataset files, hashes every byte in producer,
guest and exported sink, and verifies exact SDK resource cleanup. Memory budgets
are selected qualification assertions, never SDK workload limits. Retention keeps
only the generated host source fixture for a separately authorized MS004 run.
`;

export function absolutePath(value) {
  assert(typeof value === 'string' && value.length > 1 && value.length <= 4096 && !/[\0\r\n]/u.test(value)
    && isAbsolute(value) && normalize(value) === value && !value.endsWith('/'), 'Canonical absolute path required.');
  return value;
}

export async function physicalDirectory(value) {
  absolutePath(value);
  const entry = await lstat(value);
  assert(entry.isDirectory() && !entry.isSymbolicLink() && await realpath(value) === value, 'Physical canonical directory required.');
}

export function parseArguments(args) {
  const { values } = parseArgs({ args, options: { engine: { type: 'string' }, output: { type: 'string' }, consumer: { type: 'string' },
    image: { type: 'string' }, 'prepare-source-image': { type: 'string' }, 'rss-budget-mib': { type: 'string', default: '1024' },
    'external-budget-mib': { type: 'string', default: '256' }, 'retain-source-fixture': { type: 'boolean', default: false } } });
  assert(typeof values.engine === 'string' && /^unix:\/\/\/[^\0\r\n?#]+$/u.test(values.engine), 'Explicit Unix Engine required.');
  absolutePath(values.engine.slice(7));
  assert(Boolean(values.image) !== Boolean(values['prepare-source-image']), 'Select exactly one trusted image or preparation source.');
  const image = values.image ?? values['prepare-source-image'];
  assert.match(image, /^sha256:[a-f0-9]{64}$/u, 'Exact local image ID required.');
  const budget = (value) => {
    assert(typeof value === 'string' && /^[1-9][0-9]*$/u.test(value), 'Explicit positive MiB memory budget required.');
    const bytes = Number(value) * 1024 ** 2;
    assert(Number.isSafeInteger(bytes), 'Representable memory budget required.');
    return bytes;
  };
  return { endpoint: values.engine, output: absolutePath(values.output), consumer: absolutePath(values.consumer),
    image, prepare: values.image === undefined, retainSource: values['retain-source-fixture'],
    budgets: { rssBytes: budget(values['rss-budget-mib']), externalBytes: budget(values['external-budget-mib']) } };
}

export function failure(error, depth = 0) {
  return { name: error instanceof Error ? error.name : 'ThrownValue', message: String(error instanceof Error ? error.message : error).slice(0, 8192),
    ...(error && typeof error === 'object' && typeof error.code === 'string' ? { code: error.code } : {}),
    ...(depth < 4 && error && typeof error === 'object' && Object.hasOwn(error, 'primaryError') ? { primaryError: failure(error.primaryError, depth + 1) } : {}),
    ...(depth < 4 && error && typeof error === 'object' && Object.hasOwn(error, 'cleanupError') ? { cleanupError: failure(error.cleanupError, depth + 1) } : {}),
    ...(depth < 4 && error instanceof Error && error.cause !== undefined ? { cause: failure(error.cause, depth + 1) } : {}),
    ...(depth < 4 && error instanceof AggregateError ? { errors: error.errors.slice(0, 16).map((value) => failure(value, depth + 1)) } : {}) };
}
