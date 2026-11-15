import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseAgentInstanceId } from '@agen-ai/agent-protocol';
import { SANDBOX_DEFAULT_STREAM_LIMITS, SANDBOX_DEFAULT_TRANSFER_BUFFERS } from '@agen-ai/sandbox';
import { createDockerLinuxRouteAuthority, DockerImageInspectionError } from '@agen-ai/sandbox-docker/node';
import { prepareGrokDockerProvider } from '../src/docker/index.js';
import type { GrokDockerProviderOptions } from '../src/docker/index.js';

const scope = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const secret = 'synthetic-grok-access-for-local-unit-test';
const account = { key: secret, auth_mode: 'oidc', user_id: 'synthetic-personal-user', create_time: '2026-01-01T00:00:00Z',
  expires_at: '2100-01-01T00:00:00Z', oidc_issuer: 'https://auth.x.ai', oidc_client_id: 'b1a00492-073a-47ea-816f-4c329264a828' };

function options(endpoint: string, credential: unknown): GrokDockerProviderOptions {
  const helper = { resources: { cpus: 0.1, memoryBytes: 64 * 1024 ** 2, pids: 16 }, temporaryBytes: 1024 ** 2 };
  return { profile: { instanceId: parseAgentInstanceId('unit-grok'), nativeSessionId: 'ec7c7d1d-8249-425d-8de4-864041703599',
    policy: 'provider_auto_review', credentialBootstrap: { sha256: 'a'.repeat(64) } },
  backend: { profile: 'linux-x64', endpoint, imageDigest: `sha256:${'b'.repeat(64)}`, namespace: 'unit-grok',
    spillDirectory: '/tmp/agenai-grok-unit-spill', user: { uid: 1000, gid: 1000 }, egress: {
      imageDigest: `sha256:${'c'.repeat(64)}`, protocol: 'agenai.sandbox.egress-connect.v1', user: { uid: 1000, gid: 1000 },
      broker: helper, relay: helper, control: { heartbeatMs: 100, leaseTimeoutMs: 10000 },
      routeAuthority: createDockerLinuxRouteAuthority({ kind: 'local_linux_same_host', stability: 'caller_owned_quiescence',
        ipExecutable: { path: '/not-executed/ip', sha256: 'd'.repeat(64) }, pollIntervalMs: 100,
        commandTimeoutMs: 1000, maxOutputBytes: 65536 }),
    } },
  workload: { resources: { cpus: 1, memoryBytes: 2 * 1024 ** 3, pids: 128 },
    temporaryStorage: { homeBytes: 64 * 1024 ** 2, tempBytes: 64 * 1024 ** 2 },
    execution: { kind: 'deadline', timeoutMs: 60000 }, deadlines: { startupMs: 10000, cleanupMs: 10000 },
    transfers: SANDBOX_DEFAULT_TRANSFER_BUFFERS, streams: SANDBOX_DEFAULT_STREAM_LIMITS },
  credential: { kind: 'auth_json', bytes: Buffer.from(JSON.stringify(credential)) }, recovery: { kind: 'in_process' } };
}

test('personal identities admit only matching billing context and invalid accounts or controls reject before Engine requests', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'agenai-grok-input-'));
  const socket = join(directory, 'engine.sock');
  const requests: string[] = [];
  const server = createServer((request, response) => { requests.push(request.url ?? ''); response.writeHead(500); response.end(); });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  t.after(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });
  for (const credential of [
    {}, { wrong_scope: account }, { [scope]: { ...account, auth_mode: 'api_key' } },
    { [scope]: { ...account, expires_at: '2020-01-01T00:00:00Z' } },
    { [scope]: { ...account, principal_type: 'Team', principal_id: 'team-principal' } },
    { [scope]: { ...account, team_id: 'nonempty-team' } },
    ...[
      { principal_type: 'Team', principal_id: account.user_id, team_id: 'billing-team' },
      { principal_type: 'Organization', principal_id: account.user_id, team_id: 'billing-team' },
      { principal_type: 'Personal', principal_id: account.user_id, team_id: 'billing-team' },
      { principal_type: 'User', team_id: 'billing-team' },
      { principal_type: 'User', principal_id: 'another-user', team_id: 'billing-team' },
      ...[0, false, {}, [], ' ', ' padded ', 'line\nbreak', 'a'.repeat(4097)].map((team_id) => ({ principal_type: 'User', principal_id: account.user_id, team_id })),
      { principal_type: 'User', principal_id: account.user_id, team_id: 'billing-team', organization_id: 'organization' },
      { principal_type: 'User', principal_id: account.user_id, team_id: 'billing-team', deployment_id: 'deployment' },
      { principal_type: 'User', principal_id: account.user_id, team_id: 'billing-team', team_role: 'admin' },
      { principal_type: 'User', principal_id: account.user_id, team_id: 'billing-team', oidc_issuer: 'https://other.invalid' },
      { principal_type: 'User', principal_id: account.user_id, team_id: 'billing-team', oidc_client_id: 'other-client' },
      { principal_type: 'User', principal_id: account.user_id, team_id: 'billing-team', expires_at: '2020-01-01T00:00:00Z' },
    ].map((identity) => ({ [scope]: { ...account, ...identity } })),
    { [scope]: { ...account, organization_id: 'nonempty-organization' } },
    { [scope]: { ...account, deployment_id: 'nonempty-deployment' } },
    { [scope]: { ...account, key: '' } }, { [scope]: account, extra_scope: account },
    ...[0, false, {}, [], '', ' ', ' padded ', 'line\nbreak', '\ud800', 'a'.repeat(4097), '界'.repeat(1366)]
      .map((coding_data_team) => ({ [scope]: { ...account, coding_data_team } })),
    ...['team_zero_data_retention', 'coding_data_retention_opt_out'].flatMap((key) =>
      [null, 'true', 0, {}, []].map((value) => ({ [scope]: { ...account, [key]: value } }))),
    ...[null, {}, 'NO_LOGS', [null], [1], [''], ['line\nbreak'], ['a'.repeat(4097)], ['界'.repeat(1366)], Array(33).fill('reason')]
      .map((team_blocked_reasons) => ({ [scope]: { ...account, team_blocked_reasons } })),
    { [scope]: { ...account, unknown_native_field: true } },
  ]) {
    await assert.rejects(prepareGrokDockerProvider(options(`unix://${socket}`, credential)), (error: unknown) => {
      assert(error instanceof TypeError);
      assert.equal(error.message, 'Invalid controlled Grok Docker input.');
      assert(!String(error).includes(secret));
      return true;
    });
  }
  const valid = options(`unix://${socket}`, { [scope]: account });
  let reads = 0;
  await assert.rejects(prepareGrokDockerProvider({ ...valid, get credential() { reads += 1; return valid.credential; } }), TypeError);
  await assert.rejects(prepareGrokDockerProvider({ ...valid,
    backend: { ...valid.backend, get user() { reads += 1; return valid.backend.user; } } }), TypeError);
  await assert.rejects(prepareGrokDockerProvider({ ...valid,
    backend: { ...valid.backend, egress: { ...valid.backend.egress,
      get routeAuthority() { reads += 1; return valid.backend.egress.routeAuthority; } } } }));
  assert.equal(reads, 0);
  await assert.rejects(prepareGrokDockerProvider({ ...valid, profile: { ...valid.profile,
    // @ts-expect-error Controlled Grok supports only its three qualified policies.
    policy: 'provider_accept_edits',
  } }), { name: 'TypeError', message: 'Invalid controlled Grok Docker input.' });
  for (const input of [Object.assign({}, valid, { arbitraryVerifier: () => true }),
    Object.assign({}, valid, { profile: { ...valid.profile, policy: undefined } }),
    Object.assign({}, valid, { backend: { ...valid.backend, datasets: [] } }),
    Object.assign({}, valid, { workload: { ...valid.workload, network: { kind: 'outbound' } } }),
  ]) await assert.rejects(prepareGrokDockerProvider(input), TypeError);
  assert.equal(requests.length, 0);
  for (const identity of [{}, { principal_type: 'User', principal_id: account.user_id },
    { principal_type: 'User', principal_id: account.user_id, team_id: 'personal-billing-team' },
    { principal_type: 'User', principal_id: account.user_id, team_id: 'personal-billing-team',
      coding_data_team: 'independent-opaque-privacy-context', team_zero_data_retention: false,
      coding_data_retention_opt_out: true, team_blocked_reasons: ['BLOCKED_REASON_NO_LOGS'] }]) {
    const entered = requests.length;
    await assert.rejects(prepareGrokDockerProvider(options(`unix://${socket}`, { [scope]: { ...account, ...identity } })), DockerImageInspectionError);
    if (process.platform === 'linux') assert(requests.slice(entered).includes('/version'));
  }
});
