# @agen-ai/sandbox-docker

Explicit local Docker Engine resources for `@agen-ai/sandbox`. Current source is the unpublished coordinated `0.4.6` candidate; `0.4.5` is the published release. It implements bounded provisioning, binary process streams, file import, terminal compute removal, retained file export and cleanup-only recovery, and adds opt-in Linux and explicitly prepared Desktop restricted HTTPS infrastructure. The optional `@agen-ai/sandbox/acp` bridge composes process streams with the public Node ACP provider. The installed candidate has separate restricted-network and recovery evidence on the exact local Linux composition described below; historical native-agent qualification retains its original scope.

```ts
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';

const backend = createDockerSandboxBackend({
  profile: 'linux-x64', // Optional; this is the default.
  endpoint: 'unix:///var/run/docker.sock',
  namespace: 'my-application',
  spillDirectory: '/absolute/canonical/caller-owned-spill',
  imageDigest: 'sha256:<exact 64 lowercase hexadecimal image ID>',
  user: { uid: 65534, gid: 65534 },
});
```

Construction and `backend.reserve(request, recovery)` are synchronous and inert. Startup verifies the explicitly selected spill directory, daemon and existing image before native resource acquisition. No environment-derived endpoint, image pull, image build, tool installation, host environment or Docker credential discovery occurs. The selected image must have no declared volumes; prepare a trusted image separately and provide its exact local image ID. UID and GID must each be nonzero and fit the archive ownership range 1–262143.

## Prepare the guest image

Select an already-present Linux image matching the selected profile's image architecture by its exact local `sha256:` image ID. It must contain `/bin/sh`, `sleep` and the chosen agent executable, support the non-root read-only-root profile, and declare no volumes. Every executable inside the image must be usable under that image's native or explicitly selected emulated architecture. A macOS host executable is not a Linux guest executable. The backend overrides the image entrypoint and command with its fixed keeper. Preparation is separate from the SDK's bounded workspace file import.

The workload environment must match these fixed values exactly:

| Name | Value |
| --- | --- |
| `HOME` | `/home/sandbox` |
| `TMPDIR` | `/tmp` |
| `PATH` | `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` |

Image environment metadata may omit those entries or declare their exact values. Additional image environment entries are rejected by workload readback; the backend does not silently strip or normalize them. An ordinary Node image's `NODE_VERSION` and `YARN_VERSION` metadata therefore requires explicit image preparation. The complete [standalone walkthrough](../../examples/sandbox/README.md) shows the caller-owned preparation helper and credential-free runnable example. The SDK never pulls or builds the image.

## Restricted HTTPS egress

Restricted mode is opt-in on `linux-x64` and both admitted Apple Virtualization Desktop profiles, with explicitly prepared helper images and an original platform-matching route-authority handle. Desktop additionally requires the exact Darwin host observer, native arm64 VM observer and captured deployment assertions described below. The installed 0.4.5 r5 candidate passed the 46-case MS002 r3 campaign on Linux x64, Node 24.18.0 and rootful Docker Engine 29.1.3/API 1.52, with controller and daemon on the same host under caller-owned route quiescence. The [qualification scope](#qualification-scope) separates this infrastructure proof from the independently qualified native client and API-key compositions; success applies only to their recorded tuples.

The explicit `/node` entrypoint prepares a fresh helper build context and constructs Linux observation authority. Imports perform no image build, pull or command. Preparation writes the shipped compiled helper closure, its SHA-256 manifest and a fixed Dockerfile; it executes no Docker command:

```ts
import { prepareDockerSandboxEgressHelpers } from '@agen-ai/sandbox-docker/node';

const preparation = await prepareDockerSandboxEgressHelpers({
  directory: '/absolute/fresh-owned-helper-context',
  baseImageDigest: inspectedLocalNodeImageId,
  user: { uid: 65534, gid: 65534 },
});
// Retain preparation.sourceDigest and preparation.files with the selected base image identity.
```

Select a trusted, already-present Linux image of the admitted helper architecture with `/usr/local/bin/node` and a compatible filesystem. `baseImageDigest` accepts either an exact local `sha256:` image ID or an immutable full repository reference ending in `@sha256:<64 lowercase hex>`. Use the inspected repository digest with BuildKit; retain the legacy builder for an existing bare-ID recipe because BuildKit may interpret that ID as a repository. Keep the context stable and exclusively owned. The following example uses the bare-ID legacy-builder path. Supply an empty caller-owned Docker configuration and home; never copy an ambient credential store. For the existing selected local endpoint, a caller-owned shell recipe is:

```sh
env DOCKER_BUILDKIT=0 \
DOCKER_CONFIG=/absolute/empty-owned-docker-config \
HOME=/absolute/empty-owned-builder-home \
docker --host unix:///var/run/docker.sock image build \
  --pull=false --network=none --tag agenai-egress:owned-review \
  /absolute/fresh-owned-helper-context
env DOCKER_CONFIG=/absolute/empty-owned-docker-config \
HOME=/absolute/empty-owned-builder-home \
docker --host unix:///var/run/docker.sock image inspect \
  --format '{{.Id}}' agenai-egress:owned-review
```

Use a unique task-owned tag and retain the exact resulting image ID; placeholders require deliberate replacement. The SDK constructor accepts only that immutable ID, not a tag. The prepared image sanitizes inherited environment metadata, labels its protocol/source/user identity, contains the fixed helper entrypoint and initializes the private socket directory with the selected UID/GID and mode 0700 at build time. Broker acquisition owns and checkpoints volume copy-up; each helper verifies the resulting directory identity/ownership/mode before declaring readiness. There is no privileged runtime initializer. Prepared images remain borrowed and are never deleted by sandbox cleanup.

Construct the opaque observer handle explicitly; its factory is inert. Observation later verifies the selected `ip` executable's bytes and executes only fixed bounded route/interface reads:

```ts
import { createDockerSandboxBackend } from '@agen-ai/sandbox-docker';
import { createDockerLinuxRouteAuthority } from '@agen-ai/sandbox-docker/node';

const routeAuthority = createDockerLinuxRouteAuthority({
  kind: 'local_linux_same_host',
  stability: 'caller_owned_quiescence',
  ipExecutable: { path: inspectedIpExecutablePath, sha256: inspectedIpExecutableSha256 },
  pollIntervalMs: 250,
  commandTimeoutMs: 2000,
  maxOutputBytes: 1024 * 1024,
});
const backend = createDockerSandboxBackend({
  profile: 'linux-x64', endpoint: 'unix:///var/run/docker.sock', namespace: 'my-restricted-application',
  imageDigest: inspectedWorkloadImageId, spillDirectory: '/absolute/owned-spill', user: { uid: 65534, gid: 65534 },
  egress: {
    imageDigest: inspectedPreparedHelperImageId, protocol: 'agenai.sandbox.egress-connect.v1',
    user: { uid: 65534, gid: 65534 }, routeAuthority,
    broker: { resources: { cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 32 }, temporaryBytes: 8 * 1024 ** 2 },
    relay: { resources: { cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 32 }, temporaryBytes: 8 * 1024 ** 2 },
    control: { heartbeatMs: 250, leaseTimeoutMs: 5000 },
  },
});
```

These budgets are caller choices, additional to workload resources. CPU, memory, PID count and temporary storage are explicit for both helpers; control lease must exceed heartbeat interval. Construction captures plain immutable identity separately from the live observer port. Cloning/serializing the handle does not reconstruct authority. A recovering controller explicitly constructs a new original handle from the same descriptor, without needing to run the observer during cleanup.

The caller asserts that controller and daemon share the selected Linux host and owns route/interface/VPN quiescence for the sandbox lifetime. Hostname/kernel readback supplements that assertion; it does not prove the claim independently. Observation covers host interfaces and non-default routes, including publicly numbered local/VPN destinations, in addition to static special/private/loopback/link-local ranges. Coverage is rechecked serially during startup and health. Unsupported or changed authority fences the workload; the SDK never changes host routes, firewall/VPN state or daemon settings to obtain a pass.

Request `network: { kind: 'restricted_https', destinations: [{ hostname: 'api.example.com', port: 443 }] }` inside the ordinary policy. At most 128 unique exact canonical DNS/port pairs are admitted; IP literals/legacy numeric forms, wildcards, Unicode/IDN, trailing dots and URL syntax reject. DNS CNAME resolution remains subject to the same resolved-address exclusions. The workload uses Docker `none`. A separate relay shares only its network namespace and serves `http://127.0.0.1:3128`; an externally attached broker alone receives the private Unix socket. The workload cannot mount that socket or access either helper's PID namespace/control stdin. Only the broker joins the owned external bridge; membership and helper policy are read back independently from immutable cleanup fingerprints.

Pass explicit `HTTPS_PROXY`/`HTTP_PROXY` values naming that loopback URL to a client that actually supports HTTPS CONNECT. A CONNECT `Host` header may omit the default `:443` port, as Node's `fetch` sends it; the request line alone selects the destination. The SDK does not rewrite arbitrary native clients or redirect their sockets. Removing proxy variables cannot create a direct route. Every new broker connection resolves the exact allowed hostname, checks all selected addresses against denied coverage, and pins the admitted address. A redirect needing another destination requires its own admitted pair. The broker tunnels bytes and does not terminate or validate TLS; the selected client must authenticate its TLS endpoint. It does not limit HTTP paths, authenticate tenants, prevent an allowed service from relaying data or provide secrecy from guest-readable credentials. It supplies neither arbitrary-destination TCP nor UDP routing.

Broker/relay failure, control EOF/lease expiry, topology drift or route-authority loss closes egress and reports infrastructure failure to the neutral owner. It closes admission and enters owned whole-sandbox stop; it never switches to broad outbound. Stop joins producers/control work and removes compute and helpers before final export. These infrastructure observations do not add an execution or idle deadline.

## Desktop observation preparation

The `/node` entrypoint exposes inert `createDockerDesktopRouteAuthority`, `prepareDockerDesktopHostNetworkObserver` and `prepareDockerDesktopVmRouteObserver`. An explicitly prepared matching authority enables Desktop restricted networking only when supplied in the backend egress configuration and requested by policy. The authority captures an exact profile, local Engine endpoint/ID, explicit deployment assertions, prepared host executable/source identity, VM image/source identity and bounded observation/control budgets. Only its original registered handle is accepted; a descriptor or serialized clone does not reconstruct it. Configuration rejects mismatched profiles and endpoints before I/O. Native observation is not performed by construction or cleanup.

Host preparation copies the fixed Darwin C/header sources and emits literal compiler argument recipes for an explicitly identified Clang executable, SDK and deployment target. It records source hashes, repeats the arm64 build with the same executable basename and includes comparison/hash/signature-inspection commands. VM preparation copies the fixed Linux C source and compiled controller closure into a pinned arm64 Dockerfile. Its controller accepts only ordered heartbeats, one bounded observation and stop; stop joins the native child. The emitted recipes require explicit caller execution. Preparation never compiles, signs, pulls, runs Docker, changes host settings or acquires privileges.

Both Desktop workload profiles derive native Linux arm64 filesystem, egress and observer helper architectures independently from workload architecture. The Rosetta workload remains amd64. Current source admits explicit Desktop live-file grants with a configured filesystem helper and per-transfer confined link preservation. Desktop restricted networking has separate MS005 N12/R2 qualification below; individual live-file, preserving-transfer and network records retain their exact artifact scopes. MS006 N2/R1 separately passed the generic combined workflow on the recorded r3 composition.

Desktop construction selects `kind: 'local_docker_desktop'`, the exact Desktop profile and
`engine: { endpoint, id }`, `stability: 'caller_owned_quiescence'` and
`interception: 'caller_owned_no_transparent_or_per_app_interception'`. Its closed deployment
assertions require Apple Virtualization, Rosetta enabled, ECI/host networking/kernel UDP disabled,
`networkingMode: 'ipv4only'`, `dnsInhibition: 'auto'`, Docker subnet `192.168.65.0/24`,
`proxyMode: 'automatic_system'` and no manual proxy configuration, plus the inspected Desktop
version/build. Supply the host preparation's protocol/source/executable digest, the VM
preparation's protocols/source/image/executable identity and explicit non-root resource/control
budgets, and bounded polling/command/output settings. Pass the original handle as
`egress.routeAuthority`; a clone does not reconstruct authority.

Startup brackets and seals Darwin interface/route/proxy facts, exact Unix Engine socket identity,
VM routes/interfaces and Engine network/IPAM topology before egress admission. Host/VM
observation loss, socket replacement, observed topology drift, an unexpected broker-network
member or helper/control loss closes admission and enters owned stop. The caller keeps the
host/VM/Engine/socket/executable/proxy/interception topology stable through final cleanup.
Polling and leases do not make arbitrary concurrent VPN or interception changes safe. The VM
observer is a distinct non-root network-observation helper with its own bounded control lease;
it grants no guest route, socket, filesystem callback or host PID authority. Cleanup uses exact
original checkpoints without needing a healthy route observation or a live Darwin executable.

The accepted Desktop MS005 N12/R2 campaigns each pass 26 installed cases and 98 final-empty
scopes on their exact `packed-ms005-r8` IPv4-only tuple. Their full identities, limits and
failed-attempt disposition are recorded in the standalone handoff under
"Desktop restricted-HTTPS native campaigns (2026-10-27)". Native HTTP 302, bulk tunnel
backpressure and reachable IPv6-service isolation remain separate. Combined behavior has its own MS006 record below.

## Live workspace files

Live access requires an explicitly prepared filesystem helper image and a request grant of `policy.files: { kind: 'read_only' | 'read_write' }` on any of the three admitted profiles. The helper image must match the profile's native helper architecture. Omission remains disabled and acquires no filesystem helper. Backend configuration supplies the facility; it does not enable the request grant. The earlier Linux consumer-capabilities MS003 repaired installed r7 campaign passed 29 live-files cases on its retained tuple. The separate Desktop capability MS003 native N7 and Rosetta R2 campaigns each passed 18 installed cases with complete cleanup on their exact packed-r2 tuple. Neither the earlier Mac baseline nor Linux evidence qualifies changed Desktop payloads. See [qualification scope](#qualification-scope).

The public `/node` entrypoint writes a fresh context from five shipped C/header assets and a fixed offline static-compiler recipe:

```ts
import { prepareDockerSandboxFilesystemHelper } from '@agen-ai/sandbox-docker/node';

const preparation = await prepareDockerSandboxFilesystemHelper({
  directory: '/absolute/fresh-owned-filesystem-context',
  toolchainImageDigest: inspectedAlreadyPresentCompilerImageId,
  user: { uid: 65534, gid: 65534 },
});
```

Preparation performs no compilation, image build or pull. Keep the context exclusively owned and retain its `sourceDigest`, `files`, compiler image identity and resulting build receipts. Build explicitly with the local legacy Docker builder, an empty owned HOME/Docker configuration, `--pull=false` and `--network=none`, as in the helper build recipe above. The compiler image must already be present and inspected at its immutable identity; a raw local image ID requires the selected legacy builder. The recipe compiles twice and compares executable bytes, retains compiler/binary-digest receipts and creates a scratch runtime image. The image declares exactly `PATH=/nonexistent`; the fixed absolute native executable does not discover a host toolchain or inherit environment credentials. Approve and select the exact resulting local image ID separately.

```ts
const backend = createDockerSandboxBackend({
  endpoint: 'unix:///var/run/docker.sock', namespace: 'my-live-application',
  imageDigest: inspectedWorkloadImageId, spillDirectory: '/absolute/owned-spill',
  user: { uid: 65534, gid: 65534 },
  filesystem: {
    imageDigest: inspectedPreparedFilesystemImageId,
    protocol: preparation.protocol, executable: preparation.executable, layout: preparation.layout,
    user: preparation.user,
    resources: { cpus: 0.25, memoryBytes: 64 * 1024 ** 2, pids: 32 },
    temporaryBytes: 8 * 1024 ** 2,
    control: { heartbeatMs: 250, leaseTimeoutMs: 5000 },
  },
});
// In the ordinary parsed request policy, select files: { kind: 'read_only' } or { kind: 'read_write' }.
```

Helper CPU/memory/PID/tmpfs budgets are additional caller choices; the control lease must exceed the heartbeat interval. The prepared image must bind the exact workload/helper numeric UID/GID, fixed executable/protocol/layout and source identity. A different user needs separately prepared bytes; startup never overrides a mismatched image user, repairs an existing volume or runs a privileged initializer. Prepared images remain borrowed.

The existing `filesystem` recovery role is acquired before compute, import or callback admission. Its first create owns the volume-initialization mutation: Docker copy-up seeds `/store/work`, private `/store/stage` and `/store/.agenai-layout`, even when the first helper data mount is read-only. Native readiness attests root/work/stage ownership, mode 0700, the same filesystem, and the exact private mode-0400 marker. Failed/unknown create or attestation retains its original cleanup owner and cannot admit compute. Only that initial helper mount permits copy-up. Compute and the never-started exporter receive the `work` subpath at `/workspace/work` with `NoCopy: true`; neither sees the volume root, stage sibling or marker. Without live access, the baseline layout stays unchanged.

The helper has a read-only root, no network, no added capabilities and private PID/IPC/cgroup namespaces. Only controller-owned Engine stdio carries its closed binary protocol. One request yields at most one bounded response; read/list pull the next chunk/entry only as needed. Native data frames are at most 64 KiB and metadata frames at most 2 KiB; one request/reply pair is in flight, with no unbounded operation queue. Heartbeats and the explicit lease bound lost-control ownership without imposing a cumulative read/write or execution timeout. Each operation rechecks its exact daemon/helper identity. Helper loss aborts/fences live authority and initiates whole-sandbox stop.

The [neutral live-file contract](../sandbox/README.md#live-workspace-files) defines stat/list observations, callback-scoped reads, optional quotas/deadlines and discriminated write authority. Descriptor-relative `openat2` resolution rejects ancestor links, magic links and mount crossings. Stat/list can report link or unsupported kinds; payload reads and write targets require an admitted single-link regular file. Reads bracket metadata/current-name observations and report change, without promising an atomic source snapshot.

Writes stage outside the guest mount on the same volume. Exclusive create and atomic name replacement use new-file mode 0644; replacement preserves the latest admitted regular-file rwx observation, stripping set-ID/sticky bits. There is no chmod input or inode compare-and-swap. A concurrent rename/type change can invalidate the requested-name observation after a confined publication, producing an effect-bearing changed/uncertain receipt. Confirmed receipts report actual permissions and helper-admitted bytes; unknown-effect cancellation/uncertainty can report `bytes: null` when acknowledgement is unavailable. These outcomes fence mutation and enter owned stop, without replay or rollback.

Stop closes new live admission, aborts the native channel, removes compute and every selected helper, and joins entered callbacks/sources before stopped export. A noncooperative producer or failed cleanup retains the bounded observation's retry owner. Final whole-workspace export requests only `/workspace/work` for this layout; private stage/marker and image siblings are excluded. Destruction removes the existing volume after all owned containers are absent. Recovery is cleanup-only and never reseeds, chowns or starts a replacement helper.

## Shared read-only datasets

`datasets` explicitly attaches already-present Linux images outside the writable workspace. Each attachment has a unique lowercase `name`, exact local `imageDigest` and optional canonical relative `subpath`:

```ts
const backend = createDockerSandboxBackend({
  endpoint: 'unix:///var/run/docker.sock',
  namespace: 'evaluation',
  spillDirectory: '/absolute/owned-spill',
  imageDigest: 'sha256:<exact workload image ID>',
  user: { uid: 65534, gid: 65534 },
  datasets: [{ name: 'reference', imageDigest: 'sha256:<exact dataset image ID>', subpath: 'corpus' }],
});
```

The guest reads that attachment at `/datasets/reference`. Subpaths are lexically canonical; Docker resolves any stable internal symlink alias and requires the resolved target to stay within the image. This is image confinement, not a blanket no-follow guarantee. Dataset images are data sources, so they need not match the workload's CPU architecture or fixed image environment. Executing a dataset binary still requires a compatible guest runtime. No image is pulled, built or deleted by this attachment API. Each sandbox retains its own private writable `/workspace/work`; workspace exports include only that workspace. The never-started export accessor does not mount datasets.

Dataset admission requires stable Docker Engine 29.1.4 or newer and the containerd image-store profile (`Driver: overlayfs`, `driver-type=io.containerd.snapshotter.v1`) in addition to the selected execution profile. An empty or omitted dataset list does not add an image-store requirement. The backend checks exact image identities, requested image mounts and effective read-only mount identities. Engine 29.1.4 marks image mounts experimental; only its exact per-mount advisory is accepted for explicitly selected datasets. Unexpected warnings still reject startup. Read-only dataset images remain borrowed through stop, destroy and cleanup recovery. A finite maximum of 32 attachments bounds mount configuration; it imposes no dataset file-count or aggregate-byte quota. Arbitrary guest targets, host binds and externally mutable named-volume datasets are not admitted. Native Mac dataset qualification remains pending independently of baseline Mac execution.

`policy.workspaceDiskQuota` defaults to `{ kind: 'not_requested' }`. Explicit `{ kind: 'required', bytes, accounting: 'allocated_blocks' }` rejects before driver reservation because this backend cannot enforce a qualified hard quota. CPU/RAM/PID controls and optional logical transfer quotas do not protect Docker storage from guest writes. A positive local project-quota adapter is deferred until a suitable native filesystem and enforcement proof exist; no host reconfiguration or unverified quota selector is provided.

## Execution and files

`DockerSandboxProfile` is a closed choice of the following compositions. The default `linux-x64` profile preserves the existing Linux admission. Both Desktop profiles have baseline qualification on the exact M3/macOS 26.5.1 tuple and candidate bytes recorded under [qualification scope](#qualification-scope); a profile name alone does not qualify another machine or artifact.

| Profile | Node controller | Linux daemon | Linux image | cgroup v2 driver | AppArmor |
| --- | --- | --- | --- | --- | --- |
| `linux-x64` (default) | Linux x64 | amd64 | amd64 | systemd | daemon enabled; running workload `docker-default` |
| `desktop-apple-virtualization-native-arm64` | macOS arm64 | arm64, Docker Desktop | arm64 | cgroupfs | daemon absent; running workload profile empty |
| `desktop-apple-virtualization-rosetta-amd64` | macOS arm64 | arm64, Docker Desktop | amd64 | cgroupfs | daemon absent; running workload profile empty |

Every profile requires rootful Engine API 1.52 compatibility, CPU, memory, swap and PID controllers, builtin default seccomp and private cgroup namespaces. Observable rootless/user-namespace modes and mismatched controls reject. Desktop admission checks Engine `OperatingSystem: 'Docker Desktop'`; the daemon hostname is not a security invariant. A Desktop selection on Linux, an Intel Mac or native Windows rejects before spill-directory or Engine access. All profiles retain the same workload resource and isolation readback. Docker controller access remains powerful host authority; the workload never receives the socket or host bind mounts.

For an Apple Silicon Mac, select the socket and profile explicitly:

```ts
const backend = createDockerSandboxBackend({
  profile: 'desktop-apple-virtualization-native-arm64',
  endpoint: 'unix:///absolute/user/.docker/run/docker.sock',
  namespace: 'my-application',
  spillDirectory: '/absolute/owned-sandbox-spill',
  imageDigest: 'sha256:<exact local Linux arm64 image ID>',
  user: { uid: 65534, gid: 65534 },
});
```

Choosing a Desktop profile is the caller's explicit assertion that Docker Desktop uses Apple Virtualization framework with Enhanced Container Isolation disabled. The Rosetta profile additionally asserts that Rosetta for Linux amd64 emulation is enabled; it requires an amd64 image on the arm64 daemon. Container creation explicitly requests the selected image's Linux platform. Engine API checks cannot independently establish all those Desktop settings or which emulator executed an instruction. Record and verify them in actual platform qualification. There is no automatic architecture fallback, Docker context discovery, image pull or Desktop reconfiguration. Docker VMM, Intel Macs, ECI, WSL and native Windows have no admitted profile. The Desktop VM is shared infrastructure; effective sandbox isolation remains `container`.

The workload has a read-only root, explicit non-root identity, all capabilities dropped, no-new-privileges, private PID/IPC/cgroup namespaces and exact CPU/memory/PID limits. Home and temporary files use bounded tmpfs mounts. One private named volume holds `/workspace/work`; transfer count/byte limits do not establish a workspace disk quota. The fixed `/bin/sh` keeper overrides the image entrypoint and command. Images must support that workload profile.

`isolated` selects Docker `none`. Explicit `outbound` creates a private bridge and permits access to reachable host, LAN and internet services. Restricted HTTPS requires the separately configured composition above; baseline modes are never silently upgraded. None of these modes hides guest-readable credentials from guest code. No published ports, privileged mode, devices or arbitrary Docker options are admitted.

`importTree` streams regular files/directories before process reservation. `exportTree` requires stopped compute and a never-started, read-only accessor of the exact private owned volume. Whole-workspace export streams `/workspace` for the baseline layout or only `/workspace/work` for the live layout; exact-file and single-subtree selections check every ancestor with bounded HEAD operations, then GET only the selected file or directory. `{ kind: 'subtree', path: 'artifacts' }` includes that directory and its descendants, preserving workspace-relative paths. The selected root must be a real directory; unrelated entries are not scanned. No unselected root archive is fetched or filtered. The no-writer ownership condition is mandatory; this mechanism does not admit a mutable borrowed workspace.

Archive headers, checksums, local PAX metadata, body lengths, padding and complete termination validate incrementally. Symbolic-link records reject by default. All three profiles support explicit per-transfer `symlinks: 'preserve_internal'`, with capability `{ kind: 'preserve_internal', import: 'empty_workspace' }`. Each preserving import first reads actual workspace archive metadata and rejects the first non-root member before PUT, without reading its payload. This rule also applies when the pre-existing entry is a regular file. Empty preserving imports can repeat while the workspace remains empty. Preservation works through the baseline and private-live workspace layouts; selecting it grants no live-file authority.

The shared disk-backed ledger validates the complete incoming namespace and resolves raw relative link targets before links are emitted after all regular entries. Default imports still emit ancestor directory headers with Engine `noOverwriteDirNonDir=true`; an existing link ancestor cannot become a traversed destination. A regular leaf replacement removes the link entry rather than following its target. Preserve imports do not merge incoming links with an unvalidated existing namespace.

Local PAX `path` and `linkpath` override USTAR fallback fields before semantic validation. Each local PAX header is bounded to 16 KiB, enough for the maximum wrapped path and raw target plus supported timestamp metadata. Hardlink records, special/sparse files, traversal, duplicates, conflicting ancestors, nonzero link payloads and link metadata on another entry kind reject. Subtree validation uses the selected root. Exact-file selection and live methods never follow preserved links. A selected regular file may be a hardlink alias within the same private volume: Engine stat has no link count, and a one-file tar emits it as regular bytes. Callback bytes remain provisional until complete operation success. Common relative paths allow 4,079 UTF-8 bytes, 128 components and 255 bytes per component; metadata batches must hold at least 8,167 bytes for a path/target record. These are representation/working bounds, not cumulative workspace quotas. See the [neutral transfer contract](../sandbox/README.md#stream-a-workspace) for link-resolution bounds and separate symlink accounting.

The initial archive representation supports individual sizes through `8 GiB - 1`; base-256 and PAX size overrides are unsupported. This format boundary is separate from optional caller quotas. Aggregate workspace bytes and file count have no universal SDK ceiling. Streaming HTTP, bounded chunks and external metadata sorting replace complete-body buffers. Connection/header/acknowledgment observations are finite, but no implicit timer covers the complete body; upload acknowledgment begins after the body finishes. Control JSON remains bounded and buffered. `spillDirectory` is explicit host authority; no default home/temp path is discovered.

Reserve one process with an absolute guest executable, literal arguments, explicit environment and the returned guest workspace. Docker exec uses the selected non-root user, no TTY and separate binary stdout/stderr. The backend supplies the fixed HOME, TMPDIR and PATH above; conflicting overrides fail during inert reservation. Other explicit process environment values are passed literally. Credentials supplied in that environment are readable by guest code and the trusted Docker controller. Image preparation and credential selection remain the caller's responsibility.

The process exit receipt describes the leader only. Descendants and the keeper remain owned until `stop()` removes the whole workload. If compute removal prevents observing leader status, exit reports `unavailable` with reason `sandbox_stopped`. An observed exit receipt never changes. Stdin supports backpressure and half-close; abandoning an output reader, malformed framing, output overflow or an explicitly selected execution deadline initiates whole-sandbox stop. Startup and cleanup do not replay exec requests.

Sandbox `policy.execution` defaults to `{ kind: 'until_stopped' }`, which installs no execution or idle timer. Select `{ kind: 'deadline', timeoutMs }` explicitly for a finite process lifetime; positive safe-integer millisecond values support days and durations beyond Node's single-timer range. CPU, memory, PID and working buffers remain independent. `deadlines.startupMs` and `cleanupMs` govern infrastructure observations; each transfer can opt into `deadlineAt` and logical quotas without a default transfer lifetime. See the [neutral policy contract](../sandbox/README.md#explicit-policy-and-finite-values) for timing scope and migration from the retired `deadlines.executionMs` field.

Docker can acknowledge the stream upgrade before the exec starts. A non-running exec with a null exit code remains pending under the selected execution policy; only a non-running exec with a numeric exit code yields an exit receipt.

`maxBufferedOutputBytes` bounds the combined public stdout/stderr staging. Docker additionally bounds its accepted upgrade head to 64 KiB, current receive chunk to 64 KiB, partial frame header to 8 bytes and each raw output channel to one selected-high-water-mark chunk (at most 64 KiB each). This permits at most 256 KiB + 8 bytes of additional library-owned framing/output staging at maximum settings, plus Node socket/kernel buffers and object metadata. Frame declarations above 1 MiB fail before payload retention; a complete frame is never allocated solely from that declaration. These are staging bounds, not a total heap cap.

`stop()` permanently force-removes the exact workload container ID and every selected egress/filesystem helper, joining producers/control work and entered live callbacks/sources; it retains workspace storage and the accessor. `destroy()` additionally removes retained exact containers, volumes and networks and can be retried after partial failure. There is no broad prune, label scan, automatic command replay or known-ID fallback to a name. Startup cancellation joins entered acquisition. The original owner can complete cleanup when cancellation or failed persistence prevented a create from being dispatched. A dispatched create with an unresolved outcome, or a recovered `creating` checkpoint, remains uncertain when its resource name is absent.

The optional `@agen-ai/sandbox/acp` bridge uses this one process for one initialized native connection and one SDK session, which can run multiple turns. Provider materialization is eager and can start the process before session opening. Retain and dispose the registry or instance even if opening never succeeds. Connection release stops the whole compute workload and joins its streams while retaining files. Close the SDK, export selected artifacts, then destroy retained resources. The bridge disables host facilities; supplying additional host callbacks, MCP servers or runtime host bindings separately grants the caller's own host authority. The [example lifecycle helper](../../examples/sandbox/session.ts) implements this ownership sequence and retains exact cleanup retry handles; it is example source, not a package export.

## Cleanup-only recovery

Recovery records use `agenai.sandbox-recovery.v3`, Linux `engine-1.52-v5-linux-x64` and Desktop `engine-1.52-v6-<profile>`. Older Desktop v5 owners require their original controller and complete original checkpoints; records are never translated. `configurationDigest` binds endpoint/profile, non-root user, workload image, sorted datasets, the selected plain egress identity and optional filesystem image/protocol/executable/layout/user/resources/tmpfs/control identity. `policyDigest` binds request policy separately. Live observer functions are not serialized. Roles are exactly compute/storage/export for isolated; those plus network for outbound; those plus network/egress_socket/egress_broker/egress_relay for restricted HTTPS. Live access adds the one filesystem role, giving four/five/eight roles respectively, with no additional volume or initializer role. Desktop restricted HTTPS additionally owns `route_observer`, giving eight roles without live access and nine with it. Absent filesystem configuration preserves the preceding configuration digest and no-live layout. Helpers use their matching configured image while workload/export retain the workload image; no generic resource bag or duplicate image field is added to the record.

Earlier revisions, v1/v2 and other selected profiles reject or conflict before Engine effects. Persisted checkpoints precede effects and record returned identities before later effects. Resource labels bind the complete original immutable record, and reconciliation checks exact names, labels and configuration fingerprints against the explicit matching configuration/daemon. Mutable network membership is checked separately; a disappeared compute namespace does not require recreating compute to delete its relay. Daemon admission is repeated before cleanup, but cleanup does not require a healthy route lease, observer executable or new helper/dataset-image preflight. A changed daemon retains cleanup ownership without acting. Reconciliation returns cleanup ownership only. A planned resource is never adopted; unknown acquisition outcomes retain their retry owner.

Recover from the original trusted latest durable record only after the previous controller and its entered operations are quiescent. Parsing/hashes do not authenticate a caller-edited inventory; an absence result covers the exact supplied inventory and cannot prove omitted resources never existed. A stale planned record conflicts when its exact resource name is already present, including when that name belongs to a foreign resource. If reconciliation advances a `creating` identity to an inspected ID, persist the returned `owner.recoveryRecord` before invoking cleanup; reconciliation does not write to the caller's persistence store.

Drain outstanding 0.4.4/v2 resources using their matching retained 0.4.4 controller before selecting this coordinated 0.4.5 candidate. Never rewrite a v2 record as v3. To roll back, stop/destroy v3 resources with their 0.4.5 controller, verify absence, then use 0.4.4 only for new baseline workloads. Keep failed records and retry owners; neither upgrade nor rollback restores a live agent session or publishes/deploys this candidate.

## Qualification scope

The earlier Linux consumer-capabilities MS003 repaired installed r7 campaign passed all 29 live-file cases, covering FS01–FS07, the combined eight-role topology, changed/unknown write effects, native publication behind a withheld acknowledgement and fresh-process cleanup after controller SIGKILL. Its exact helper binary SHA-256 is `467e80d77d52cecb4dcd4072db9f27fa4630eb0087b14f5a05dfd21da70c7e6f`, on Linux x64, Node 24.18.0 and rootful Engine 29.1.3/API 1.52. An independent audit verified exact resource absence and available PID/start identities. This retained tuple does not qualify subsequent changed artifacts or symbolic-link transfers; MS004's installed r3 candidate separately passed 23 native transfer cases, including binary/executable/raw-link round trips on both workspace layouts, actual empty-workspace admission, repeated regular imports, maximum PAX metadata, hardlink/FIFO rejection, subtree confinement and live no-follow. Its independent audit confirmed 91 resource references absent and 70 available PID/start identities gone (deduplicated per case). These reports retain their exact artifact scope; Desktop preserving transfers have the separate native record below. The following MS002 and 0.4.4 results retain their original source/artifact identities.

The separate Desktop live-file native campaigns used the packed MS003 r2 candidate.
Its 18-case row includes healthy read/write backpressure beyond the full 60-second control lease,
control loss and natural lease expiry while the original controller is paused with its attachment
open. Positive expiry cleanup must resume that same controller for fencing, stop/export and
destruction. The unprivileged mount-crossing fixture is explicitly unsupported. Both profiles use
the same prepared native arm64 helper at UID/GID 1000:1000 with a 1-second heartbeat; the Rosetta
workload remains amd64. The standalone handoff records exact artifacts and case scope.
Desktop capability MS003 N7 and Rosetta R2 each passed all 18 cases with complete case cleanup.
Each observer was removed after 43 final-empty scopes: 19 compute, 18 filesystem and six
qualification sentinels. Prepared guest/observer images were removed and borrowed images
preserved.
This live-file row does not qualify restricted HTTPS or preserving
transfers or add a model, account, billing or application claim.

Desktop MS004 native N2 and AVF/Rosetta R1 each passed all 136 installed preserving-transfer
cases on the exact `packed-ms004-r2` tuple: D08 round trips (12), D09 admission/confinement (84)
and D10 host failures (40), across internal/external APFS and baseline/private-live layouts.
Coverage includes actual empty-workspace admission, raw targets and inert links/cycles, rejection
of escapes/bounds, no-follow behavior, source mutation detection, cancellation, APFS native
representation limits with separate positive controls, and original directory-cleanup-owner retries.
Each row completed case cleanup and removed its observer/prepared images after 230 final-empty
scopes (152 compute, 76 filesystem, two sentinels), preserving borrowed images. Subsequent
host-root cleanup acknowledged eight exact removals with zero unknown outcomes.
The standalone export's `examples/sandbox/HANDOFF.md`, under "Desktop preserving-transfer native
campaigns (2026-10-27)", records all ten archive hashes, controlled source/helper provenance and
complete applicability.
Original N1 remains failed at 124/136 on r1; later error observations do not reconstruct its missing
original exception. Fresh Linux r2 builds/typechecks and 253 Docker, 70 neutral and 73 tooling
tests are source/unit proof, not fresh native Linux qualification. Historical Linux scope remains
unchanged. Restricted HTTPS has the separate MS005 record below; no provider/account, product or fleet
qualification is added.

Desktop MS005 native N12 and Rosetta R2 each passed all 26 restricted-HTTPS/recovery cases with
complete cleanup and 98 final-empty scopes on the exact packed-ms005-r8 composition described
above. MS005 Linux source R3 and installed native R6 separately retain the same r8 archive vector;
R6 passed 46 restricted-network/recovery cases and 378 independent absence observations. This
component evidence retains its original scope; reuse requires exact unchanged runtime/controller
applicability, independently of new archive hashes.

The [public combined example](../../examples/sandbox/combined/README.md) separately passed Desktop
MS006 native N2 and AVF/Rosetta R1 on `packed-ms006-r3`: thirteen cases and 62 final-empty scopes
per profile, with complete row cleanup. The same installed public workflow passed eleven combined
cases on real Linux x64 MS006 R1; its fresh live-files and preserving-transfer rows passed eighteen
and 68 cases, with 43/115/41 final-empty scopes for live/link/combined respectively. Normal and
entered-write cancellation flows join every writer before exact linked export. Seven controller-crash
cuts, fresh-process original/settled checkpoint recovery and same-owner lost-delete-acknowledgement
retry converge without replay. A stable isolated sibling is established before restricted authority
capture and survives the restricted owner’s destruction. The [combined handoff](../../examples/sandbox/HANDOFF.md#desktop-and-linux-combined-native-campaigns-2026-10-27)
records exact tuples, archives and compiled modules. Fresh MS006 Linux network R1 separately passed
46 network/recovery cases and 378 independent absence observations against the same installed
candidate and current controller sources. No publication, account, product or fleet admission follows.

The installed 0.4.5 r5 candidate passed all 46 cases of the MS002 r3 restricted-network/recovery campaign: eight network cases, two admission/identity cases, 28 checkpoint failures, seven lost-create responses and one controller SIGKILL with fresh-process cleanup recovery. Its exact composition is Linux x64, Node 24.18.0 and rootful Docker Engine 29.1.3/API 1.52, with controller and daemon on the same host under caller-owned route quiescence. N01–N05 and R01–R03 passed; R04 covers compute/broker/relay writers and their owned readers. Live filesystem and authentication writers, native-agent proxy/account behavior, Docker Desktop and uncontrolled host routing remain outside this proof. Reachable host/LAN, publicly numbered local and sibling controls establish actual forbidden-destination reachability; metadata and IPv6 address cases establish address denial without asserting remote service availability. The campaign used no credentials or model calls.

Independent cleanup auditing across r1/r2/r3 found all 628 exact resource references absent and all 158 readable writer identities gone. The SIGKILL case separately proves its five observed compute/helper writers and original controller gone, seven-role absence, duplicate cleanup and borrowed-image preservation. Original r1/r2 failures remain retained; qualification-observer repairs preceded the full r3 rerun, with no SDK payload change after r5. The source authority retains the exact MS002 validation and production evidence. Independent Bugbot and exact prepared-image disposal passed before archival; publication remains separate. Private evidence paths are not shipped package dependencies.

The unchanged installed consumer examples separately passed four native scripted tool/cancellation
cases (MS005) and four real API-key tool/cancellation cases (MS006) on Linux x64 / Node 24.18.0 /
Engine 29.1.3 API 1.52. The selected tuples are Claude SDK 0.3.273 / Code 2.1.273 with
`claude-haiku-4-5-20251001`, and Grok Build 1.0.62 with `grok-build-0.1` through stable ACP
`schema-v1.23.0`. Actual tools, known artifacts, separate homes/workspaces and observed children
before cancellation are recorded independently of hermetic tests. Independent review and exact
preparation disposal passed; original failed attempts retain their cleanup and accounting records.

The real account campaign used a qualification-only guest-loopback admission gateway, forwarding
only the selected API key to its real provider over verified TLS through restricted CONNECT. It
qualifies that explicit composition, not a direct-native-endpoint-only path or arbitrary native
settings. It does not prove backend billing, hidden model identity, browser/subscription login,
refresh or Mac behavior. Credentials remain visible to guest code and Docker exec metadata;
private ephemeral homes add no credential vault or hostile-guest spending boundary. The public
package exposes no auth gateway. The standalone source export includes the helper APIs and
consumer-owned Grok/Claude examples; private campaign tooling and reports remain with the source
authority. Its `examples/sandbox/HANDOFF.md` records the migration and remaining platform work.

The following retained baseline evidence belongs to its original 0.4.4 source/package/native identities. Real baseline backend and installed-package evidence covers Linux x86_64, Node 24.18.0, rootful Docker Engine 29.1.3 through API 1.52, cgroup v2/systemd, default seccomp, AppArmor and private cgroup namespaces. It includes descendant containment, memory/PID enforcement, stream limits, cancellation, lost Engine replies, exact-resource cleanup and fresh-controller cleanup recovery. Controller death does not stop compute automatically; restricted helpers additionally fail closed on lost control leases, but that does not by itself prove primary compute stopped. Recovery restores cleanup ownership, never a runnable process or session. Other unrecorded platform/daemon tuples and storage or power-loss recovery remain unqualified.

A separate shared-dataset campaign passes on the same Linux/Node/kernel tuple using official Docker Engine 29.1.4 (`08440b6`), containerd 2.2.2, runc 1.3.4 and the overlayfs containerd image store. Six native source scenarios and the installed public dataset example prove exact shared content, actual read-only mounts, private writable workspaces, sibling survival, specific image-path confinement, unsupported-quota rejection and cleanup recovery. Seven independently observed compute scopes are empty after cleanup. This qualifies the recorded dataset composition; mount identity does not measure physical block deduplication. The original 29.1.3 baseline remains independently qualified.

The separate 2026-10-26 Mac baseline used M3/macOS 26.5.1 (25F80), Darwin arm64 Node 24.18.0,
pnpm 11.7.0 and Docker Desktop 4.54.0 with Engine 29.1.2 (`de45c2a`)/API 1.52,
kernel 6.12.54-linuxkit, an arm64 daemon and cgroup v2/cgroupfs. Apple Virtualization and Rosetta
were enabled, ECI disabled, with a qualification budget of four CPUs and 6,144 MiB VM memory.
Runtime freeze `aa1a40ddba7b4854abc4c01cba04de41a6658f46` produced the exact ten-package
`packed-r2` 0.4.5 archives; fixture freeze `b35c4a4ea3a75cd040d54872f414dfc679eac84b`
retained those runtime bytes. Native arm64 and AVF/Rosetta amd64 each passed all 30 source checks
without skips and the installed two-turn controlled ACP example. Each row independently verified
114 resource references absent, 34 compute scopes empty and 70 known PID/start identities absent.
The native-arm64 observer, command owners and samplers settled; prepared images were removed.

The full neutral host suite separately passed 183/183 tests without skips on both internal and
external APFS, including 20,017 real one-byte files, a separate 20,017-entry metadata case and
Darwin lsof/controller-death cleanup. Both volumes rejected the unchanged 3,999-byte raw link
target with native and SDK `ENAMETOOLONG`, with no publication or staging left behind; an
independent 999-byte target published exactly. Native `EILSEQ` rejected malformed filename
creation before SDK traversal while the valid replacement-character sentinel remained unchanged.
Malformed raw link targets still reached SDK rejection. These observations do not establish
3,999-byte APFS publication or a Desktop preserving-transfer capability.

The pinned Linux x86_64 Grok Build 1.0.62 (`1474f9cbdd91`) artifact, 191,715,904 bytes with
SHA-256 `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa`,
passed version/hash verification and eager installed ACP initialization under AVF/Rosetta.
No session, authentication, credential read or model turn entered. All six identified resource
references and four known PID/start identities were absent; both compute scopes were empty with
their final cgroups absent. These Mac
results do not qualify native model/account behavior, Battle Bots/Electron integration, datasets
or large-workspace scale. Current Desktop live-file campaigns use the separate candidate recorded
above. Restricted HTTPS has the separate MS005 record, and preserving transfers have the
separate MS004 native record above.
The standalone export's `examples/sandbox/HANDOFF.md` records all ten archive
hashes and exact source/prepared image IDs; earlier Linux evidence retains its original identities.

Synthetic hermetic tests separately exercise both Desktop admission variants, incompatible
controllers, image/daemon architecture mismatches, missing controllers/security controls and
profile-bound recovery. Those checks do not themselves execute Docker Desktop, arm64 guest code
or Rosetta. The two actual Mac profiles and pinned amd64 Grok row have independent native results.

The retained pre-streaming installed native composition used matching ten-package `0.4.4` candidate artifacts, the ordinary public Node ACP constructor and sandbox bridge, and Grok Build 1.0.62 revision `1474f9cbdd91`. Its Linux amd64 binary SHA-256 was `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa`. With xAI API-key authentication it requested `grok-4.3` and low reasoning. The initialized catalog did not independently identify the backend model; command arguments establish the requested selection only. Those source and tarball identities remain historical evidence; migrating the tooling to streaming transfers records no new model qualification.

Four portable turns covered an exact file task and follow-up in one session, the same first task in fresh isolated compute, storage, home and temporary state, and cancellation after a nonempty native content delta. Six once-only approval responses were delivered. Exact exported bytes matched expectations; each successful SDK close had independently observed compute absence before export, followed by exact retained-resource absence after destruction. This evidence does not qualify other providers or versions, subscription authentication, fleet execution, backend billing, structured output or execution input. Their independent qualification scopes remain unchanged.

A later qualification-controller signal/cancellation repair was verified by a real local child-process regression and a fresh credential-free installed initialization. SDK runtime payloads, native configuration and public examples matched the original four-turn campaign. Authenticated inference was not replayed; those four turns retain their original launcher identity. Hosted Docker CI is configured but has no recorded hosted execution result.

## Run backend checks

Hermetic tests run with `pnpm --filter @agen-ai/sandbox-docker test`. The separately named `test:integration` lane requires explicit `AGENAI_SANDBOX_TEST_ENGINE`, `AGENAI_SANDBOX_TEST_MANIFEST` and `AGENAI_SANDBOX_TEST_OUTPUT` values. Each suite owns a separate child of that fresh output directory. The fixture manifest selects a previously prepared image containing `/usr/local/bin/node` at the recorded version, plus the existing shell utilities. It has no provider/model credentials and makes no inference call. Real-engine evidence establishes only its recorded host/image/configuration tuple.

The integration lane exercises bounded memory/PID exhaustion inside owned containers, lost Engine replies through owned Unix proxies and exact child-controller death. Its independent Linux observer needs read access to the workload keeper's `/proc/<pid>/cgroup` and corresponding `/sys/fs/cgroup` files. It never restarts the shared daemon or performs a broad resource sweep. Reports preserve original failures separately from later cleanup. A fresh process can recover both an identified running workload and a verified resource left in `creating`; the caller must persist any advanced record before cleanup. This qualifies process-crash recovery on the recorded local tuple, not live execution resumption or recovery from storage/power loss.

Candidate recovery uses `agenai.sandbox-recovery.v3`, Linux `engine-1.52-v5-linux-x64` and Desktop `engine-1.52-v6-<profile>` as described above. Changed or legacy configuration cannot adopt a record before Engine effects. Borrowed workload/helper/dataset images never become owned deletion resources, and exact owned-resource cleanup does not require their continued image-store presence.
