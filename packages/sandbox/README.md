# @agen-ai/sandbox

Optional, provider-neutral ownership for one sandbox and one native process. This package is an unpublished member of the coordinated `0.4.4` candidate. It supplies policy, streaming tree, process and recovery contracts, shared lifecycle admission and `withSandbox`. It does not select an engine, image, provider, credentials or application authority.

The ordinary ESM root supports Node >=22 and has no ACP dependency. Backend implementations use the explicit `@agen-ai/sandbox/backend` seam. The optional `@agen-ai/sandbox-docker` package supplies the local Docker implementation. Backend and native-provider qualification remain specific to their recorded environments and configurations.

## Choose the entrypoint

| Entrypoint | Use |
| --- | --- |
| `@agen-ai/sandbox` | Plain contracts, parsers, cleanup errors and `withSandbox`; no Docker or ACP dependency. |
| `@agen-ai/sandbox/backend` | Implement a backend through the shared lifecycle and validation owner. |
| `@agen-ai/sandbox/node` | Explicit directory import/export and caller-selected metadata spill storage; no implicit host paths. |
| `@agen-ai/sandbox/acp` | Compose an explicitly started sandbox with the optional `@agen-ai/provider-acp/node` constructor. |
| `@agen-ai/sandbox-docker` | Select the separately installed local Docker backend. |

Use matching `0.4.4` candidate artifacts for every selected SDK package. Published `0.4.3` does not include the sandbox packages. The standalone candidate includes a complete [Docker walkthrough](../../examples/sandbox/README.md), its runnable [example](../../examples/sandbox/docker.ts), and the reusable [session lifecycle](../../examples/sandbox/session.ts). `withSandboxAcpSession` and `SandboxAcpSessionError` belong to that example source; they are not npm package exports.

## Ownership

`backend.reserve(request, recovery)` is synchronous and inert. Keep the returned reservation before starting it. Startup failure preserves that cleanup owner through `SandboxStartError.owner`. A reservation has one start attempt; cancellation never authorizes replay of a command. `stop()` fences admissions and releases the complete compute boundary while retaining files. `destroy()` releases compute and retained storage. Concurrent cleanup joins its entered work; failed or uncertain cleanup keeps the same retry owner.

After startup, stream regular files and directories with `importTree` before calling `reserveProcess`. Public methods accept ordinary typed path strings and validate them at entry; callers may also use the parsers for prevalidation. Driver ports receive branded paths, captured immutable metadata and once-only controlled bodies. Process reservation closes imports synchronously. The process owns binary Node `stdin`, `stdout`, and `stderr`; its `exit` promise reports only the leader. Exact compute removal may lose that receipt, represented as `{ kind: 'unavailable', reason: 'sandbox_stopped' }` without fabricating a code or signal. Leader exit and stream EOF do not establish stopped descendants. The process has `stopScope: 'sandbox'`. Use callback-scoped `exportTree` only after complete stop and stream settlement. The returned guest `workspace` is authoritative; it conveys no host filesystem path.

`withSandbox(backend, request, async sandbox => result, { recovery })` always attempts to destroy the reservation. Export any required files inside the callback, after `sandbox.stop()` succeeds and streams settle. If the callback and cleanup both fail, `SandboxRunError` preserves `primaryError`, `cleanupError` and `owner`; `retryCleanup()` uses that same owner. A `SandboxCleanupError` independently retains its exact stop/destroy operation and `retryCleanup()`. Successful later cleanup never erases the original failure.

## Explicit policy and finite values

Construct a request with `parseSandboxRequest({ policy: { resources, temporaryStorage, network, deadlines, transfers, streams } })`. CPU count, memory bytes and PID count are explicit positive values. `temporaryStorage.homeBytes` and `tempBytes` are positive safe-integer resource requests without a universal 256 MiB ceiling. The backend must enforce the requested resources. `network.kind` is `isolated` or `outbound`; outbound means broad egress, not an allowlist or host/LAN exclusion.

Optional `execution` defaults to `{ kind: 'until_stopped' }`. No execution or idle timer is installed. Applications can choose `{ kind: 'deadline', timeoutMs }` with any positive safe-integer duration, including days and durations beyond Node's single-timer range. The deadline begins at process startup entry and owns the whole workload, including descendants. `withSandbox` additionally applies a chosen finite budget to its callback and always destroys the environment after callback completion. Until-stopped ownership does not promise controller or infrastructure crash survival.

`deadlines` contains independent `startupMs` and `cleanupMs` observations, bounded by 60 seconds and 30 seconds. File transfers instead accept an optional `deadlineAt` and `signal` on each call; omission installs no whole-transfer timer. Observer expiry never proves that entered work ended. Both retired `deadlines.executionMs` and `deadlines.operationMs` reject; migrate their intended policies explicitly.

`SANDBOX_DEFAULT_TRANSFER_BUFFERS` selects 64 KiB chunks, 64 KiB metadata batches and merge fan-in eight. These govern working memory, not file count or workspace size. `SANDBOX_DEFAULT_STREAM_LIMITS` selects bounded stdin and combined stdout/stderr staging plus a high-water mark, with no cumulative traffic quota. Optional `streams.maxStdinBytes` and `maxOutputBytes` are caller-selected totals; zero is meaningful. `maxBufferedInputBytes` rejects excess queued writes even when a caller ignores backpressure. Buffered overflow fails and initiates owned stop instead of truncating data. Backend transport buffers are accounted separately; these settings do not claim a total heap limit.

Process recipes retain their independent representation bounds: an absolute guest executable, literal arguments, explicit environment and working directory; 256 KiB recipe JSON, 128 arguments/environment entries and 16 KiB per environment value. No shell interpolation or inherited environment is supplied. Unknown fields and unsupported authority fail admission.

## Stream a workspace

`importTree(entries, options?)` accepts a synchronous or asynchronous iterable of directories and files. Files declare `byteLength`, `executable` and `open({ signal })`, which returns a once-only byte source. Each admitted body must reach actual EOF with exactly its declared bytes. Short, excess, oversized or invalid chunks reject. `fileFromBytes(path, bytes, options?)` is a convenience for bytes already owned by the caller: it borrows bounded views without copying the whole file. Keep the backing bytes unchanged until transfer completion.

`exportTree(selection, consume, options?)` selects `{ kind: 'workspace' }`, `{ kind: 'files', paths }`, or `{ kind: 'subtree', path }`. Exact regular-file paths may be streamed; duplicate paths and regular-file ancestor conflicts reject through bounded spill validation. A subtree selects one canonical relative directory and its descendants, with no general multiple-root or overlap-coalescing API. A backend must export the selected root directory exactly once, including for an empty subtree, and cannot deliver an entry outside that root. Directory/file output paths remain relative to the workspace: selecting `results/reports` includes directory `results/reports` and file `results/reports/summary.txt`, without stripping the selected root. The root may arrive after descendants; all output remains provisional until the operation succeeds. Exact-file and subtree requests must target their selection without scanning unrelated workspace content.

The consumer receives immutable metadata and a once-only byte iterable. Consume every declared byte and await entered reads before returning; concurrent reads reject. Empty files and an exact final chunk require no extra EOF-only pull.

```ts
import { fileFromBytes } from '@agen-ai/sandbox';

await sandbox.importTree([
  { kind: 'directory', path: 'inputs' },
  fileFromBytes('inputs/task.txt', new TextEncoder().encode('task input')),
]);
// Reserve/run the process, close its SDK session, then stop the whole workload.
await sandbox.stop();
await sandbox.exportTree({ kind: 'files', paths: ['results/result.txt'] }, async (entry) => {
  if (entry.kind === 'file') {
    for await (const chunk of entry.bytes) await applicationOwnedSink.write(chunk);
  }
}, { quotas: { maxTotalBytes: 20n * 1024n ** 3n } });
```

All callback bytes are **provisional until the returned export promise succeeds**. Later malformed archive data, duplicate metadata or cleanup failure can invalidate the operation. An arbitrary application sink cannot be rolled back by the SDK; publish results only after complete success. Borrowed chunks remain valid until the next pull; copy any bytes retained beyond it. Sources must yield chunks no larger than the selected buffer size rather than one giant buffer.

Optional per-transfer `quotas` include `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `maxArchiveBytes` and `maxPaths`. Nonnegative safe integers or bigint amounts are admitted; omitted fields impose no SDK logical ceiling. Actual aggregate counters and successful summaries use bigint. Archive quotas include headers/padding, independently of payload bytes. JSON serializers must explicitly convert bigint values to decimal strings. Relative paths retain their 1,024-byte, 64-component and 255-byte-per-component representation limits.

`maxPaths` counts each requested exact file and one requested subtree root; an explicit whole-workspace selection supplies no path roots. A subtree with `maxPaths: 0` rejects before backend export. Its summary counts the selected root among directories and counts only admitted descendants. Coverage and duplicate checks remain part of full-operation validation, so a missing root, late duplicate or malformed descendant invalidates provisional callback output.

The neutral metadata ledger uses bounded sorted batches, fixed merge fan-in and external run descriptors; it does not retain the whole path set or one open file per entry. Backends supply an explicit spill-storage port. The Node implementation opens exclusive files under a caller-selected canonical directory and unlinks them before writing; cleanup closes the handles, and controller death releases them through the OS. Disk exhaustion is an owned failure. A crash during the short create/unlink gap can leave an empty file. No environment-derived temp path is selected.

Only one transfer is admitted at a time, before any caller iterator is entered. Imports permanently close at first process reservation; export requires complete stopped compute. A late import failure may follow native writes, so it fences execution and is never automatically replayed. Source, callback, HTTP/parser and spill work remain owned until actual settlement, even after abort/deadline observation. A noncooperative callback can keep cleanup pending; failed spill closure retains the same retry owner.

Logical transfer quotas do not enforce guest workspace disk use. `policy.workspaceDiskQuota` is optional at input and normalizes to `{ kind: 'not_requested' }`. An application requiring allocated-block enforcement can explicitly request `{ kind: 'required', bytes: 20 * 1024 ** 3, accounting: 'allocated_blocks' }`. `bytes` must be a positive safe integer. The current backend support is `workspaceDiskQuota: false`; such a requirement throws `SandboxUnsupportedError` before driver reservation or native acquisition. It never silently becomes an ordinary volume. Effective policy reports `{ kind: 'not_requested' }` for the admitted baseline. No positive quota capability or inode/logical-file-size guarantee is claimed. `backend.support`, requested policy and observed `sandbox.effective` remain separate facts. Allowlist and independent-process authority remain unsupported.

## Import and publish host directories

The explicit Node helpers keep filesystem authority in `@agen-ai/sandbox/node`:

```ts
import { importSandboxDirectory, exportSandboxDirectory } from '@agen-ai/sandbox/node';

await importSandboxDirectory(sandbox, '/absolute/quiescent/source');
// Run and close the agent, then stop all compute before exporting.
await sandbox.stop();
const exported = await exportSandboxDirectory(
  sandbox, { kind: 'workspace' }, '/absolute/new-output',
);
console.log(exported.directory); // /absolute/new-output/files
```

Imports traverse incrementally and read one regular file through its owned descriptor. Symlinks and special files reject. Descriptor/path identity and size checks detect replacement, truncation and growth. The caller must keep the trusted source hierarchy stable and quiescent; same-length concurrent edits are not an immutable snapshot, and portable Node does not defend against a hostile same-user writer replacing ancestors. Import options extend the ordinary transfer options with `chunkBytes`, defaulting to 64 KiB; choose a matching smaller value if the sandbox uses a smaller transfer chunk buffer.

Exports require an initially absent destination. The helper creates that directory exclusively as a private output namespace, stages inside it, and publishes its `files` child only after complete export validation. It returns `{ directory, summary }`; use the returned directory for the exported tree. Existing destinations are preserved. Keep the new namespace and its parent exclusively owned and stable until completion or cleanup. Publication relies on that ownership because portable Node rename has no atomic no-overwrite flag. File aliases reject through exclusive creation, while disk-backed directory identities prevent distinct logical paths from silently merging on filesystems with aliases. No in-memory tree census is required. File creation selects owner read/write and, when requested, execute permission; a restrictive process umask that removes the requested executable bit fails final validation instead of publishing the wrong metadata.

On failure, the helper closes callback admissions, joins entered filesystem work and removes only its owned staging. It never destroys the caller's sandbox. `SandboxDirectoryCleanupError` retains failed local cleanup and an explicit `retryCleanup()`; preserve that live owner until it succeeds. If publication succeeded before private metadata cleanup failed, `publishedDirectory` identifies the committed result and retry preserves those files. Local cleanup does not prove hidden backend transfer work settled. A noncooperative entered body keeps local cleanup pending; an observation deadline is not a guarantee of immediate filesystem cleanup. Atomic publication does not establish power-loss durability.

The standalone [filesystem example](../../examples/sandbox/filesystem.ts) compiles and runs against an installed neutral sandbox/validation-only consumer with explicit filesystem permissions.

## Recovery

Choose `{ kind: 'in_process' }` or `{ kind: 'persisted', persist: async record => ... }` explicitly. Every checkpoint must finish persistence before the next resource effect. Failure retains cleanup ownership and fences progression. Stop and destruction must remain possible after persistence fails; cleanup does not depend on a later checkpoint succeeding.

`parseSandboxRecoveryRecord` accepts only `agenai.sandbox-recovery.v2`, bounded identity/digest fields and at most four unique resource roles: `compute`, `storage`, `export`, `network`. The mandatory `configurationDigest` binds immutable backend configuration separately from the request `policyDigest`. Both remain unchanged across checkpoints. Version 1 records are rejected before backend reconciliation; retain the original compatible controller for any still-owned older resources. Names are assigned before effects. Each resource is `planned`, `creating` with entered but unresolved acquisition, or `identified` with exact ID and a SHA-256 incarnation/configuration fingerprint. Authority starts `unverified`; read-only preflight must establish a verified backend identity before any resource effect. The strict fixed envelope is at most 64 KiB serialized UTF-8 and has no environment, arbitrary payload or runnable session restoration.

A parsed record is data, never mutation permission. An explicitly configured backend must validate its original namespace/backend identity, resource incarnation and ownership before reconciliation. Reconciliation returns matching or uncertain cleanup ownership, a conflict, or conclusive absence. It never returns a runnable session. An unreachable backend and a missing response do not prove absence; name or label matches alone do not authorize adoption. Recovery never automatically replays execution.

## Backend implementation seam

`createSandboxBackend(driver)` supplies shared admission, validation, deadlines and retained cleanup ownership around one finite driver. `driver.reserve(request)` assigns inert identities and an initial record. Its handle has `start({ signal, checkpoint })`, `stop()` and `destroy()`. The ready port supplies effective facts, a guest workspace, an explicit spill store, streaming imports/exports and one inert process reservation. Stop must terminate the complete workload and unblock all owned raw streams. This seam carries no scheduler, plugin registry, host facility or generic resource hook.

## Optional ACP integration

Install the optional `@agen-ai/provider-acp` peer explicitly and import `createSandboxAcpIntegration` from `@agen-ai/sandbox/acp`. The helper returns a frozen `{ executionBoundary, host }` for the existing `createNodeAcpProviderDriver` constructor; it does not create a provider or session. Ordinary sandbox entrypoints have no dependency on this integration.

```ts
import { createSandboxAcpIntegration } from '@agen-ai/sandbox/acp';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';

// Start the sandbox and finish its file imports before creating the integration.
const integration = createSandboxAcpIntegration(sandbox);
const driver = createNodeAcpProviderDriver({
  providerKey,
  ...integration,
  launch: {
    executable: '/opt/agent/bin/agent',
    args: ['--acp'],
    env: {},
    cwd: sandbox.workspace,
    shutdownTimeoutMs: 15_000,
  },
});
```

The executable, arguments and environment must describe the caller's explicitly prepared guest image. Empty `env` supplies no caller variables or inherited host values; the Docker backend supplies its fixed HOME, TMPDIR and PATH. Its image admission requires exactly those environment values, when present, and rejects additional image environment metadata; see the [Docker image requirements](../sandbox-docker/README.md#prepare-the-guest-image). Add only explicit process environment values compatible with the chosen backend. Credentials passed this way are readable by guest code and the Docker controller. Use the exact returned `sandbox.workspace` as the guest working directory for both the launch recipe and SDK session opening. A guest path conveys no host filesystem authority. The existing Node constructor retains its POSIX host admission rules. Set the sandbox cleanup observation to 30 seconds with the launch shutdown setting of 15 seconds so the provider's outer execution cleanup observation is compatible.

Provider materialization eagerly initializes the one native connection and may reserve and start the process before the first SDK session opens. Keep its registry or materialized instance and dispose it even when no session opens. One SDK session may make multiple turns on that connection. A second connection, additional session or authentication reconnect fails before acquiring another process and cannot release or reuse the first connection. A failed connection attempt does not authorize replay. Use a fresh sandbox and integration for another native connection.

Connection release awaits `sandbox.stop()`, which stops the complete sandbox workload and joins its streams while retaining workspace storage. Export selected files after SDK close succeeds, then explicitly destroy the sandbox. Failed cleanup remains owned by the existing provider execution owner and sandbox cleanup owner; retain their errors and retry handles. A cleanup observation deadline does not establish physical shutdown.

The returned frozen `host` is empty. Host filesystem reads/writes, terminal creation, authentication terminals, URL/browser interactions, forms and external-tool facilities are disabled. The native agent's guest tools and ordinary portable permission handlers remain available inside their existing scope. Supplying different host callbacks, MCP servers or runtime host bindings separately grants that caller's explicit host authority; this helper cannot constrain arbitrary host code or move those effects into the guest. Native-provider feature mappings and qualification remain the provider's responsibility.

The optional sandbox packages and bridge do not change Agent Protocol V13 or add execution-input or structured-output support to a provider. The Docker backend's [qualification scope](../sandbox-docker/README.md#qualification-scope) records the selected real backend and Grok composition; other providers, account routes and fleet execution require their own evidence.
