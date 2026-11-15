# @agen-ai/provider-grok

Optional owned Grok Docker composition for the AgenAI coding-agent runtime. Coordinated
version `0.4.14` adds `grok-build-1.0.77-controlled-shell-v1`, qualified on the exact installed
Linux x64/native-arm64 Desktop tuples in the [handoff](../../examples/approval-policy/HANDOFF.md).
This optional package and runtime selection are introduced with Agent Protocol V14.
The package root contains inert constants and types. Filesystem, Engine and execution effects
require the explicit `@agen-ai/provider-grok/docker` entrypoint.

## Fixed composition

Each composition binds one instance identity, one fresh native UUID, `/workspace/work`, native Grok Build `1.0.77` / build `50ca579fa996`, model `grok-4.6`, and one policy: `host`, `provider_auto_review`, or `provider_bypass`. It advertises `supportsMultipleInstances: false`. Only Linux x64 and native arm64 Docker Desktop profiles are admitted. Rosetta, caller-supplied connections/backends/verifiers, other native versions, arbitrary endpoints, and mutable policy settings are excluded.

The upper owner compares actual image-file observations from a never-started Engine container against the exact official ELF hash/size, root-owned execute-only mode `0111`, generated launcher/profile/configuration bytes, protected real directories, empty caches, literal session/log links and required absences. It then creates its actual neutral Docker backend from the same captured endpoint, image ID and profile. The native launcher checks `fs.suid_dumpable` is `0` or `2`, clears its environment and directly executes the pinned ELF without a guest relay. The trusted host/daemon must preserve those facts through execution; the SDK changes no host sysctl.

The protected native HOME is `/opt/agenai/home`; GROK_HOME and canonical grants are on read-only root. Only the exact native UUID child, logs, temporary state and workspace are writable. The Bash-only profile excludes native Task and dynamic wrapper tools. Hook/MCP, managed-policy fetching, compatibility imports, bundles, leader/relay/session registry and automatic wake retain their fixed exclusions. Shared native catalog/history/search stores remain unwritable.

Auto-review retains native eligible-action semantics, including native preapprovals and denials. A genuine reviewed Block can produce an exact host request; unavailable/malformed review or unqualified missing metadata retires the session. The separately qualified mandatory `grok_config` category retains host interaction. Bypass does not accept every possible mandatory question, bypass outer sandbox grants, or recursively apply Grok policy inside arbitrary shell descendants.

An optional `profile.deniedBashPatterns` list selects immutable, deny-only native Bash rules, including
under provider bypass. For example, `['git reset --hard*']` can retain a caller-selected exclusion of
working-tree resets. Grok uses native **prefix or glob** matching; these are not exact-command strings.
The SDK preserves their strings and order without trimming or translating them. Supply at most 32
patterns, each 1–4,096 UTF-8 bytes, with at most 16,384 bytes in total; C0/DEL controls and malformed
Unicode reject. An empty list adds no rules, and omission preserves existing preparation bytes.
Preparation binds a supplied list into `profile.json` and protected global `config.toml`; image
admission requires that same captured list. Canonical remembered-grant stores stay empty. Changing
the list requires a fresh prepared image and qualification; there is no live rule mutation, allow/ask
input or provider-neutral rule language. Matching does not recursively police arbitrary programs
inside an approved shell command. The live hard-deny control used `['*']`; the git-prefix example
illustrates admitted native syntax and is not an executed git-prefix qualification claim.

The constructor policy is an immutable ceiling: each instance advertises only its selected policy
for fresh `create`. This does not authorize host tools or turn native review into a host answer.
Neither auto-review nor bypass widens the sandbox's filesystem/network grants. A mode report or
bounded native log event is not per-action attestation or proof of classifier correctness.

The inspected launcher explicitly sets uppercase and lowercase HTTP/HTTPS proxy variables to
`http://127.0.0.1:3128`, the existing sandbox CONNECT proxy, with only `127.0.0.1,localhost` in
`NO_PROXY`/`no_proxy`. The clean environment cannot inherit caller proxy settings. This supplies
the route to the fixed destination allowlist; it does not widen that allowlist or add TLS interception.

## Explicit offline preparation

First prepare and explicitly compile the unmodified SDK credential-bootstrap source with a trusted Linux toolchain for the selected target, using `prepareSandboxCredentialBootstrap` from `@agen-ai/sandbox/node`. Record the resulting ELF's SHA-256. The bootstrap hash identifies that caller-compiled helper; it is not proof of arbitrary helper behavior. The base filesystem and toolchain remain trusted caller inputs.

```ts
import { parseAgentInstanceId } from '@agen-ai/agent-protocol';
import { prepareGrokDockerApprovalProfile } from '@agen-ai/provider-grok/docker';

const profile = {
  instanceId: parseAgentInstanceId('grok:workspace-1'),
  nativeSessionId: crypto.randomUUID(),
  policy: 'provider_auto_review' as const,
  deniedBashPatterns: ['git reset --hard*'], // Optional native prefix-or-glob denial, retained under bypass.
  credentialBootstrap: { sha256: compiledSdkBootstrapSha256 },
};

const prepared = await prepareGrokDockerApprovalProfile({
  directory: '/absolute/fresh/build-context',
  profile,
  dockerProfile: 'linux-x64',
  baseImageDigest: explicitlySelectedPinnedBase,
});
```

Preparation writes only a credential-free offline context, including another copy of the SDK-owned bootstrap sources and their source digest. It performs no compiler/build/pull/download/install or native execution. Supply the exact official ELF as `grok` and the compiled helper as `agenai-credential-bootstrap`, then explicitly build the emitted Dockerfile for its recorded platform with networking and pulling disabled. Its scratch stage copies the pinned base filesystem without inheriting image environment. The caller owns context files, partial preparation output, native/base inputs and the resulting image. Keep the borrowed final image immutable until workload destruction; delete it separately afterward.

## Owned provider and workspace

```ts
import { prepareGrokDockerProvider } from '@agen-ai/provider-grok/docker';
import { readSandboxCredentialFile } from '@agen-ai/sandbox/node';

const bytes = await readSandboxCredentialFile({ path: explicitlySelectedAccountFile });
let provider;
try {
  provider = await prepareGrokDockerProvider({
    profile,
    backend: {
      profile: 'linux-x64', endpoint: selectedEngineEndpoint,
      imageDigest: explicitlyBuiltFinalImageId,
      namespace: 'my-grok-workspace', spillDirectory: '/absolute/private/spill',
      user: { uid: 1000, gid: 1000 },
      egress: preparedEgressOptionsWithOriginalRouteAuthority,
    },
    workload: {
      resources: { cpus: 2, memoryBytes: 4 * 1024 ** 3, pids: 256 },
      temporaryStorage: { homeBytes: 128 * 1024 ** 2, tempBytes: 128 * 1024 ** 2 },
      execution: { kind: 'deadline', timeoutMs: 300_000 },
      deadlines: { startupMs: 30_000, cleanupMs: 30_000 },
      transfers: explicitlySelectedTransferBuffers,
      streams: explicitlySelectedStreamLimits,
    },
    credential: { kind: 'auth_json', bytes },
    recovery: { kind: 'in_process' },
  });
} finally {
  bytes.fill(0);
}
```

`backend.egress` uses the existing explicitly prepared broker/relay and original platform-matching route-authority handle from `@agen-ai/sandbox-docker/node`. The owner fixes `restricted_https` to `cli-chat-proxy.grok.com:443`. This is host/port admission, not URL-path filtering within TLS. No issuer/login/refresh, registry, telemetry, wildcard or fallback destination is added. Initial authentication accepts only a bounded native `auth_json` copy for one personal first-party OIDC account at scope `https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828`, with future expiry. A personal billing `team_id` is accepted only with explicit `principal_type: 'User'` and matching `principal_id`/`user_id`; those admitted identity fields are preserved. Team/organization/deployment principals and other team/organization context are rejected. Known native coding-data/ZDR booleans and bounded blocked-reason strings are validated and preserved verbatim; the bounded opaque `coding_data_team` string is preserved without treating it as identity. Refresh authority and unrelated metadata are removed; the original file is never written or refreshed. Native code can read its copied access credential, unlike the separately scoped host-only diagnostic relay. Account selection remains the trusted host's responsibility; copied fields are not independent server-side identity verification.

Import through `provider.workspace.importDirectory(directory, options)` before materialization. Every transfer requires `deadlineAt` plus finite `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `maxArchiveBytes`, and `maxPaths` quotas; preserving symlinks also requires `maxSymlinks`. Materialization closes import immediately and joins entered imports before eager native launch. Wrong identities and invalid local configuration reject before their corresponding effects. An entered materialization or admitted fresh create is spent even if it fails.

Register `provider.driver` with the ordinary runtime, using the exact bound instance identity and empty `driverConfiguration: {}`. Fresh create requires the same explicit `approvalPolicy: { kind: profile.policy }`, managed session configuration and the fixed cwd. Omission rejects before native opening. The generic ACP layer advertises no normalized policy support; only this admitted upper owner returns `verification: 'controlled_configuration'` after exact native identity/UUID/cwd/model checks. Mode/model/configuration changes retire the session before further native mutation. Resume/branch, raw slash commands, provider operations, host binding, session forms/reviews, native continuations, structured output and native collaboration are unsupported.

Session close or instance disposal joins the original ACP/callback owners and stops the sandbox while retaining its workspace. Export through `provider.workspace.exportDirectory(selection, directory, options)` only after that stop settles. Uncertain cleanup fences export. Outer `provider.dispose()` synchronously closes all admission, joins entered materialization/opening/transfers and original failed cleanup, then destroys the sandbox. Retry the same `dispose()` owner after failure. Inspection failures separately retain `DockerImageInspectionError.cleanup.retryCleanup()` when original inspection cleanup remains unresolved; retrying cleanup never resumes admission or creates a native process. Workload recovery remains the original Sandbox recovery-v3 record exposed as `provider.recoveryRecord`; it never reopens a session or replays work. No live-file capability is exposed.

The [native example guide](../../examples/approval-policy/README.md) supplies inert configuration
checking, offline preparation, and an explicit single-turn runner with authorization accounting,
persisted original recovery checkpoints, bounded output, residual once-only decisions and cleanup.
Run it only after preparing the actual platform's existing restricted-network infrastructure.
For the qualified Desktop deployment use a finite route-authority `commandTimeoutMs: 5000` with the
1000 ms poll interval and 20000 ms helper lease: the original 1000 ms deadline failed before native
entry. Linux requires a pinned physical executable; the qualified host uses `/usr/bin/ip`, because
`/usr/sbin/ip` is a symlink refused by the authority reader's `O_NOFOLLOW`. Prepare and hash your
own actual executable and retain the original platform authority. These inputs change no grants.

## Validation scope

Hermetic tests cover offline artifacts/capture, closed local inputs, actual corrupted image bytes, credential-free image admission and original inspection cleanup retries. Lifecycle tests exercise the existing internal composition boundary through its returned driver/workspace/dispose APIs, using the public neutral Sandbox backend, real fixture-process pipes and exclusive host scratch. They prove import closure, disposal fencing, stop/export ordering, original cleanup retry and separate owners; they do not attest a native image or classifier. Protocol semantics and actual late peer responses belong to the closed Node ACP dialect tests.

Token usage comes from the selected dialect: the composed instance declares the
`grok-prompt-usage` turn view, and each answered prompt yields one final authoritative delta
from its response `_meta.usage`, before turn completion. Mapping, gap and rejection rules are in
the [provider-acp prompt token usage section](../provider-acp/README.md#controlled-grok-prompt-token-usage).
A lifecycle test drives that path through the public runtime registry with a scripted fixture
peer. Separately, the same packed archives passed a two-prompt native-live comparison on Linux x64
(Docker Engine) and native-arm64 Docker Desktop, through this composition's personal access-only
route, with nonzero cache reads and reasoning, native model identity and complete cleanup. The
fixed profile admits no scripted model endpoint, so there is no native-scripted usage row.
Cancellation, errors and partial/mixed usage have scripted-peer coverage only. The approval-policy
evidence below has its own scope and does not broaden the token-usage qualification. Migration
from Agent Protocol V13 is in [UPGRADING-TO-AGENT14.md](../../UPGRADING-TO-AGENT14.md).

Installed native qualification passed seven behavioral cases on each exact platform: host allow,
host deny, genuine native Auto Allow, genuine native Auto Block with residual denial, public-CLI
bypass, native `['*']` hard deny under bypass, and entered cancellation. Original failed attempts and
expected-negative raw failures remain retained. Every final row settled its original owners and
passed independent resource absence. The [handoff](../../examples/approval-policy/HANDOFF.md)
records exact archives, route prerequisites and complementary configuration/process/Task evidence.

Positive-effect rows observed direct original memory/fd0/fd1 access denial, protected-write and
excluded-network denial, execute-only root-owned ELF, zero capabilities and no-new-privileges.
The accepted Option A descriptor sample is incomplete and does not prove complete original ACP
pipe-inode alias exclusion. Native Task exclusion is based on the immutable profile and exact
catalogs plus historical Mac adversarial controls; no direct adversarial Linux dispatch is claimed.
Native logs are mutable diagnostics, not per-action or authentication-method attestation; no
`auth_method` readback was observed. Reservations totaled $11 Mac/$8 Linux/$19 combined, including
failures and prior MS001; actual charges remain unobserved. These are authorization reservations,
not provider monetary or reasoning caps. Qualification does not extend to arbitrary native versions,
models, accounts, patterns, Rosetta, child-agent execution or other providers.
