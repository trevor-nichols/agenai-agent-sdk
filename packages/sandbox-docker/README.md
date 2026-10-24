# @agen-ai/sandbox-docker

Explicit local Docker Engine resources for `@agen-ai/sandbox`. The current 0.4.4 candidate implements bounded provisioning, binary process streams, file import, terminal compute removal, retained file export and cleanup-only recovery. The optional `@agen-ai/sandbox/acp` bridge composes these streams with the public Node ACP provider. This candidate is unpublished.

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

`DockerSandboxProfile` is a closed choice of the following compositions. The default `linux-x64` profile preserves the existing Linux admission. Both Desktop profiles are implementation candidates awaiting actual Mac qualification.

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

`isolated` selects Docker `none`. Explicit `outbound` creates a private bridge and permits access to reachable host, LAN and internet services. Neither profile provides a domain allowlist or credential secrecy within the guest. No published ports, privileged mode, devices or arbitrary Docker options are admitted.

`importTree` streams regular files/directories before process reservation. `exportTree` requires stopped compute and a never-started, read-only accessor of the exact private owned volume. Whole-workspace export explicitly streams `/workspace`; exact-file and single-subtree selections check every ancestor with bounded HEAD operations, then GET only the selected file or directory. `{ kind: 'subtree', path: 'artifacts' }` includes that directory and its descendants, preserving workspace-relative paths. The selected root must be a real directory; unrelated entries are not scanned. No unselected root archive is fetched or filtered. The no-writer ownership condition is mandatory; this mechanism does not admit a mutable borrowed workspace.

Archive headers, checksums, local PAX metadata, body lengths, padding and complete termination validate incrementally. Link archive records, special/sparse files, traversal, duplicate paths and conflicting file ancestors reject. A selected regular file may be a hardlink alias within the same private volume: Engine stat has no link count, and a one-file tar emits it as regular bytes. This does not permit symlink traversal. Callback bytes remain provisional until complete operation success.

The initial archive representation supports individual sizes through `8 GiB - 1`; base-256 and PAX size overrides are unsupported. This format boundary is separate from optional caller quotas. Aggregate workspace bytes and file count have no universal SDK ceiling. Streaming HTTP, bounded chunks and external metadata sorting replace complete-body buffers. Connection/header/acknowledgment observations are finite, but no implicit timer covers the complete body; upload acknowledgment begins after the body finishes. Control JSON remains bounded and buffered. `spillDirectory` is explicit host authority; no default home/temp path is discovered.

Reserve one process with an absolute guest executable, literal arguments, explicit environment and the returned guest workspace. Docker exec uses the selected non-root user, no TTY and separate binary stdout/stderr. The backend supplies the fixed HOME, TMPDIR and PATH above; conflicting overrides fail during inert reservation. Other explicit process environment values are passed literally. Credentials supplied in that environment are readable by guest code and the trusted Docker controller. Image preparation and credential selection remain the caller's responsibility.

The process exit receipt describes the leader only. Descendants and the keeper remain owned until `stop()` removes the whole workload. If compute removal prevents observing leader status, exit reports `unavailable` with reason `sandbox_stopped`. An observed exit receipt never changes. Stdin supports backpressure and half-close; abandoning an output reader, malformed framing, output overflow or an explicitly selected execution deadline initiates whole-sandbox stop. Startup and cleanup do not replay exec requests.

Sandbox `policy.execution` defaults to `{ kind: 'until_stopped' }`, which installs no execution or idle timer. Select `{ kind: 'deadline', timeoutMs }` explicitly for a finite process lifetime; positive safe-integer millisecond values support days and durations beyond Node's single-timer range. CPU, memory, PID and working buffers remain independent. `deadlines.startupMs` and `cleanupMs` govern infrastructure observations; each transfer can opt into `deadlineAt` and logical quotas without a default transfer lifetime. See the [neutral policy contract](../sandbox/README.md#explicit-policy-and-finite-values) for timing scope and migration from the retired `deadlines.executionMs` field.

Docker can acknowledge the stream upgrade before the exec starts. A non-running exec with a null exit code remains pending under the selected execution policy; only a non-running exec with a numeric exit code yields an exit receipt.

`maxBufferedOutputBytes` bounds the combined public stdout/stderr staging. Docker additionally bounds its accepted upgrade head to 64 KiB, current receive chunk to 64 KiB, partial frame header to 8 bytes and each raw output channel to one selected-high-water-mark chunk (at most 64 KiB each). This permits at most 256 KiB + 8 bytes of additional library-owned framing/output staging at maximum settings, plus Node socket/kernel buffers and object metadata. Frame declarations above 1 MiB fail before payload retention; a complete frame is never allocated solely from that declaration. These are staging bounds, not a total heap cap.

`stop()` permanently force-removes the exact workload container ID and retains the volume and accessor. `destroy()` additionally removes the exact accessor, volume and optional network, and can be retried after partial failure. There is no broad prune, label scan, automatic command replay or known-ID fallback to a name. Startup cancellation joins entered acquisition. The original owner can complete cleanup when cancellation or failed persistence prevented a create from being dispatched. A dispatched create with an unresolved outcome, or a recovered `creating` checkpoint, remains uncertain when its resource name is absent.

The optional `@agen-ai/sandbox/acp` bridge uses this one process for one initialized native connection and one SDK session, which can run multiple turns. Provider materialization is eager and can start the process before session opening. Retain and dispose the registry or instance even if opening never succeeds. Connection release stops the whole compute workload and joins its streams while retaining files. Close the SDK, export selected artifacts, then destroy retained resources. The bridge disables host facilities; supplying additional host callbacks, MCP servers or runtime host bindings separately grants the caller's own host authority. The [example lifecycle helper](../../examples/sandbox/session.ts) implements this ownership sequence and retains exact cleanup retry handles; it is example source, not a package export.

## Cleanup-only recovery

Recovery records carry fixed non-secret operation, profile, daemon, image and resource identities. Backend revisions are `engine-1.52-v4-<profile>` and recovery v2 binds the normalized profile, non-root user, workload image and dataset attachments in `configurationDigest`; `policyDigest` binds request policy separately. Earlier revisions and other selected profiles conflict even for reserved records, before Engine access. Persisted checkpoints precede resource effects and record inspected IDs before later effects. Resource labels bind the complete original immutable record, and reconciliation checks exact names, labels and configuration fingerprints against the explicit profile/namespace/image/daemon. Daemon admission is repeated before resource operations and cleanup; a changed profile or daemon retains cleanup ownership without acting on resources. Reconciliation returns cleanup ownership only. A planned resource is never adopted; unknown acquisition outcomes retain their retry owner.

Recover from the latest durable record only after the previous controller and its entered operations are quiescent. A stale planned record conflicts when its exact resource name is already present, including when that name belongs to a foreign resource. If reconciliation advances a `creating` identity to an inspected ID, persist the returned `owner.recoveryRecord` before invoking cleanup; reconciliation does not write to the caller's persistence store.

## Qualification scope

Real backend and installed-package evidence covers Linux x86_64, Node 24.18.0, rootful Docker Engine 29.1.3 through API 1.52, cgroup v2/systemd, default seccomp, AppArmor and private cgroup namespaces. It includes descendant containment, memory/PID enforcement, stream limits, cancellation, lost Engine replies, exact-resource cleanup and fresh-controller cleanup recovery. Controller death does not stop compute automatically; recovery restores cleanup ownership, never a runnable process or session. Other unrecorded platform/daemon tuples and storage or power-loss recovery remain unqualified.

A separate shared-dataset campaign passes on the same Linux/Node/kernel tuple using official Docker Engine 29.1.4 (`08440b6`), containerd 2.2.2, runc 1.3.4 and the overlayfs containerd image store. Six native source scenarios and the installed public dataset example prove exact shared content, actual read-only mounts, private writable workspaces, sibling survival, specific image-path confinement, unsupported-quota rejection and cleanup recovery. Seven independently observed compute scopes are empty after cleanup. This qualifies the recorded dataset composition; mount identity does not measure physical block deduplication. The original 29.1.3 baseline remains independently qualified.

Synthetic hermetic tests exercise both Desktop admission variants, incompatible controllers, image/daemon architecture mismatches, missing controllers/security controls and profile-bound recovery. These tests do not run Docker Desktop, arm64 guest code or Rosetta. Actual Apple Silicon native arm64 and the required AVF/Rosetta amd64 harness rows remain pending the separate Mac handoff. An independently successful native arm64 row would not qualify an amd64-only harness.

The retained pre-streaming installed native composition used matching ten-package `0.4.4` candidate artifacts, the ordinary public Node ACP constructor and sandbox bridge, and Grok Build 1.0.62 revision `1474f9cbdd91`. Its Linux amd64 binary SHA-256 was `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa`. With xAI API-key authentication it requested `grok-4.3` and low reasoning. The initialized catalog did not independently identify the backend model; command arguments establish the requested selection only. Those source and tarball identities remain historical evidence; migrating the tooling to streaming transfers records no new model qualification.

Four portable turns covered an exact file task and follow-up in one session, the same first task in fresh isolated compute, storage, home and temporary state, and cancellation after a nonempty native content delta. Six once-only approval responses were delivered. Exact exported bytes matched expectations; each successful SDK close had independently observed compute absence before export, followed by exact retained-resource absence after destruction. This evidence does not qualify other providers or versions, subscription authentication, fleet execution, backend billing, structured output or execution input. Their independent qualification scopes remain unchanged.

A later qualification-controller signal/cancellation repair was verified by a real local child-process regression and a fresh credential-free installed initialization. SDK runtime payloads, native configuration and public examples matched the original four-turn campaign. Authenticated inference was not replayed; those four turns retain their original launcher identity. Hosted Docker CI is configured but has no recorded hosted execution result.

## Run backend checks

Hermetic tests run with `pnpm --filter @agen-ai/sandbox-docker test`. The separately named `test:integration` lane requires explicit `AGENAI_SANDBOX_TEST_ENGINE`, `AGENAI_SANDBOX_TEST_MANIFEST` and `AGENAI_SANDBOX_TEST_OUTPUT` values. Each suite owns a separate child of that fresh output directory. The fixture manifest selects a previously prepared image containing `/usr/local/bin/node` at the recorded version, plus the existing shell utilities. It has no provider/model credentials and makes no inference call. Real-engine evidence establishes only its recorded host/image/configuration tuple.

The integration lane exercises bounded memory/PID exhaustion inside owned containers, lost Engine replies through owned Unix proxies and exact child-controller death. Its independent Linux observer needs read access to the workload keeper's `/proc/<pid>/cgroup` and corresponding `/sys/fs/cgroup` files. It never restarts the shared daemon or performs a broad resource sweep. Reports preserve original failures separately from later cleanup. A fresh process can recover both an identified running workload and a verified resource left in `creating`; the caller must persist any advanced record before cleanup. This qualifies process-crash recovery on the recorded local tuple, not live execution resumption or recovery from storage/power loss.

Recovery uses `agenai.sandbox-recovery.v2` and `engine-1.52-v4-<profile>`. Its immutable `configurationDigest` binds the normalized profile, non-root identity, workload image and sorted dataset configuration separately from `policyDigest`. Changed or legacy configuration cannot adopt a record before Engine effects. Borrowed dataset images never become owned deletion resources, and exact owned-container cleanup does not require the dataset image to remain available.
