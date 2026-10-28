import assert from 'node:assert/strict';
import test from 'node:test';
import { reserveSandboxGrok } from '../../grok/launch.js';
import { reserveSandboxOpenCode } from '../../opencode/index.js';
import { reserveSandboxCursor } from '../../cursor/index.js';
import { reserveSandboxCodex } from '../../codex/index.js';
import { createCredentialFixture } from './fixture.js';
import type { Sandbox } from '@agen-ai/sandbox';

const value = 'synthetic-selected-key-no-account';
const credential = { kind: 'api_key' as const, value };
const task = 'Write the supplied known file.';
const openCodeOptions = ['run', '--standalone', '--format', 'json', '--model', 'anthropic/claude-haiku-4-5-20251001', '--agent', 'build', '--auto'];
const cursorOptions = ['agent', '--disable-auto-update', '--disable-project-configs', '--print', '--force', '--trust',
  '--output-format', 'stream-json', '--model', 'caller-selected-model'];
const recipes = [
  { name: 'Grok stable ACP', destination: 'XAI_API_KEY', executable: '/bin/sh',
    args: ['/opt/agenai/examples/grok/launch-grok.sh'],
    call: (sandbox: Sandbox, extra = {}) => reserveSandboxGrok(sandbox, { credential, guestExecutable: '/opt/agenai/native/grok', ...extra }) },
  { name: 'OpenCode V2 native JSON', destination: 'ANTHROPIC_API_KEY', executable: '/opt/agenai/native/opencode',
    args: [...openCodeOptions, '--', task],
    call: (sandbox: Sandbox, extra = {}) => reserveSandboxOpenCode(sandbox, { credential, guestExecutable: '/opt/agenai/native/opencode', task, ...extra }) },
  { name: 'Cursor user-key native stream', destination: 'CURSOR_API_KEY', executable: '/opt/agenai/native/cursor-agent',
    args: [...cursorOptions, '--', task],
    call: (sandbox: Sandbox, extra = {}) => reserveSandboxCursor(sandbox, { credential, guestExecutable: '/opt/agenai/native/cursor-agent', model: 'caller-selected-model', task, ...extra }) },
];

for (const recipe of recipes) {
  test(`${recipe.name} selects only its supplied native destination and excludes ambient overrides`, async (t) => {
    const fixture = createCredentialFixture();
    t.after(() => fixture.owner.destroy());
    const sandbox = await fixture.owner.start();
    const ambient = { XAI_API_KEY: 'ambient-xai', ANTHROPIC_API_KEY: 'ambient-anthropic', CURSOR_API_KEY: 'ambient-cursor',
      CURSOR_AUTH_TOKEN: 'ambient-token', GROK_XAI_API_BASE_URL: 'https://unselected.invalid', OPENCODE_CONFIG_CONTENT: '{"auth":"ambient"}' };
    const priorEnvironment = process.env;
    process.env = { ...ambient };
    t.after(() => { process.env = priorEnvironment; });
    const { reservation, preflight } = recipe.call(sandbox);
    assert.equal(fixture.processCalls, 1);
    assert.deepEqual({ executable: fixture.specification?.executable, args: fixture.specification?.args, cwd: fixture.specification?.cwd },
      { executable: recipe.executable, args: recipe.args, cwd: '/workspace/work' });
    const env = fixture.specification?.env;
    assert.ok(env);
    assert.equal(env[recipe.destination], value);
    assert.deepEqual(Object.entries(env).filter(([, entry]) => entry === value).map(([name]) => name), [recipe.destination]);
    for (const [name, ambientValue] of Object.entries(ambient)) assert.notEqual(env[name], ambientValue);
    assert.equal(env.HOME, '/home/sandbox');
    assert.equal(env.XDG_CONFIG_HOME, '/home/sandbox/config');
    assert.equal(env.HTTPS_PROXY, undefined); // An isolated sandbox gets no relay variables.
    assert.equal(preflight.nativeDestination, recipe.destination);
    assert.equal(preflight.nativeQualification, 'recorded_linux_x64_and_desktop_native_arm64');
    assert.equal(preflight.preparation, 'caller_must_verify_image_binary_platform_and_empty_configuration');
    assert(!JSON.stringify({ preflight, args: fixture.specification?.args }).includes(value));
    await reservation.stop();
    assert.deepEqual([...fixture.resources], ['storage']);
  });

  test(`${recipe.name} rejects extra auth/environment/endpoint routes before process reservation`, async (t) => {
    const fixture = createCredentialFixture();
    t.after(() => fixture.owner.destroy());
    const sandbox = await fixture.owner.start();
    for (const extra of [{ env: { [recipe.destination]: 'other' } }, { authToken: 'unselected' },
      { endpoint: 'https://unselected.invalid' }, { credential: { kind: 'saved_login', value } },
      { guestExecutable: '/opt/agenai/native/another-version' }]) {
      assert.throws(() => recipe.call(sandbox, extra), (error: unknown) => error instanceof TypeError && !String(error).includes(value));
    }
    assert.equal(fixture.processCalls, 0);
    await sandbox.stop();
  });
}

const codexKey = (sandbox: Sandbox) => reserveSandboxCodex(sandbox, { guestExecutable: '/opt/agenai/native/codex', credential });
const egressRecipes = [...recipes, { name: 'Codex CLI key', destination: 'CODEX_API_KEY', call: codexKey }];

function admitted(declared: readonly string[]) {
  const pairs = new Map(declared.map((url) => new URL(url)).map((url) => [`${url.hostname}:${url.port || '443'}`,
    { hostname: url.hostname, port: Number(url.port || '443') }]));
  return [...pairs.values()];
}

for (const recipe of egressRecipes) {
  test(`${recipe.name} points its native at the restricted HTTPS relay only when every declared destination is admitted`, async (t) => {
    const probe = createCredentialFixture();
    t.after(() => probe.owner.destroy());
    const declared = (await recipe.call(await probe.owner.start())).preflight.httpsDestinations;
    const destinations = admitted(declared);
    const restricted = createCredentialFixture({ network: { kind: 'restricted_https', destinations } });
    t.after(() => restricted.owner.destroy());
    const { reservation } = await recipe.call(await restricted.owner.start());
    const env = restricted.specification?.env;
    assert.ok(env);
    assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:3128'); assert.equal(env.https_proxy, 'http://127.0.0.1:3128');
    assert.equal(env.NO_PROXY, '127.0.0.1,localhost');
    assert.deepEqual(Object.entries(env).filter(([, entry]) => entry === value).map(([name]) => name), [recipe.destination]);
    await reservation.stop();
    const narrowed = createCredentialFixture({ network: { kind: 'restricted_https',
      destinations: [{ hostname: 'unrelated.example.com', port: 443 }, ...destinations.slice(1)] } });
    t.after(() => narrowed.owner.destroy());
    const sandbox = await narrowed.owner.start();
    await assert.rejects(async () => recipe.call(sandbox), (error: unknown) => error instanceof TypeError
      && error.message === 'The sandbox restricted HTTPS policy does not admit every destination this recipe declares.');
    assert.equal(narrowed.processCalls, 0);
  });
}

test('Grok, OpenCode and Cursor reject a missing or empty credential selection before process reservation', async (t) => {
  const fixture = createCredentialFixture();
  t.after(() => fixture.owner.destroy());
  const sandbox = await fixture.owner.start();
  const inputs = [
    [reserveSandboxGrok, { guestExecutable: '/opt/agenai/native/grok' }],
    [reserveSandboxOpenCode, { guestExecutable: '/opt/agenai/native/opencode', task }],
    [reserveSandboxCursor, { guestExecutable: '/opt/agenai/native/cursor-agent', model: 'caller-selected-model', task }],
  ] as const;
  for (const [reserve, input] of inputs) {
    for (const credential of [undefined, null, {}, { kind: 'api_key' }]) {
      const selection = credential === undefined ? input : { ...input, credential };
      assert.throws(() => Reflect.apply(reserve, undefined, [sandbox, selection]), TypeError);
    }
  }
  assert.equal(fixture.processCalls, 0);
  await sandbox.stop();
});

test('OpenCode and Cursor pass option- and command-shaped tasks only as the operand after end-of-options', async (t) => {
  // Each pinned parser treats everything after the first `--` as prompt text (Effect CLI and Commander respectively).
  const shapedTasks = ['--help', '--model=auto', '--server=https://unselected.invalid', '-m', 'login', 'help', '--'];
  for (const [reserve, options] of [
    [(sandbox: Sandbox, shaped: string) => reserveSandboxOpenCode(sandbox, { credential, guestExecutable: '/opt/agenai/native/opencode', task: shaped }), openCodeOptions],
    [(sandbox: Sandbox, shaped: string) => reserveSandboxCursor(sandbox, { credential, guestExecutable: '/opt/agenai/native/cursor-agent', model: 'caller-selected-model', task: shaped }), cursorOptions],
  ] as const) {
    for (const shaped of shapedTasks) {
      const fixture = createCredentialFixture();
      t.after(() => fixture.owner.destroy());
      const { reservation } = reserve(await fixture.owner.start(), shaped);
      assert.deepEqual(fixture.specification?.args, [...options, '--', shaped]);
      await reservation.stop();
    }
  }
});

test('OpenCode fixes Anthropic config without embedded auth and Cursor rejects automatic or unbounded models', async (t) => {
  const fixture = createCredentialFixture();
  t.after(() => fixture.owner.destroy());
  const sandbox = await fixture.owner.start();
  const { reservation } = reserveSandboxOpenCode(sandbox, { credential, guestExecutable: '/opt/agenai/native/opencode', task });
  const env = fixture.specification?.env;
  assert.ok(env);
  assert.equal(env.OPENCODE_DB, '/home/sandbox/data/opencode/opencode.db');
  assert.equal(env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
  assert.equal(env.OPENCODE_DISABLE_MODELS_FETCH, '1');
  assert.equal(env.OPENCODE_DISABLE_FREE_MODELS, '1');
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? 'null');
  assert.deepEqual(config.providers, { anthropic: { settings: { baseURL: 'https://api.anthropic.com/v1' } } });
  assert.deepEqual(config.plugins, ['-opencode.browser']);
  assert(!JSON.stringify(config).includes(value));
  await reservation.stop();
  const cursorFixture = createCredentialFixture();
  t.after(() => cursorFixture.owner.destroy());
  const cursor = await cursorFixture.owner.start();
  for (const model of ['', 'auto', 'AUTO', ' leading', 'x'.repeat(129), '--model', 'x\0y']) {
    assert.throws(() => reserveSandboxCursor(cursor, { credential, guestExecutable: '/opt/agenai/native/cursor-agent', task, model }), TypeError);
  }
  const selected = reserveSandboxCursor(cursor, { credential, guestExecutable: '/opt/agenai/native/cursor-agent', task, model: 'model-allowed' });
  assert.equal(cursorFixture.specification?.env.AGENT_CLI_CREDENTIAL_STORE, 'memory');
  assert.equal(cursorFixture.specification?.env.CURSOR_API_ENDPOINT, 'https://api2.cursor.sh');
  assert.equal(selected.preflight.endpointSetSufficiency, 'observed_for_cli_tasks_excluding_account_mcp');
  await selected.reservation.stop();
});

