# @agen-ai/sandbox

Optional, provider-neutral ownership for one sandbox and one native process. Current source belongs to the unpublished coordinated `0.4.5` candidate; the published baseline remains `0.4.4`. It supplies policy, streaming tree, opt-in live workspace files, process and recovery contracts, shared lifecycle admission and `withSandbox`. It does not select an engine, image, provider, credentials or application authority. Candidate implementation and historical native qualification are separate facts.

The ordinary ESM root supports Node >=22 and has no ACP dependency. Backend implementations use the explicit `@agen-ai/sandbox/backend` seam. The optional `@agen-ai/sandbox-docker` package supplies the local Docker implementation. Backend and native-provider qualification remain specific to their recorded environments and configurations.

## Choose the entrypoint

| Entrypoint | Use |
| --- | --- |
| `@agen-ai/sandbox` | Plain contracts, parsers, cleanup errors and `withSandbox`; no Docker or ACP dependency. |
| `@agen-ai/sandbox/backend` | Implement a backend through the shared lifecycle and validation owner. |
| `@agen-ai/sandbox/node` | Explicit directory import/export and caller-selected metadata spill storage; no implicit host paths. |
| `@agen-ai/sandbox/acp` | Compose an explicitly started sandbox with the optional `@agen-ai/provider-acp/node` constructor. |
| `@agen-ai/sandbox-docker` | Select the separately installed local Docker backend. |

Use matching `0.4.5` source/local-archive artifacts for every selected SDK package when testing this candidate. Published `0.4.4` introduced the sandbox packages; `0.4.3` does not include them. The standalone candidate includes a complete [Docker walkthrough](../../examples/sandbox/README.md), its runnable [example](../../examples/sandbox/docker.ts), and the reusable [session lifecycle](../../examples/sandbox/session.ts). `withSandboxAcpSession` and `SandboxAcpSessionError` belong to that example source; they are not npm package exports.

## Ownership

`backend.reserve(request, recovery)` is synchronous and inert. Keep the returned reservation before starting it. Startup failure preserves that cleanup owner through `SandboxStartError.owner`. A reservation has one start attempt; cancellation never authorizes replay of a command. `stop()` fences admissions and releases the complete compute boundary while retaining files. `destroy()` releases compute and retained storage. Concurrent cleanup joins its entered work; failed or uncertain cleanup keeps the same retry owner.

After startup, stream regular files and directories with `importTree` before calling `reserveProcess`. Public methods accept ordinary typed path strings and validate them at entry; callers may also use the parsers for prevalidation. Driver ports receive branded paths, captured immutable metadata and once-only controlled bodies. Process reservation closes imports synchronously. The process owns binary Node `stdin`, `stdout`, and `stderr`; its `exit` promise reports only the leader. Exact compute removal may lose that receipt, represented as `{ kind: 'unavailable', reason: 'sandbox_stopped' }` without fabricating a code or signal. Leader exit and stream EOF do not establish stopped descendants. The process has `stopScope: 'sandbox'`. Use callback-scoped `exportTree` only after complete stop and stream settlement. The returned guest `workspace` is authoritative; it conveys no host filesystem path.

`withSandbox(backend, request, async sandbox => result, { recovery })` always attempts to destroy the reservation. Export any required files inside the callback, after `sandbox.stop()` succeeds and streams settle. If the callback and cleanup both fail, `SandboxRunError` preserves `primaryError`, `cleanupError` and `owner`; `retryCleanup()` uses that same owner. A `SandboxCleanupError` independently retains its exact stop/destroy operation and `retryCleanup()`. Successful later cleanup never erases the original failure.

## Explicit policy and finite values

Construct a request with `parseSandboxRequest({ policy: { resources, temporaryStorage, network, deadlines, transfers, streams } })`. CPU count, memory bytes and PID count are explicit positive values. `temporaryStorage.homeBytes` and `tempBytes` are positive safe-integer resource requests without a universal 256 MiB ceiling. The backend must enforce the requested resources. Choose `network.kind` explicitly: `isolated`, broad `outbound`, or opt-in `restricted_https` with `destinations: [{ hostname, port }]`. Outbound grants no destination allowlist or host/LAN exclusion.

Restricted destinations are a nonempty set of at most 128 exact lowercase ASCII DNS names and explicit integer TLS ports from 1 through 65535. Names require at least two labels; wildcards, IP literals/legacy numeric forms, Unicode/IDN labels, userinfo, paths and trailing-dot aliases reject. Parsing sorts and captures the set and rejects duplicates. An HTTPS CONNECT target constrains destination host/port; it does not establish HTTP path, tenant, content or credential-secrecy policy. `backend.support.networkAllowlist` is `false` or `{ kind: 'https_connect', maxDestinations: 128 }`; unavailable support rejects before driver reservation. The Docker candidate exposes restricted mode through explicitly configured Linux same-host or admitted Apple Virtualization Desktop compositions, with distinct platform-matching authority handles and prepared helpers. See its [preparation and authority contract](../sandbox-docker/README.md#restricted-https-egress).

Optional `execution` defaults to `{ kind: 'until_stopped' }`. No execution or idle timer is installed. Applications can choose `{ kind: 'deadline', timeoutMs }` with any positive safe-integer duration, including days and durations beyond Node's single-timer range. The deadline begins at process startup entry and owns the whole workload, including descendants. `withSandbox` additionally applies a chosen finite budget to its callback and always destroys the environment after callback completion. Until-stopped ownership does not promise controller or infrastructure crash survival.

`deadlines` contains independent `startupMs` and `cleanupMs` observations, bounded by 60 seconds and 30 seconds. File transfers instead accept an optional `deadlineAt` and `signal` on each call; omission installs no whole-transfer timer. Observer expiry never proves that entered work ended. Both retired `deadlines.executionMs` and `deadlines.operationMs` reject; migrate their intended policies explicitly.

`SANDBOX_DEFAULT_TRANSFER_BUFFERS` selects 64 KiB chunks, 64 KiB metadata batches and merge fan-in eight. These govern working memory, not file count or workspace size. `SANDBOX_DEFAULT_STREAM_LIMITS` selects bounded stdin and combined stdout/stderr staging plus a high-water mark, with no cumulative traffic quota. Optional `streams.maxStdinBytes` and `maxOutputBytes` are caller-selected totals; zero is meaningful. `maxBufferedInputBytes` rejects excess queued writes even when a caller ignores backpressure. Buffered overflow fails and initiates owned stop instead of truncating data. Backend transport buffers are accounted separately; these settings do not claim a total heap limit.

Process recipes retain their independent representation bounds: an absolute guest executable, literal arguments, explicit environment and working directory; 256 KiB recipe JSON, 128 arguments/environment entries and 16 KiB per environment value. No shell interpolation or inherited environment is supplied. Unknown fields and unsupported authority fail admission.

## Live workspace files

The optional `policy.files` grant is `{ kind: 'disabled' | 'read_only' | 'read_write' }`; omission normalizes to disabled. Backend support is `false` or `{ read: true, write: boolean }`. A grant requires both declared support and a matching acquired driver port/effective observation. Unsupported requests reject before driver reservation. Construction alone grants no live access, and the default `sandbox.files` handle is `{ kind: 'disabled' }`.

An admitted read-only handle supplies `stat(path, options?)`, `list(path, consumeEntry, options?)` and `readFile(path, consumeFile, options?)`. Only the read/write handle adds `writeFile(path, source, { mode: 'create' | 'replace', ...options })`. Methods operate while compute is ready, including while its primary process runs; they never select a host path. Only one live operation may enter at a time, and it cannot overlap an import/export. Concurrent calls reject rather than queue. Live operations do not reopen import admission after process reservation.

Paths use canonical workspace-relative UTF-8 strings with at most 4,079 bytes, 128 components and 255 bytes per component. The `'.'` sentinel names the root only for live stat/list. Stat and list observe kinds without following links; metadata carries `path`, `kind`, `byteLength` and observed rwx `permissions`. Payload reads and write-target admission require a regular file with the backend's conservative hardlink checks. The Docker helper rejects symlink/magic-link traversal and mount crossings. Neither a completed live listing nor an ordinary concurrent file read establishes an atomic source snapshot.

List invokes one awaited direct-child callback at a time. Read lends `{ entry, chunks }` only within its awaited callback; consume the iterator through completion before returning, and await each entered pull. Callback exit retires the iterator, and cancelled or outstanding work remains owned until it settles. Results distinguish `completed`, `missing`, `rejected`, `changed` and `cancelled`; list/read include bigint `entries`/`bytes`. Optional per-call `signal`, ISO `deadlineAt` and `quotas: { maxBytes?, maxEntries? }` add caller-selected limits. Omission imposes no cumulative traffic, directory-size or whole-operation timer. Chunks, protocol messages and in-flight work remain bounded independently. Malformed inputs and unknown fields reject; invalid backend receipts or failed stream cleanup fence ownership rather than becoming a missing-file observation.

```ts
if (sandbox.files.kind !== 'disabled') {
  const result = await sandbox.files.readFile('results/result.bin', async ({ entry, chunks }, { signal }) => {
    for await (const chunk of chunks) await applicationOwnedDraft.write(chunk, signal);
    // entry describes the admitted file; publish the draft only after result completes.
  }, { quotas: { maxBytes: 20n * 1024n ** 3n } });
  if (result.kind === 'completed') await applicationOwnedDraft.publish();
}
```

Writes consume bounded binary chunks into private same-filesystem staging. `create` never overwrites an existing name; `replace` atomically replaces that name. New files use mode 0644. Replacement preserves the latest admitted regular-file observation's rwx bits, excluding set-ID/sticky bits; an absent replacement target uses 0644. There is no chmod input, inode preservation, inode compare-and-swap or power-loss durability promise. A preflight kind observation does not lock a concurrently replaced name. An ancestor rename can leave a confined published effect with a `changed` receipt.

Write receipts carry `effect: 'none' | 'published' | 'unknown'`. Confirmed publication includes actual `permissions`; `bytes` counts confirmed helper-admitted bytes, and may be `null` on an uncertain or unknown-effect cancellation when its acknowledgement is unavailable. Pulled source bytes are not proof of native admission. Changed publication or unknown effects fence mutation and initiate owned stop; never automatically retry, roll back or replay a write. Stop closes live admission, aborts the channel/operation, removes native writers and joins entered callback/source work before final export. The existing bounded cleanup observation retains the same retry owner when a producer ignores cancellation or cleanup fails.

The current Docker facility requires its separately prepared trusted helper and explicit Linux configuration. MS003's repaired installed r7 campaign passed 29 live-file cases on its retained Linux x64/Node 24.18.0/Engine 29.1.3 tuple, including exact cleanup and fresh-process recovery. The earlier MS002 networking/recovery and published 0.4.4 reports keep their original scope; changed source or installed artifacts need their own qualification.

## Stream a workspace

`importTree(entries, options?)` accepts a synchronous or asynchronous iterable of directories, files and explicitly admitted symbolic links. Files declare `byteLength`, `executable` and `open({ signal })`, which returns a once-only byte source. Each admitted body must reach actual EOF with exactly its declared bytes. Short, excess, oversized or invalid chunks reject. `fileFromBytes(path, bytes, options?)` is a convenience for bytes already owned by the caller: it borrows bounded views without copying the whole file. Keep the backing bytes unchanged until transfer completion.

Transfers reject symbolic links by default. Select `{ symlinks: 'preserve_internal' }` on each import/export to preserve `{ kind: 'symlink', path, target }` entries without dereferencing them. A link has no body, payload length or executable flag. `backend.support.transferSymlinks` is false when unavailable, or `{ kind: 'preserve_internal', import: 'empty_workspace' }`; unsupported opt-in rejects before source, spill or backend entry. Every preserving import requires an actually empty workspace. This condition prevents incoming targets from traversing unvalidated existing links; it is checked again for each import. Default regular imports remain repeatable, subject to no-follow destination handling.

`parseSandboxSymlinkTarget` preserves raw relative target text, including admitted `.` and `..` segments. It rejects absolute/empty targets, malformed Unicode, control characters and backslashes, and bounds the representation to 4,079 UTF-8 bytes, 128 components and 255 bytes per component. Complete disk-backed namespace validation checks chains against the applicable root; lexical validation alone is insufficient. Duplicate paths and links/files used as another member's intermediate parent reject. Each resolution permits at most 40 link expansions, 256 combined pending/resolved components and 8,160 active-path UTF-8 bytes. Confined dangling links and exactly detected cycles may remain inert; unresolved chains exceeding these working bounds reject. Imports stream regular entries first and release links only after complete graph validation.

A subtree uses its selected root as the link-confinement boundary, even though returned paths retain their workspace prefix. A link safe in the full workspace can therefore reject in a subtree. Exact-file export remains regular-file-only. Preservation grants no live-file traversal authority and adds no hardlink or special-file support.

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

Optional per-transfer `quotas` include `maxFiles`, `maxSymlinks`, `maxFileBytes`, `maxTotalBytes`, `maxArchiveBytes` and `maxPaths`. Nonnegative safe integers or bigint amounts are admitted; omitted fields impose no SDK logical ceiling. Actual aggregate counters and successful summaries use bigint. Summaries require separate `files`, `directories` and `symlinks` counts; `files` and payload bytes retain their regular-file meaning. Archive quotas include headers/padding, independently of payload bytes. JSON serializers must explicitly convert bigint values to decimal strings. Relative paths use the common 4,079-byte, 128-component and 255-byte-per-component limits. Metadata batches must hold at least 8,167 bytes for one maximum path/target record; the 64-KiB default is unchanged. Paths and targets are neither truncated nor Unicode-normalized.

`maxPaths` counts each requested exact file and one requested subtree root; an explicit whole-workspace selection supplies no path roots. A subtree with `maxPaths: 0` rejects before backend export. Its summary counts the selected root among directories and counts only admitted descendants. Coverage and duplicate checks remain part of full-operation validation, so a missing root, late duplicate or malformed descendant invalidates provisional callback output.

The neutral metadata ledger uses bounded sorted batches, fixed merge fan-in and external run descriptors; it does not retain the whole path set or one open file per entry. Backends supply an explicit spill-storage port. The Node implementation opens exclusive files under a caller-selected canonical directory and unlinks them before writing; cleanup closes the handles, and controller death releases them through the OS. Disk exhaustion is an owned failure. A crash during the short create/unlink gap can leave an empty file. No environment-derived temp path is selected.

Only one transfer is admitted at a time, before any caller iterator is entered. Imports permanently close at first process reservation; export requires complete stopped compute. A late import failure may follow native writes, so it fences execution and is never automatically replayed. Source, callback, HTTP/parser and spill work remain owned until actual settlement, even after abort/deadline observation. A noncooperative callback can keep cleanup pending; failed spill closure retains the same retry owner.

Logical transfer quotas do not enforce guest workspace disk use. `policy.workspaceDiskQuota` is optional at input and normalizes to `{ kind: 'not_requested' }`. An application requiring allocated-block enforcement can explicitly request `{ kind: 'required', bytes: 20 * 1024 ** 3, accounting: 'allocated_blocks' }`. `bytes` must be a positive safe integer. The current backend support is `workspaceDiskQuota: false`; such a requirement throws `SandboxUnsupportedError` before driver reservation or native acquisition. It never silently becomes an ordinary volume. Effective policy reports `{ kind: 'not_requested' }` for the admitted baseline. No positive quota capability or inode/logical-file-size guarantee is claimed. `backend.support`, requested policy and observed `sandbox.effective` remain separate facts. Independent-process termination remains unsupported.

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

Imports traverse incrementally and read one regular file through its owned descriptor. Symlinks reject by default; explicit preservation reads their raw UTF-8 targets without following them and rechecks identity/target text. Special files remain unsupported. Descriptor/path identity and size checks detect replacement, truncation and growth. The caller must keep the trusted source hierarchy stable and quiescent; same-length concurrent edits are not an immutable snapshot, and portable Node does not defend against a hostile same-user writer replacing ancestors. Import options extend the ordinary transfer options with `chunkBytes`, defaulting to 64 KiB; choose a matching smaller value if the sandbox uses a smaller transfer chunk buffer.

Exports require an initially absent destination. The helper creates that directory exclusively as a private output namespace, stages inside it, and publishes its `files` child only after complete export validation. It returns `{ directory, summary }`; use the returned directory for the exported tree. Existing destinations are preserved. Keep the new namespace and its parent exclusively owned and stable until completion or cleanup. Publication relies on that ownership because portable Node rename has no atomic no-overwrite flag. File aliases reject through exclusive creation, while disk-backed directory identities prevent distinct logical paths from silently merging on filesystems with aliases. No in-memory tree census is required. File creation selects owner read/write and, when requested, execute permission; a restrictive process umask that removes the requested executable bit fails final validation instead of publishing the wrong metadata.

On failure, the helper closes callback admissions, joins entered filesystem work and removes only its owned staging. It never destroys the caller's sandbox. `SandboxDirectoryCleanupError` retains failed local cleanup and an explicit `retryCleanup()`; preserve that live owner until it succeeds. If publication succeeded before private metadata cleanup failed, `publishedDirectory` identifies the committed result and retry preserves those files. Local cleanup does not prove hidden backend transfer work settled. A noncooperative entered body keeps local cleanup pending; an observation deadline is not a guarantee of immediate filesystem cleanup. Atomic publication does not establish power-loss durability.

With preservation selected, exports stage link metadata on disk, validate the complete graph, install links after regular entries and verify their identities/targets before publication. Cleanup unlinks only known owned link entries without following them. Selection and transfer options are captured before asynchronous preparation. The standalone [filesystem example](../../examples/sandbox/filesystem.ts) accepts the explicit preservation option and compiles against an installed neutral sandbox/validation-only consumer with explicit filesystem permissions.

On Node 24.18.0, the Node permission model requires full filesystem read/write permission for `fs.symlink`; path-scoped permissions alone reject link creation. Regular directory transfers can use the narrower permission setup. Preserving host publication therefore requires a trusted controller with that filesystem authority, in addition to the explicit owned/stable directory preconditions. The installed checks exercise these two permission modes separately and keep process/network effects disabled in both. This host API constraint does not expand the guest's Docker mounts or enable guest path traversal.

The [combined public example](../../examples/sandbox/combined/README.md) composes these neutral
contracts with an explicitly constructed Docker backend. Desktop MS006 native N2 and AVF/Rosetta
R1 each passed thirteen installed cases with 62 final-empty scopes; real Linux x64 R1 passed eleven
combined cases, alongside fresh eighteen-case live-file and 68-case preserving-transfer rows.
These are exact candidate/platform observations, not a new neutral default or provider requirement.
The [handoff](../../examples/sandbox/HANDOFF.md#desktop-and-linux-combined-native-campaigns-2026-10-27) records their archive and native scope.

## Recovery

Choose `{ kind: 'in_process' }` or `{ kind: 'persisted', persist: async record => ... }` explicitly. Every checkpoint must finish persistence before the next resource effect. Failure retains cleanup ownership and fences progression. Stop and destruction must remain possible after persistence fails; cleanup does not depend on a later checkpoint succeeding.

`parseSandboxRecoveryRecord` accepts only `agenai.sandbox-recovery.v3`, bounded identity/digest fields and at most nine unique resource roles: `compute`, `storage`, `export`, `network`, `egress_socket`, `egress_broker`, `egress_relay`, `filesystem`, `route_observer`. Each role occurs at most once. Linux Docker acquires three/four/seven roles for isolated/outbound/restricted HTTPS without live access, or four/five/eight with the filesystem helper. Desktop restricted HTTPS additionally owns `route_observer`, giving eight or nine roles respectively. The mandatory `configurationDigest` binds immutable backend configuration separately from the request `policyDigest`. Both remain unchanged across checkpoints. Version 1 and 2 records reject before backend effects; drain 0.4.4/v2 resources with their retained 0.4.4 controller before migration. Names are assigned before effects. Each resource is `planned`, `creating` with entered but unresolved acquisition, or `identified` with exact ID and a SHA-256 incarnation/configuration fingerprint. Authority starts `unverified`; read-only preflight must establish a verified backend identity before any resource effect. The strict fixed envelope is at most 64 KiB serialized UTF-8 and has no environment, arbitrary payload or runnable session restoration.

A parsed record is data, never mutation permission. Retain the original trusted durable checkpoint; hashes and labels do not authenticate an edited inventory or prove an omitted resource never existed. An explicitly configured backend must validate its original namespace/backend identity, resource incarnation and ownership before reconciliation. Reconciliation returns matching or uncertain cleanup ownership, a conflict, or conclusive absence of that exact recorded inventory. It never returns a runnable session. An unreachable backend and a missing response do not prove absence; name or label matches alone do not authorize adoption. Recovery never automatically replays execution.

## Backend implementation seam

`createSandboxBackend(driver)` supplies shared admission, validation, deadlines and retained cleanup ownership around one finite driver. `driver.reserve(request)` assigns inert identities and an initial record. Its handle has `start({ signal, checkpoint, onInfrastructureFailure })`, `stop()` and `destroy()`. A driver calls `onInfrastructureFailure(error: SandboxOperationError)` when owned infrastructure can no longer enforce the admitted policy; the neutral owner synchronously closes admission, aborts entered process/transfer/live-file work and initiates owned stop. Failed cleanup retains its original retry owner. This callback grants no automatic recovery, replay or broader network fallback. Third-party drivers must adopt this SPI and v3 explicitly.

The ready port supplies effective facts, a guest workspace, an explicit spill store, streaming imports/exports and one inert process reservation. Optional `support.files`, `effective.files` and the acquired `ready.files` port must agree with the requested grant; omission remains disabled. `/backend` exports the discriminated `SandboxDriverReadOnlyFiles`/`SandboxDriverReadWriteFiles` contracts. Driver methods receive branded paths, an operation signal, quotas and chunk bound, and must await callbacks and actual stream/source settlement before returning. Transfer drivers also receive the normalized required `symlinks` choice and must implement their declared empty-workspace import admission. The shared metadata-ledger and target-parser exports provide bounded graph validation through injected spill storage, without granting filesystem authority. Stop must terminate the complete workload and all supporting writers/egress producers and unblock all owned raw streams. This seam carries no scheduler, plugin registry, host facility or generic resource hook. Native harness bridges remain a later milestone.

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
