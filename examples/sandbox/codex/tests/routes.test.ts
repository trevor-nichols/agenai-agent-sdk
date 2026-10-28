import assert from 'node:assert/strict';
import test from 'node:test';
import { runSandboxCli } from '../../credentials/index.js';
import { createCredentialFixture } from '../../credentials/tests/fixture.js';
import { reserveSandboxCodex } from '../index.js';

const guestExecutable = '/opt/agenai/native/codex';

test('Codex selected key reaches only its native environment and fixed exec route', { timeout: 2000 }, async () => {
  const physical = createCredentialFixture(); const sandbox = await physical.owner.start();
  const value = ' synthetic-codex-key-with-preserved-spaces ';
  const credential = { kind: 'api_key' as const, value };
  try {
    const launch = await reserveSandboxCodex(sandbox, { guestExecutable, credential });
    credential.value = 'mutated-after-capture';
    const spec = physical.specification; assert(spec);
    assert.deepEqual(spec.env, {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/home/sandbox', TMPDIR: '/tmp',
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', CODEX_HOME: '/home/sandbox', CODEX_API_KEY: value,
    });
    assert.equal(spec.executable, guestExecutable); assert.equal(spec.cwd, '/workspace/work');
    assert.equal(spec.args.length, 72);
    assert.deepEqual(spec.args.slice(0, 3), ['--no-daemon', '--ask-for-approval', 'never']);
    assert.deepEqual(spec.args.slice(-13), ['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--json',
      '--color', 'never', '--skip-git-repo-check', '--sandbox', 'danger-full-access', '--model', 'gpt-6-luna', '-']);
    assert(spec.args.includes('forced_login_method="api"')); assert(spec.args.includes('cli_auth_credentials_store="ephemeral"'));
    assert(spec.args.includes('mcp_servers={}')); assert(spec.args.includes('project_doc_max_bytes=0'));
    assert(!JSON.stringify(spec.args).includes(value));
    assert.deepEqual(launch.preflight, {
      provider: 'codex', version: '0.163.0', transport: 'native_cli_exec', credentialRoute: 'api_key',
      sourceKind: 'explicit_api_key', nativeDestination: 'CODEX_API_KEY', model: 'gpt-6-luna', reasoning: 'low',
      httpsDestinations: ['https://api.openai.com:443'], endpointEvidence: 'observed_in_ms005_native_campaign',
      nativeQualification: 'recorded_linux_x64_and_desktop_native_arm64', preparation: 'caller_must_verify_image_binary_platform_and_empty_configuration',
    });
    const result = await runSandboxCli(launch.reservation, { stdin: { kind: 'utf8', text: 'Perform the controlled local fixture task.' } });
    assert.deepEqual(result.receipt, { kind: 'exited', code: 7 });
    assert.equal(Buffer.concat(physical.nativeInput).toString(), 'Perform the controlled local fixture task.');
    assert.equal(physical.processCalls, 1); assert.equal(physical.stopAttempts, 1);
    assert.deepEqual([...physical.resources], ['storage']);
    assert(!JSON.stringify({ preflight: launch.preflight, result }).includes(value));
    assert(!JSON.stringify(result).includes('synthetic-sensitive-diagnostic'));
  } finally { await physical.owner.destroy(); }
});

test('Codex rejects unsupported or competing credential routes before reserving a process', { timeout: 2000 }, async () => {
  const physical = createCredentialFixture(); const sandbox = await physical.owner.start();
  const secret = 'never-report-this-synthetic-secret'; let accessors = 0;
  const key = { kind: 'api_key', value: secret };
  const malformed = [
    { guestExecutable },
    { guestExecutable, credential: key, signal: { aborted: false } },
    { guestExecutable, credential: { ...key, path: '/private/host/auth.json' } },
    { guestExecutable, credential: { kind: 'oauth_token', value: secret } },
    ...['', `${secret}\n`, '\ud800', 'é'.repeat(4096) + 'a'].map((value) => ({ guestExecutable, credential: { kind: 'api_key', value } })),
    { guestExecutable, credential: key, env: { OPENAI_API_KEY: secret } },
    { guestExecutable, credential: key, args: ['--profile', 'host'] },
    { guestExecutable, credential: { kind: 'auth_json', path: '/private/host/auth.json', lineage: 'concurrent',
      bootstrapExecutable: '/opt/agenai/credentials', preparationTimeoutMs: 1000 } },
    { guestExecutable, credential: Object.defineProperty({ kind: 'api_key' }, 'value', {
      enumerable: true, get() { accessors++; return secret; },
    }) },
    { guestExecutable, credential: new Proxy({}, { ownKeys() { throw new Error(secret); } }) },
  ];
  try {
    for (const input of malformed) {
      await assert.rejects(Reflect.apply(reserveSandboxCodex, undefined, [sandbox, input]), (error: unknown) => {
        assert(error instanceof TypeError); assert(!String(error).includes(secret)); assert(!String(error).includes('/private/host')); return true;
      });
    }
    assert.equal(accessors, 0); assert.equal(physical.processCalls, 0);
    assert.deepEqual([...physical.resources], ['compute', 'storage']);
  } finally { await physical.owner.destroy(); }
});
