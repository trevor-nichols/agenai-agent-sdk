import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, lstat, mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAgentInstanceId } from '@agen-ai/agent-protocol';
import { prepareGrokDockerApprovalProfile } from '../src/docker/index.js';
import type { GrokDockerApprovalPolicy } from '../src/index.js';

const uuid = 'f130c821-bded-4338-babc-fc1100edbc56';
const bootstrap = { sha256: 'a'.repeat(64) };
const baseImageDigest = `sha256:${'b'.repeat(64)}`;

test('offline native Bash denials preserve supplied patterns as deny-only TOML and immutable profile identity', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agenai-grok-denials-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const deniedBashPatterns = ['git reset --hard*', 'printf "literal" C:\\owned\\*', '  preserve spaces  ', 'echo café-😀'];
  const selected = { instanceId: parseAgentInstanceId('grok:denials'), nativeSessionId: uuid,
    policy: 'provider_bypass' as const, credentialBootstrap: bootstrap, deniedBashPatterns };
  const result = await prepareGrokDockerApprovalProfile({ directory: join(scratch, 'context'), dockerProfile: 'linux-x64', baseImageDigest, profile: selected });
  const config = await readFile(join(result.directory, 'rootfs/opt/agenai/grok-home/config.toml'), 'utf8');
  assert.equal(config.slice(config.indexOf('[[permission.rules]]')), String.raw`[[permission.rules]]
action = "deny"
tool = "bash"
pattern = "git reset --hard*"
[[permission.rules]]
action = "deny"
tool = "bash"
pattern = "printf \"literal\" C:\\owned\\*"
[[permission.rules]]
action = "deny"
tool = "bash"
pattern = "  preserve spaces  "
[[permission.rules]]
action = "deny"
tool = "bash"
pattern = "echo café-😀"
`);
  const identity = JSON.parse(await readFile(join(result.directory, 'rootfs/opt/agenai/profile.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(identity.deniedBashPatterns, ['git reset --hard*', 'printf "literal" C:\\owned\\*', '  preserve spaces  ', 'echo café-😀']);
  assert.deepEqual(result.profile.deniedBashPatterns, ['git reset --hard*', 'printf "literal" C:\\owned\\*', '  preserve spaces  ', 'echo café-😀']);
  assert.equal(Reflect.set(result.profile.deniedBashPatterns ?? [], 0, 'mutated'), false);
  assert.equal(result.files.find((file) => file.path === 'rootfs/opt/agenai/grok-home/config.toml')?.sha256,
    createHash('sha256').update(config).digest('hex'));
});

test('offline preparation emits each fixed policy with a fresh image configuration and SDK-owned bootstrap sources', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agenai-grok-preparation-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const modes: readonly [GrokDockerApprovalPolicy, string, string][] = [
    ['host', 'default', '--permission-mode default agent --no-leader'],
    ['provider_auto_review', 'auto', '--permission-mode auto agent --no-leader'],
    ['provider_bypass', 'bypassPermissions', 'agent --always-approve --no-leader'],
  ];
  for (const [policy, permissionMode, argv] of modes) {
    const directory = join(scratch, policy);
    const result = await prepareGrokDockerApprovalProfile({ directory, dockerProfile: 'linux-x64', baseImageDigest,
      profile: { instanceId: parseAgentInstanceId('grok:test'), nativeSessionId: uuid, policy, credentialBootstrap: bootstrap } });
    const dockerfile = await readFile(join(directory, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /^FROM --platform=linux\/amd64 sha256:b{64} AS base\nFROM scratch\nCOPY --from=base \/ \/\n/u);
    assert.match(dockerfile, /COPY --chown=0:0 --chmod=0111 grok \/opt\/agenai\/bin\/grok/u);
    assert.match(dockerfile, new RegExp(`ln -s /home/sandbox/session /opt/agenai/grok-home/sessions/%2Fworkspace%2Fwork/${uuid}`, 'u'));
    const launcher = await readFile(join(directory, 'rootfs/opt/agenai/bin/launch-grok'), 'utf8');
    assert(launcher.includes(`/opt/agenai/bin/grok ${argv} --agent-profile /opt/agenai/grok-home/agenai-shell.md --model grok-4.6`));
    assert(launcher.includes('case "$(cat /proc/sys/fs/suid_dumpable)" in 0|2)'));
    assert(launcher.includes('exec /usr/bin/env -i HOME=/opt/agenai/home GROK_HOME=/opt/agenai/grok-home'));
    assert(launcher.includes('GROK_MANAGED_CONFIG=0'));
    const launchCommand = launcher.split('\n').find((line) => line.startsWith('exec /usr/bin/env -i '));
    assert(launchCommand);
    const nativeOffset = launchCommand.indexOf(' /opt/agenai/bin/grok ');
    assert(nativeOffset > 0);
    const observedEnvironment = Object.fromEntries(execFileSync('/bin/sh',
      ['-c', `${launchCommand.slice(0, nativeOffset)} /usr/bin/env`],
      { encoding: 'utf8', env: { HTTPS_PROXY: 'http://ambient.invalid:8080', https_proxy: 'http://ambient.invalid:8081',
        ALL_PROXY: 'http://ambient.invalid:8082', HOME: '/ambient-home' } })
      .trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    assert.deepEqual(Object.fromEntries(['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy', 'NO_PROXY', 'no_proxy', 'HOME', 'ALL_PROXY']
      .map((key) => [key, observedEnvironment[key]])), {
      HTTPS_PROXY: 'http://127.0.0.1:3128', HTTP_PROXY: 'http://127.0.0.1:3128',
      https_proxy: 'http://127.0.0.1:3128', http_proxy: 'http://127.0.0.1:3128',
      NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HOME: '/opt/agenai/home', ALL_PROXY: undefined,
    });
    const profile = await readFile(join(directory, 'rootfs/opt/agenai/grok-home/agenai-shell.md'), 'utf8');
    assert(profile.includes(`permissionMode: ${permissionMode}\n`));
    assert(profile.includes('tools: [Bash]\ndisallowedTools: [search_tool, use_tool, Agent]\n'));
    assert.equal(await readFile(join(directory, 'rootfs/opt/agenai/grok-home/requirements.toml'), 'utf8'),
      'allow_managed_hooks_only = true\nallowed_mcp_servers = []\nenable_all_project_mcp_servers = false\nplugin_auto_update = false\n[features]\nremote_fetch = false\nmanaged_config = false\n[managed_mcps]\nenabled = false\n[auto_mode]\nenabled = true\nprompt_type = "full"\nclassifier_model = "grok-4.6"\nreasoning_effort = "low"\nclassify_timeout_ms = 60000\n');
    assert.equal(await readFile(join(directory, 'rootfs/opt/agenai/grok-home/sessions/%2Fworkspace%2Fwork/permission_agenai-sdk-grok.toml'), 'utf8'),
      'allowed_bash_commands = []\nallowed_bash_globs = []\nallowed_mcp_servers = []\nvalidated_mcp_server_grants_version = 1\n');
    assert.equal(result.mapping, 'grok-build-1.0.77-controlled-shell-v1');
    const identity = JSON.parse(await readFile(join(directory, 'rootfs/opt/agenai/profile.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(Object.hasOwn(identity, 'deniedBashPatterns'), false);
    assert.equal(result.native.sha256, 'b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a');
    assert.equal(result.native.size, 201655392);
    const source = await readFile(join(directory, 'credential-bootstrap-sources/bootstrap.c'));
    assert.equal(result.credentialBootstrapSources.files.find((file) => file.path === 'bootstrap.c')?.sha256,
      createHash('sha256').update(source).digest('hex'));
    assert.equal((await lstat(directory)).mode & 0o777, 0o700);
    await assert.rejects(prepareGrokDockerApprovalProfile({ directory, dockerProfile: 'linux-x64', baseImageDigest, profile: result.profile }), { code: 'EEXIST' });
  }
});

test('preparation captures identity before asynchronous filesystem work and refuses accessor or undefined inputs', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agenai-grok-capture-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const profile = { instanceId: parseAgentInstanceId('original'), nativeSessionId: uuid,
    policy: 'host' as const, credentialBootstrap: { sha256: bootstrap.sha256 }, deniedBashPatterns: ['git reset --hard*'] };
  const options = { directory: join(scratch, 'captured'), dockerProfile: 'desktop-apple-virtualization-native-arm64' as const, baseImageDigest, profile };
  const pending = prepareGrokDockerApprovalProfile(options);
  profile.nativeSessionId = '00000000-0000-4000-8000-000000000000';
  profile.credentialBootstrap.sha256 = 'c'.repeat(64);
  profile.deniedBashPatterns[0] = 'mutated';
  profile.deniedBashPatterns.push('*');
  const result = await pending;
  assert.equal(result.profile.nativeSessionId, uuid);
  assert.equal(result.profile.credentialBootstrap.sha256, 'a'.repeat(64));
  assert.deepEqual(result.profile.deniedBashPatterns, ['git reset --hard*']);
  const config = await readFile(join(result.directory, 'rootfs/opt/agenai/grok-home/config.toml'), 'utf8');
  assert.equal(config.slice(config.indexOf('[[permission.rules]]')),
    '[[permission.rules]]\naction = "deny"\ntool = "bash"\npattern = "git reset --hard*"\n');
  assert.equal(result.native.sha256, 'b30eee14a656124ef3c9da8577b5e783ef2cffabeb2b679c5c49633e77eed574');
  assert.equal(result.native.size, 171935112);
  let reads = 0;
  await assert.rejects(prepareGrokDockerApprovalProfile({ ...options, get profile() { reads += 1; return profile; } }), /Invalid controlled Grok Docker input/u);
  assert.equal(reads, 0);
  await assert.rejects(prepareGrokDockerApprovalProfile(Object.assign({}, options, { unrecognized: undefined })), /Invalid controlled Grok Docker input/u);
  await symlink(scratch, join(scratch, 'link'));
  await assert.rejects(prepareGrokDockerApprovalProfile({ ...options, directory: join(scratch, 'link', 'context') }), /Invalid controlled Grok Docker input/u);
});

test('native Bash denial bounds and plain array capture reject before creating a context', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agenai-grok-denial-bounds-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const selected = { instanceId: parseAgentInstanceId('grok:denial-bounds'), nativeSessionId: uuid,
    policy: 'host' as const, credentialBootstrap: bootstrap };
  const accepted = [[], Array.from({ length: 32 }, () => 'git reset --hard*'), ['é'.repeat(2048)], Array.from({ length: 4 }, () => 'a'.repeat(4096))];
  for (const [index, deniedBashPatterns] of accepted.entries()) {
    const result = await prepareGrokDockerApprovalProfile({ directory: join(scratch, `valid-${index}`), dockerProfile: 'linux-x64',
      baseImageDigest, profile: { ...selected, deniedBashPatterns } });
    assert.deepEqual(result.profile.deniedBashPatterns, deniedBashPatterns);
  }
  let reads = 0;
  const accessor = Object.defineProperty(['unused'], '0', { enumerable: true, get() { reads += 1; return '*'; } });
  const customPrototype = ['echo']; Object.setPrototypeOf(customPrototype, Object.create(Array.prototype));
  const invalid: readonly unknown[] = [undefined, null, 'git *', [17], [''], ['line\nbreak'], ['\ud800'],
    Array.from({ length: 33 }, () => 'echo'), ['é'.repeat(2049)], [...Array.from({ length: 4 }, () => 'a'.repeat(4096)), 'x'],
    new Array(1), Object.assign(['echo'], { extra: true }), accessor, customPrototype];
  for (const [index, deniedBashPatterns] of invalid.entries()) {
    const directory = join(scratch, `invalid-${index}`);
    await assert.rejects(prepareGrokDockerApprovalProfile({ directory, dockerProfile: 'linux-x64', baseImageDigest,
      profile: { ...selected, deniedBashPatterns: deniedBashPatterns as never } }), { name: 'TypeError', message: 'Invalid controlled Grok Docker input.' });
    await assert.rejects(access(directory), { code: 'ENOENT' });
  }
  assert.equal(reads, 0);
});

test('returned native identity cannot change the fixed expectations of a later preparation', async (t) => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'agenai-grok-native-identity-')));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const options = { dockerProfile: 'linux-x64' as const, baseImageDigest,
    profile: { instanceId: parseAgentInstanceId('immutable-native'), nativeSessionId: uuid,
      policy: 'host' as const, credentialBootstrap: bootstrap } };
  const first = await prepareGrokDockerApprovalProfile({ ...options, directory: join(scratch, 'first') });
  const changedHash = Reflect.set(first.native, 'sha256', '0'.repeat(64));
  const changedSize = Reflect.set(first.native, 'size', 1);
  const second = await prepareGrokDockerApprovalProfile({ ...options, directory: join(scratch, 'second') });
  assert.deepEqual({ changedHash, changedSize, native: second.native }, {
    changedHash: false, changedSize: false,
    native: { sha256: 'b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a', size: 201655392 },
  });
  const instructions = await readFile(join(second.directory, 'BUILDING.md'), 'utf8');
  assert(instructions.includes('201655392 bytes, SHA-256 b702950aa5827d855e493278ab6215a4e0f5bceb5bba6c6243a9f55cdd143b0a.'));
});
