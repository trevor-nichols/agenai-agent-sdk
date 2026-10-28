import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runSandboxCli } from '../../credentials/index.js';
import { createCredentialFixture } from '../../credentials/tests/fixture.js';
import { reserveSandboxCodex } from '../index.js';

const guestExecutable = '/opt/agenai/native/codex';
const bootstrapExecutable = '/opt/agenai/bin/agenai-credential-bootstrap';
const tokens = { access_token: 'synthetic-access', id_token: 'synthetic-id', refresh_token: 'synthetic-refresh' };

test('explicit ChatGPT snapshot reaches only private auth.json byte-exactly and leaves its selected source unchanged', { timeout: 2000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-native-source-')));
  const path = join(directory, 'caller-selected-cache');
  const original = Buffer.from(` { "auth_mode": "chatgpt", "OPENAI_API_KEY": null, "tokens": ${JSON.stringify(tokens)}, "last_refresh": "2026-10-27T00:00:00Z", "native_extra": "café" }\n`);
  const physical = createCredentialFixture({ bootstrap: true });
  try {
    await writeFile(path, original, { mode: 0o600 });
    const sandbox = await physical.owner.start();
    const launch = await reserveSandboxCodex(sandbox, { guestExecutable,
      credential: { kind: 'auth_json', path, lineage: 'caller_quiescent', bootstrapExecutable, preparationTimeoutMs: 1000 } });
    const spec = physical.specification; assert(spec);
    assert.equal(spec.executable, bootstrapExecutable); assert.equal(spec.args[0], guestExecutable);
    assert.equal(spec.args.length, 73); assert(spec.args.includes('forced_login_method="chatgpt"'));
    assert(spec.args.includes('cli_auth_credentials_store="file"'));
    assert.deepEqual(Object.keys(spec.env).sort(), ['CODEX_HOME', 'HOME', 'LANG', 'LC_ALL', 'PATH', 'TMPDIR']);
    assert.equal(spec.env.CODEX_HOME, '/home/sandbox/.agenai-credentials');
    const result = await runSandboxCli(launch.reservation, { stdin: { kind: 'utf8', text: 'A separate native task prompt.' } });
    assert.deepEqual(physical.credentialFile, { name: 'auth.json', bytes: original });
    assert.deepEqual(await readFile(path), original);
    assert.equal(Buffer.concat(physical.nativeInput).toString(), 'A separate native task prompt.');
    assert.deepEqual(result.receipt, { kind: 'exited', code: 7 }); assert.equal(physical.processCalls, 1);
    assert.deepEqual([...physical.resources], ['storage']);
    const report = JSON.stringify({ preflight: launch.preflight, result });
    for (const excluded of [path, directory, ...Object.values(tokens), 'café']) assert(!report.includes(excluded));
    assert.equal(launch.preflight.nativeDestination, '/home/sandbox/.agenai-credentials/auth.json');
    assert.deepEqual(launch.preflight.httpsDestinations, ['https://chatgpt.com:443', 'https://auth.openai.com:443']);
  } finally { await physical.owner.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test('unsupported cache modes and incomplete native token objects fail without fallback, source modification or content disclosure', { timeout: 2000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-invalid-source-')));
  const path = join(directory, 'caller-selected-cache');
  const physical = createCredentialFixture(); const sandbox = await physical.owner.start();
  try {
    for (const cache of [
      { auth_mode: 'apikey', OPENAI_API_KEY: 'synthetic-secret-api', tokens },
      { auth_mode: 'chatgptAuthTokens', tokens },
      { auth_mode: 'chatgpt', OPENAI_API_KEY: 'synthetic-secret-api', tokens },
      { auth_mode: 'chatgpt', tokens: { ...tokens, refresh_token: '' } },
      { auth_mode: 'chatgpt', tokens: { access_token: tokens.access_token } },
      { auth_mode: 'chatgpt', tokens: { ...tokens, access_token: null } },
    ]) {
      const bytes = Buffer.from(JSON.stringify(cache)); await writeFile(path, bytes, { mode: 0o600 });
      await assert.rejects(reserveSandboxCodex(sandbox, { guestExecutable,
        credential: { kind: 'auth_json', path, lineage: 'caller_quiescent', bootstrapExecutable, preparationTimeoutMs: 1000 } }), (error: unknown) => {
        assert(error instanceof TypeError); assert.equal(error.message, 'Unsupported or malformed selected Codex credential route.');
        assert(!String(error).includes(path)); assert.equal(error.cause, undefined); return true;
      });
      assert.deepEqual(await readFile(path), bytes);
    }
    assert.equal(physical.processCalls, 0); assert.deepEqual([...physical.resources], ['compute', 'storage']);
  } finally { await physical.owner.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test('caller cancellation before or during the selected host read reserves no process and leaves the source unchanged', { timeout: 2000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-cancelled-source-')));
  const path = join(directory, 'caller-selected-cache');
  const original = Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', tokens }));
  const credential = { kind: 'auth_json', path, lineage: 'caller_quiescent', bootstrapExecutable, preparationTimeoutMs: 1000 } as const;
  const physical = createCredentialFixture({ bootstrap: true }); const sandbox = await physical.owner.start();
  try {
    await writeFile(path, original, { mode: 0o600 });
    const before = new AbortController(); before.abort();
    const during = new AbortController();
    const outcomes = [
      reserveSandboxCodex(sandbox, { guestExecutable, credential, signal: before.signal }),
      reserveSandboxCodex(sandbox, { guestExecutable, credential: { kind: 'api_key', value: 'synthetic-selected-key' }, signal: before.signal }),
      reserveSandboxCodex(sandbox, { guestExecutable, credential, signal: during.signal }),
    ].map((attempt) => attempt.then(() => undefined, (error: unknown) => error));
    // The third read has entered its first filesystem await, which cannot settle within this microtask.
    queueMicrotask(() => during.abort());
    const [authBefore, keyBefore, authDuring] = await Promise.all(outcomes);
    assert.equal(authBefore, before.signal.reason); assert.equal(keyBefore, before.signal.reason);
    // The reader keeps an in-flight abort content-free; the caller classifies it through its own signal.
    assert(authDuring instanceof TypeError); assert.equal(authDuring.message, 'Sandbox credential source is unavailable or invalid.');
    assert.equal(during.signal.aborted, true);
    assert.equal(physical.processCalls, 0); assert.deepEqual(await readFile(path), original);
    assert.deepEqual([...physical.resources], ['compute', 'storage']);
  } finally { await physical.owner.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test('source and native-format boundaries reject before reservation without disclosure or source change', { timeout: 2000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-boundary-source-')));
  const valid = Buffer.from(JSON.stringify({ auth_mode: 'chatgpt', tokens }));
  const codexRejection = 'Unsupported or malformed selected Codex credential route.';
  const sourceRejection = 'Sandbox credential source is unavailable or invalid.';
  const file = (bytes: Buffer, mode = 0o600) => async (path: string) => { await writeFile(path, bytes); await chmod(path, mode); return bytes; };
  const rows: readonly { name: string; prepare: (path: string) => Promise<Buffer | undefined>; message: string }[] = [
    { name: 'invalid UTF-8', prepare: file(Buffer.from([0xff, 0xfe, 0x7b])), message: codexRejection },
    { name: 'non-object JSON', prepare: file(Buffer.from('[]')), message: codexRejection },
    { name: 'truncated JSON', prepare: file(valid.subarray(0, -1)), message: codexRejection },
    { name: 'one byte over the frame limit', prepare: file(Buffer.alloc(65_537, 0x20)), message: sourceRejection },
    // Linked sources and ancestors are owned by the sandbox reader tests; Node's permission model forbids creating links here.
    { name: 'group-readable source', prepare: file(valid, 0o640), message: sourceRejection },
    { name: 'directory', prepare: async (path) => { await mkdir(path, { mode: 0o700 }); return undefined; }, message: sourceRejection },
    { name: 'missing source', prepare: async () => undefined, message: sourceRejection },
  ];
  const physical = createCredentialFixture(); const sandbox = await physical.owner.start();
  try {
    for (const [index, row] of rows.entries()) {
      const path = join(directory, `selected-${index}`);
      const written = await row.prepare(path);
      await assert.rejects(reserveSandboxCodex(sandbox, { guestExecutable,
        credential: { kind: 'auth_json', path, lineage: 'caller_quiescent', bootstrapExecutable, preparationTimeoutMs: 1000 } }), (error: unknown) => {
        assert(error instanceof TypeError, row.name); assert.equal(error.message, row.message, row.name);
        assert(!String(error).includes(directory), row.name); return true;
      });
      if (written) assert.deepEqual(await readFile(path), written, row.name);
    }
    assert.equal(physical.processCalls, 0); assert.deepEqual([...physical.resources], ['compute', 'storage']);
  } finally { await physical.owner.destroy(); await rm(directory, { recursive: true, force: true }); }
});
