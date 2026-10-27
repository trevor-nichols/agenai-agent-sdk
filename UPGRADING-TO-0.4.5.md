# Upgrade to SDK 0.4.5

The coordinated **ten-package 0.4.5 release** is published; npm `latest` and `beta` select all ten
matching packages. Use the published `v0.4.5` checkout for example source. Do not mix 0.4.4 and
0.4.5 artifacts or treat a version number as qualification of changed native bytes. See the
[v0.4.5 release](https://github.com/trevor-nichols/agenai-agent-sdk/releases/tag/v0.4.5).

Agent Protocol remains **V13**. Independent runtime execution-input, structured-output, history,
native account and platform qualifications retain their original evidence. This release adds
restricted HTTPS sandbox infrastructure, opt-in live workspace operations, opt-in confined
symbolic-link transfers, recovery v3 and an infrastructure-failure backend SPI. The earlier Linux
consumer-capabilities MS003 repaired
29-case installed live campaign passed on its recorded Linux tuple. MS004's installed r3 candidate passed 23 symbolic-link native cases with an independent cleanup
audit. Separate installed Claude/Grok bridges, native scripted tool/cancellation and real API-key cases passed on their recorded Linux tuples. The real API-key campaign used an explicit qualification-only loopback gateway; it does not establish direct-native-endpoint-only behavior, subscription login, refresh, billing or native Mac account behavior. Qualification applies to exact retained artifacts, not merely matching version numbers.

The separate [Mac baseline record](examples/sandbox/HANDOFF.md#recorded-mac-baseline-2026-10-26)
qualifies native arm64 and AVF/Rosetta amd64 on M3/macOS 26.5.1, Node 24.18.0 and Docker
Desktop 4.54.0 / Engine 29.1.2: each passed 30 checks plus the installed two-turn controlled ACP
example. Both selected APFS volumes passed all 183 host tests without skips; native filename and
raw-target representation limits remain explicit. Pinned Grok 1.0.62 passed eager initialization
without a session, account or model turn. Current source additionally admits explicitly configured
Desktop live files; the [separate installed native campaigns](examples/sandbox/HANDOFF.md#desktop-live-files-native-campaigns-2026-10-26)
passed all 18 cases on each of native N7 and Rosetta R2 with complete cleanup and 43 final-empty
scopes per row. The separate [MS004 r2 preserving-transfer campaigns](examples/sandbox/HANDOFF.md#desktop-preserving-transfer-native-campaigns-2026-10-27)
passed all 136 cases on each Desktop profile across both APFS roots and baseline/private-live
layouts, with complete cleanup and 230 final-empty scopes each. Their selected archive/controller/helper
tuple is recorded separately from the baseline and live-file records. The separate
[MS005 N12/R2 restricted-HTTPS campaigns](examples/sandbox/HANDOFF.md#desktop-restricted-https-native-campaigns-2026-10-27)
each passed 26 installed cases and 98 final-empty scopes on their exact IPv4-only caller-quiescent
tuple. Separate [MS006 combined campaigns](examples/sandbox/HANDOFF.md#desktop-and-linux-combined-native-campaigns-2026-10-27) passed
thirteen cases and 62 final-empty scopes on each Desktop profile using packed-ms006-r3. Real
Linux x64 R1 passed eleven combined cases, eighteen live-file cases and 68 preserving-transfer
cases on the freshly installed candidate. Fresh MS006 Linux network R1 separately passed all 46
network/recovery cases and 378 independent absence observations against the current installed
candidate and controller sources. Mac datasets,
large-workspace scale and product integration remain unqualified. Select the record's exact
source/archive identities before relying on these results.

## Drain the published baseline before migration

1. Retain the exact working 0.4.4 controller, dependency lock, packages and original latest durable
   recovery records. Keep the matching Docker endpoint/profile/namespace/image/user/dataset
   configuration and its authorized cleanup owner available.
2. Stop application admission of new work to the old controller. Close native SDK sessions and
   output readers, stop complete owned workloads, export final files if required, then destroy
   retained resources. After controller death, first make its entered operations quiescent and
   reconcile the original record with its matching **0.4.4** controller.
3. Independently verify exact owned-resource absence. Retain unknown creates and failed cleanup
   for the same owner's explicit retry. Do not prune, discover/adopt resources by label, delete
   borrowed images or rewrite a record to make it parse.
4. Select the matching 0.4.5 release for new reservations only after its chosen distribution and
   deployment have passed their required checks. An unresolved old workload keeps its original
   controller; it does not become a v3 workload through a package upgrade.

The 0.4.5 parser rejects `agenai.sandbox-recovery.v1` and `.v2` before backend effects. The
published 0.4.4 controller cannot clean a new seven-role v3 restricted topology. There is no
record conversion, live-session recovery or automatic command replay.

## Update contracts and third-party drivers

`SandboxNetworkPolicy` adds:

```ts
{ kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] }
```

Update exhaustive switches. The neutral parser captures/sorts at most 128 unique exact
lowercase ASCII DNS/explicit-port pairs. Hostnames need at least two labels; IP literals and
legacy numeric spellings, wildcards, Unicode/IDN, userinfo, paths and trailing-dot aliases reject.
Ports are integers from 1 through 65535. Unavailable support rejects before driver reservation.
Never translate an unsupported requirement into broad outbound access.

`SandboxSupport.networkAllowlist` is now
`false | { kind: 'https_connect'; maxDestinations: 128 }`; it is not an arbitrary boolean flag.
Support, requested policy and effective observations remain separate facts. Existing isolated
and broad outbound semantics remain selectable. Required workspace disk quotas and independent
process termination remain unsupported by the current Docker backend.

Backend `start` now receives
`{ signal, checkpoint, onInfrastructureFailure }`. Report a lost enforcement boundary with
`onInfrastructureFailure(error: SandboxOperationError)`; the neutral owner synchronously closes
admission, aborts entered process/transfer/live-file work and initiates owned stop. Stop must drain all
primary and infrastructure producers, including resources that did not yield a ready handle.
Failed cleanup retains the same retry owner. A driver that does not implement restricted egress
must keep its support unavailable. A callback or capability declaration alone is not proof of
network enforcement.

Optional `policy.files` normalizes to `{ kind: 'disabled' }`. Request `read_only` or `read_write`
explicitly. Optional `support.files` defaults to false and otherwise declares
`{ read: true, write: boolean }`; `effective.files` and acquired `ready.files` must match the grant.
Existing drivers can omit all three facility fields and remain disabled. Unsupported grants
reject before driver reservation. `/backend` exports the finite read-only/read/write driver
ports; public `sandbox.files` is discriminated and only its read/write variant exposes writes.
Update code constructing a public sandbox to supply its disabled handle when no facility exists.

`stat`, sequential callback `list` and callback-scoped streaming `readFile` observe a running
workspace; `writeFile` requires explicit `{ mode: 'create' | 'replace' }`. One operation enters at
a time, without overlap with transfers. Paths share a 4,079-byte UTF-8/128-component/255-byte
component envelope; `'.'` is allowed only for live root stat/list. Transfer metadata batches now
require at least 8,167 bytes for the new path/target record; the 64-KiB default is unchanged. Longer paths reject without
truncation/normalization. Update custom path validation and too-small working-buffer selections.

Drivers must honor bounded chunks, operation signals and optional `deadlineAt`/byte/entry quotas,
await callbacks and actual stream/source cleanup, and return exact observed terminal counters.
No implicit cumulative file/directory quota or whole-operation timer is added. Reads/listings
remain observations rather than atomic snapshots. Payload operations reject unsupported special
files/hardlinks and never follow guest symlink/magic-link or mount escapes.

Writes stage outside the guest namespace on the same volume. New files use 0644; replacements
preserve the latest admitted regular-file rwx observation, without set-ID/sticky propagation.
There is no caller chmod or inode compare-and-swap. Receipts distinguish no publication,
publication and unknown effect; known publication includes actual permissions. `bytes` reports
confirmed helper-admitted bytes and can be `null` after unavailable acknowledgement on unknown
cancellation/uncertainty. Never substitute source-pulled bytes or replay a changed/uncertain
write. Those outcomes fence mutation and enter owned stop. Stop must remove native writers and
join entered callback/source work before final export; bounded cleanup failure retains its owner.

Tree-entry unions add `{ kind: 'symlink', path, target }`, without payload or executable fields.
Update exhaustive consumers and all successful transfer summaries: `symlinks: bigint` is now
required, including `0n` for regular-only transfers. `files` still means regular files. Optional
`quotas.maxSymlinks` has its own counter. This is a public contract migration despite the patch
version selected for the coordinated candidate.

Preservation requires `symlinks: 'preserve_internal'` on each transfer; omission or `reject`
retains default rejection. `support.transferSymlinks` may be omitted/false or exactly
`{ kind: 'preserve_internal', import: 'empty_workspace' }`. Drivers receive a required normalized
`symlinks` choice. No startup policy or recovery revision is added. Unsupported opt-in rejects
before source/spill/backend entry. Every preserving import must establish actual workspace
emptiness before archive writes, so incoming targets cannot traverse pre-existing links.

Raw relative link targets share the bounded UTF-8 representation, but retain admitted `.`/`..`
text. Complete disk-backed namespace validation rejects escaping chains and intermediate member
links. Each resolution is bounded to 40 link expansions, 256 pending/resolved components and
8,160 active-path bytes; only proved confined dangling/cyclic links are preserved. Subtree validation
uses the selected root. Exact-file export and live access remain no-follow. Node helpers capture
options/selections before asynchronous preparation, stage links last and publish only after full
validation. Hardlink records and special files remain unsupported. Linux x64 preserving transfers
retain their separate qualification. Both Docker Desktop profiles now advertise the same contract
through baseline and private-live workspace layouts; the separate MS004 r2 campaigns qualify
their exact installed tuple on the recorded Mac. The earlier APFS host-helper checks alone do
not qualify that guest capability, and historical Linux native evidence retains its original scope.

Node 24.18.0's permission model requires full filesystem read/write permission for `fs.symlink`.
The regular-directory helper proof retains path-scoped permissions; preserved host publication
is tested separately with the required broader controller filesystem authority. Explicit owned
paths and stable-source/destination preconditions still apply. This is a host Node API constraint,
not a change to guest mounts or live no-follow admission.

Recovery v3 keeps the bounded identity/digest envelope and admits at most nine unique roles:
`compute`, `storage`, `export`, `network`, `egress_socket`, `egress_broker`, `egress_relay`,
`filesystem` and `route_observer`. Linux Docker acquires three/four/seven roles for isolated/outbound/restricted mode
without live access; selecting live files adds exactly the filesystem role, giving four/five/eight.
Desktop restricted HTTPS additionally owns `route_observer`, giving eight or nine roles respectively.
It reuses the existing workspace volume, without an extra initializer or arbitrary resource
payload. There is no persistent authentication role.

Docker revisions are Linux `engine-1.52-v5-linux-x64` and Desktop `engine-1.52-v6-<profile>`.
Older Desktop v5 owners require their original controller and complete original checkpoints;
never translate their records. Configuration identity binds endpoint,
profile, workload user/image, sorted datasets and selected helper image/protocol/user, helper
budgets, control lease and immutable route-observer descriptor, plus optional filesystem
image/protocol/executable/layout/user/resources/tmpfs/control identity. Absent filesystem
configuration preserves the preceding digest and baseline layout. Request policy has its own
digest. Live observer functions are not serialized. Helpers use the matching configured helper
image rather than a duplicate generic image field in the record.

## Explicit restricted Docker construction

Restricted mode requires an explicitly configured Linux same-host or admitted Apple
Virtualization Desktop composition with a rootful daemon and the qualified baseline controls.
Desktop additionally needs its original `createDockerDesktopRouteAuthority` handle, prepared
Darwin host executable and native arm64 VM route-observer image. The baseline Mac pass does not
establish network enforcement; use the separate MS005 N12/R2 record. Remote-daemon and rootless
restricted compositions remain unsupported.

Use the new explicit `@agen-ai/sandbox-docker/node` entrypoint to:

- Call `prepareDockerSandboxEgressHelpers({ directory, baseImageDigest, user })` to create a
  fresh owned build context from the shipped compiled helper closure. It records artifact
  hashes and a fixed Dockerfile; it does not invoke Docker or build/pull an image.
- Build that context explicitly against the exact already-present Linux Node image. The
  raw-local-image-ID recipe uses `DOCKER_BUILDKIT=0`, `--pull=false` and `--network=none` with
  empty caller-owned HOME/Docker configuration. BuildKit repository resolution is not an
  equivalent offline procedure. Retain the exact resulting immutable helper image ID.
- Call inert `createDockerLinuxRouteAuthority` with explicit same-host/caller-quiescence
  assertions, a selected absolute `ip` executable path/SHA-256 and bounded poll/command/output
  settings. Observation executes only fixed bounded commands after verifying that executable.
  A cloned/serialized handle is not valid authority.

Add `egress` to `createDockerSandboxBackend` with that helper image ID, protocol
`agenai.sandbox.egress-connect.v1`, helper numeric user, separate broker/relay CPU-memory-PID and
tmpfs budgets, the original authority handle and explicit heartbeat/lease timing. The control
lease must exceed heartbeat interval. The complete [Docker package README](packages/sandbox-docker/README.md#restricted-https-egress)
provides exact constructor and preparation examples. Helpers and their budgets are additional
to the workload; prepared images remain borrowed and are never removed by sandbox cleanup.

The caller owns host route/interface/VPN quiescence throughout restricted execution. Engine
hostname/kernel comparisons supplement the explicit same-host assertion. Observed interfaces
and non-default routes, including publicly numbered local/VPN destinations, supplement static
private/special/loopback/link-local denial. Unavailable or changed authority fails closed. The
SDK does not reconfigure host networking or Docker to make a campaign pass.

The workload remains on `network:none`; a separate relay shares only that network namespace and
serves `http://127.0.0.1:3128`. Only the broker uses the external bridge. The private Unix socket
is broker-writable/relay-read-only and is never mounted in the workload. Helper code/root is
immutable, control uses bounded controller-only stdio, and readiness verifies copied-up socket
directory identity, exact UID/GID and mode 0700. There is no privileged runtime initializer.

Pass explicit `HTTPS_PROXY`/`HTTP_PROXY` values to a client that supports HTTPS CONNECT. The SDK
does not rewrite arbitrary client networking. Broker enforcement is exact hostname/port plus
resolved-address exclusion and pinning for each new connection. It tunnels bytes and **does
not terminate or validate TLS**; the selected client must authenticate its TLS endpoint. The
policy does not limit request paths, authenticate a tenant, prevent an allowed service from
relaying data, or hide guest-readable credentials. Direct routing remains unavailable when
proxy variables are removed. Native proxy compatibility, MCP callbacks, tool authority and
real authentication each need their own exact qualification.

Broker/relay loss, control EOF/expiry, unexpected network membership or route-authority loss
closes egress and fences the workload through the infrastructure-failure path. There is no broad
outbound fallback. Stop joins producer/control work before final export. Infrastructure leases
do not introduce an execution or idle deadline.

## Explicit live Docker construction

Live access is disabled by default on every profile. An explicitly configured filesystem helper
supplies the facility on Linux x64 and both admitted Desktop profiles; request a read-only or
read-write grant separately. Desktop native N7 and Rosetta R2 each passed the recorded 18-case
campaign.
Its native Linux arm64 helper architecture is independent of the selected workload architecture;
the Rosetta workload is amd64. Use
`prepareDockerSandboxFilesystemHelper` from `@agen-ai/sandbox-docker/node` with a fresh owned
directory, exact already-present compiler image and selected numeric UID/GID. It writes five
shipped C/header assets and a fixed offline static-build recipe; it never compiles, builds or
pulls. Explicitly build with the local legacy Docker builder, empty owned builder HOME/Docker
configuration, `--pull=false` and `--network=none`. Retain source/compiler/binary receipts and
approve the resulting exact image ID. Its fixed environment is `PATH=/nonexistent`.

The backend's optional `filesystem` configuration supplies exact image/protocol/executable/layout,
the same numeric workload/helper user, explicit CPU/memory/PID/tmpfs budgets and heartbeat/lease
timing. The [Docker README](packages/sandbox-docker/README.md#live-workspace-files)
contains the complete constructor. Configuration supplies capability; the request must still
select its files grant. Different UID/GID requires a separately prepared artifact, not runtime chown.

First helper create is an entered journaled storage mutation even for read-only grants: Docker
copy-up initializes the new private `/store/work`, `/store/stage` and marker. Native readiness
attests exact UID/GID, mode-0700 directories, same filesystem and mode-0400 marker before compute
or import. Compute/export mount only work at `/workspace/work` with no-copy. The helper's stage
and volume root are never guest mounts; read-only helpers have a read-only data mount. There is
no runtime initializer/repair. Final export selects work only after all entered writers settle.
Prepared images remain borrowed, and cleanup/recovery never builds, reseeds or starts a helper.

The Desktop campaign additionally checks healthy held reads and write sources beyond the full
60-second lease, actual helper/control loss and native expiry with the original controller
paused while its attachment remains open. Positive expiry recovery resumes that same controller
for fenced mutation, joined stop/export and destruction. Mount-crossing fixture limitations and
independent PID/start/cgroup cleanup remain explicit. This 18-case-per-profile native scope does
not inherit the earlier Linux campaign's 29 cases or qualify restricted HTTPS, preserving
transfers, model/account behavior or billing on Desktop.

## Select native process and callback examples explicitly

The ordinary sandbox ACP bridge still supplies empty host facilities. The new
[consumer-owned Grok client](examples/sandbox/grok/README.md) composes the public transport
with `sandbox.files`, an explicit read/write grant, one native session and one active turn.
It maps guest paths only, rejects stale requests before dispatch, handles strict UTF-8 line
ranges and budgets the complete JSON-RPC success envelope. Its caller selects read/write,
frame and chunk bounds; these are adapter memory limits, not new sandbox transfer quotas.
Revocation, transport disposal and callback drainage remain part of the original owner.

The [Claude example](examples/sandbox/claude/README.md) is a private standalone example
workspace pinned to SDK 0.3.273. Its synchronous bounded streams bridge asynchronous
sandbox start, and its separate settlement preserves unavailable exit information.
Accepted kill dispatch is not a native signal-delivery or exit receipt. The guarded query
surface reconstructs an explicit guest configuration and rejects controller hooks, custom
JavaScript tools and in-process MCP rather than inheriting ambient authority.

Neither example adds a public vendor provider, changes the default host facilities or
replaces history's independent Claude SDK 0.3.306 tuple. A consumer choosing different native
versions or callback features must qualify that composition separately. Hermetic bridge
tests and scripted native fixtures do not establish real account authentication or billing.

## Recover and roll back with the matching controller

Use only the original trusted latest checkpoint after the previous controller is quiescent.
Parsing, digests and labels do not authenticate an edited inventory. An absence result covers
that exact inventory and cannot prove an omitted resource never existed. Preserve original
records and any new identified IDs returned by reconciliation before invoking cleanup.

Cleanup validates immutable recorded identity and the selected daemon; it does not require a
healthy route lease, available observer executable, fresh helper-image preflight or surviving
compute namespace. Mutable network membership is checked separately from cleanup fingerprints.
Uncertain effects retain ownership rather than being replayed or rediscovered by label.

To roll back, stop/destroy all v3 resources with the retained 0.4.5 controller and verify their
exact absence, then select 0.4.4 for **new baseline** work. Keep any unresolved v3 owner and its
matching controller available. Neither rollback nor upgrade resumes an agent or changes public
publication/deployment state.

## Validate the candidate

From a matching reviewed standalone checkout, follow [CONTRIBUTING.md](CONTRIBUTING.md):

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:sandbox-platform-consumer --output /absolute/new-packed-platform-proof
```

Use the documented pinned Node/pnpm versions. Checks build and inspect the coordinated
ten-package candidate; optional entrypoints must compile from packed public exports without
workspace source aliases. Run native networking/recovery campaigns separately with exact local
images, endpoint, original route authority and fresh owned evidence directories. Retain
negative controls, all acquired identities, original failures and independent cleanup results.
Do not run real login or inference without an explicitly selected route, credential source and
campaign allowance. Existing 0.4.4 native results do not certify these 0.4.5 artifacts.
