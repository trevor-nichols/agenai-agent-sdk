# Explicit Docker platform verification

This credential-free lane verifies one selected controller, daemon, image and profile. The SDK
has recorded Linux x64 evidence. Its Apple Virtualization native-arm64 and Rosetta-amd64
profiles are implemented candidates; **actual Mac verification is pending**. Linux fixtures,
synthetic admission and installed configuration checks do not establish native Mac support.

Use native Node **24.18.0**, pnpm **11.7.0**, an existing local Engine exposing API 1.52 or later,
and exact already-present Linux Node 24.18.0 source image IDs. The guest source must match the
profile's image architecture. The observer source must match the **daemon's native** architecture:
on Apple Silicon it remains arm64 even when the selected guest image is amd64. Images are
prepared into separately owned clean fixture images and removed afterward. The selected source
images are borrowed and preserved. The runner never pulls an image or changes Docker settings.

Preparation invokes the selected existing `docker` CLI and `tar` through `PATH`. On a Mac,
put the explicitly selected Docker application's CLI directory first rather than depending on
an optional system symlink. Record that CLI path and `tar --version`; preparation lists and
appends the small fixed dataset fixture for every row. GNU tar is recorded on Linux, while
actual Mac BSD tar execution remains pending. The host spill proof also requires the existing
`/usr/sbin/lsof`; it is separate from the daemon-side kernel observer.

| Profile | Controller | Linux daemon | Guest image | Settings supplied explicitly |
| --- | --- | --- | --- | --- |
| `linux-x64` | Linux x64 | amd64 | amd64 | Existing rootful systemd/cgroup-v2/AppArmor profile |
| `desktop-apple-virtualization-native-arm64` | macOS arm64 | arm64 | arm64 | Apple Virtualization framework; ECI disabled |
| `desktop-apple-virtualization-rosetta-amd64` | macOS arm64 | arm64 | amd64 | Apple Virtualization framework; Rosetta enabled; ECI disabled |

Desktop's VMM, Rosetta and ECI fields are caller assertions, recorded separately from Engine
observations. The runner reads the version from the explicitly selected application plist with
`/usr/libexec/PlistBuddy`; it does not discover applications or settings. Docker VMM, Intel Macs,
native Windows, ECI and alternate emulators remain outside the admitted profiles. CPU, memory,
PID and native storage prerequisites must be available in the selected VM; do not weaken tests
when a prerequisite is missing.

## Prepare a fresh installed consumer

From the private monorepo:

```sh
pnpm test:agent-sdk-sandbox-platform-consumer --output /absolute/new-packed-root
```

From a governed standalone SDK export:

```sh
pnpm test:sandbox-platform-consumer --output /absolute/new-packed-root
```

This explicit portable lane builds and inspects the same ten-package candidate, performs a
fresh local installation, compiles the public examples and session helper, and runs neutral
filesystem plus inert platform checks. Its consumer is `/absolute/new-packed-root/consumer`.
The sandbox examples are emitted under `consumer/platform-dist/examples/sandbox`, with the
controlled peer copied beside them. Native qualification runs these artifacts with plain Node,
so a development-time TypeScript loader cannot leave a helper in the observed controller group.
The default full consumer retains all its existing Linux checks. Do not copy Linux
`node_modules` to a Mac or count portable preparation as native execution.

## Select and record the tuple

Create a bounded JSON manifest with the exact fields below. Replace every example identity
with the selected machine's actual values; `expected` values must match live observations.
Use a physical Unix socket, such as the explicit per-user Desktop socket, rather than relying
on an automatically selected context or optional default-socket symlink.

```json
{
  "format": "agenai.sandbox-platform-manifest.v1",
  "engine": "unix:///absolute/user/.docker/run/docker.sock",
  "profile": "desktop-apple-virtualization-native-arm64",
  "sourceImage": "sha256:<64 lowercase hex digits for arm64 Node source>",
  "observerImage": "sha256:<64 lowercase hex digits for native arm64 Node source>",
  "expected": {
    "controller": { "os": "darwin", "architecture": "arm64", "nodeVersion": "24.18.0" },
    "daemon": {
      "id": "<Engine info ID>",
      "version": "<Engine version>",
      "apiVersion": "<Engine maximum API version>",
      "architecture": "arm64",
      "kernelVersion": "<Engine info KernelVersion>",
      "operatingSystem": "Docker Desktop"
    }
  },
  "desktop": {
    "version": "<installed Desktop application version>",
    "applicationPlist": "/Applications/Docker.app/Contents/Info.plist",
    "vmm": "apple-virtualization",
    "rosetta": false,
    "enhancedContainerIsolation": false
  }
}
```

For Linux, use profile `linux-x64`, controller `linux`/`x64`, daemon `amd64`, exact native
amd64 source images, the observed operating-system string and `"desktop": null`. For the
Rosetta row, select its profile, an exact amd64 guest source and `"rosetta": true`; the daemon
and observer stay arm64. The optional `harness` field is required only for `grok-initialize`:

```json
{
  "path": "/absolute/selected/grok-1.0.62-linux-x86_64",
  "sha256": "2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa"
}
```

The selected artifact is a Linux x86_64 executable. This does not describe every Grok release
as amd64-only or qualify an advertised arm64 alternative. No credentials field is accepted.

## Run independent rows

Private monorepo commands:

```sh
pnpm test:agent-sdk-sandbox-platform --row core --manifest /absolute/native.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/ac-r1
pnpm test:agent-sdk-sandbox-platform --row datasets --manifest /absolute/native.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/ad-r1
pnpm test:agent-sdk-sandbox-platform --row grok-initialize --manifest /absolute/rosetta.json --consumer /absolute/new-packed-root/consumer --output /private/tmp/ag-r1
```

Standalone commands use `pnpm test:sandbox-platform` with the same arguments. Use new, short
absolute output roots with physical canonical parents; `/tmp` is normally an alias on macOS,
so these Mac commands use `/private/tmp`. Before running core, check both
`<output>/kernel.sock` (at most 100 UTF-8 bytes) and
`<output>/source-integration/uncertainty/cleanup-observation-timeout/engine.sock` (fewer than
104 UTF-8 bytes). The launcher checks the outer path; the source fault proxy separately
enforces the deeper path. `core` runs the unchanged
baseline native source scenarios (excluding the separate dataset suite) through the explicit kernel-observer port, then the installed two-turn
controlled ACP example. It covers containment/resource failures, binary streams, cancellation,
lost replies and fresh-controller cleanup recovery. `observer` runs just the installed example
and is a diagnostic subset, not a replacement for `core`. `grok-initialize` imports and hashes
the exact binary, observes its actual version and eagerly initializes the public ACP registry
in fresh isolated workloads. It opens no session, performs no authentication and enters no
model turn. Test command deadlines are qualification budgets, not SDK execution ceilings.

The tooling-only observer container uses the daemon's PID/cgroup view with read-only kernel
mounts, no network, a read-only root, no added capabilities and no privileged flag. It observes
only exact SDK compute admitted through this run's private proxy, selected image and namespace
prefixes. Cgroup/PID/start identities are captured before start acknowledgment, then independently
checked after removal and before disposing the observer. Engine HTTP 404 is additional evidence,
not the kernel proof. No host-PID, host-bind or privilege option is added to the SDK API.

## Evidence, failures and remaining Mac checks

Retain `launcher-report.json`, command logs, `engine-requests.jsonl`, the observer record and
observation log, fixture preparation records, source-test evidence and installed-example or
Grok reports. Each launcher report retains exact installed package hashes. Successful cleanup
must establish guest quiescence, observer removal, prepared-image removal and borrowed-image
survival. A failed row remains failed after successful cleanup.

On failure, retain the exact SDK recovery records. Make the original controller quiescent,
reconcile with the same explicit backend/profile, namespace, image, user and dataset configuration,
and destroy its owned resources. Current records use `agenai.sandbox-recovery.v2`, mandatory
`configurationDigest` and profile-specific `engine-1.52-v4-*` revisions. Old v1 records reject;
do not rewrite them or mix an earlier candidate's package outputs with this source. The observer
retains diagnostic ownership when guest emptiness is unknown; after SDK cleanup, use the
exported tooling `cleanupDaemonObserver({ endpoint, recordPath })` from `observer/index.mjs`
with its exact persisted `observer/record.json`. Do not prune by label, delete borrowed images,
replay uncertain create requests or substitute a privileged observer. The record is a claim
validated against the original configuration and daemon; the returned reconciliation owner
supplies cleanup authority. It does not restore a runnable session.

Actual Mac verification must also run the neutral directory and spill tests on the selected
host filesystem. They check actual case/Unicode aliases, staged publication, cancellation and
local descriptor release/controller death. The daemon-side observer cannot prove Mac host
descriptor cleanup. Record filesystem type/case behavior, exact commands, pass/fail/skip and
retained evidence separately. A skipped or unavailable required native row remains pending.

The explicit `datasets` row independently runs the image-dataset cases, fresh-controller dataset recovery and compiled installed dataset example. Reuse the strict outer platform manifest above; the launcher creates the inner `datasets`/`datasetFixture` inputs from preparation rather than accepting those fields in the platform manifest. Retain `installed-datasets/packed-datasets/report.json` with proof `packed-sandbox-datasets-example` beside the source and observer evidence. The feature requires stable Engine 29.1.4 or newer, `Driver: overlayfs` and the admitted `DriverStatus` marker `['driver-type', 'io.containerd.snapshotter.v1']`; record both driver fields without changing Desktop settings. Engine 29.1.3 has an upstream filename-length bug for full-ID image mounts; baseline `core` does not acquire this dataset-only minimum. The prepared fixture supplies dedicated known bytes with writable Unix permissions, so guest `EROFS` observations establish mount enforcement. Dataset qualification is separate from baseline `core`: absence of image-mount support does not invalidate an independently passing baseline execution tuple. Neither row proves a hard workspace quota; an explicitly required quota must reject before reservation. Positive XFS/allocated-block enforcement remains a separately deferred optional capability, and actual Mac execution remains pending.
