# Explicit sandbox workflows

## Shared image dataset example

[`datasets.ts`](datasets.ts) uses two separately owned sandboxes with the same explicitly selected image dataset. The Docker option is `datasets: [{ name, imageDigest, subpath? }]`; each attachment appears read-only at `/datasets/<name>`, outside the private writable workspace. The image must already exist locally under its exact `sha256:` ID. Construction does not pull, create or remove dataset images. Dataset execution additionally requires stable Docker Engine 29.1.4 or newer, `Driver: overlayfs` and the `driver-type=io.containerd.snapshotter.v1` image store; baseline sandbox execution and the ACP example do not select attachments automatically.

The qualification preparation helper adds the fixed 82-byte file `/agenai-qualification-dataset/manifest.txt` and records its digest in `preparation.json.datasetFixture`. It requires the controller's `tar` executable to list and append to the owned filesystem archive. GNU tar is exercised on the recorded Linux lane; actual BSD tar execution on macOS remains part of the pending native platform run. A source image already containing that reserved dataset root is rejected before import. Both the borrowed source image and its existing data remain untouched.

For this small controlled example, add explicit attachment and expected-file fields to the fixture manifest, copying the exact prepared image ID and the preparation's file identity:

```json
{
  "format": "agenai.sandbox-docker-fixture.v1",
  "imageDigest": "sha256:<exact prepared image ID>",
  "user": { "uid": 65534, "gid": 65534 },
  "datasets": [
    {
      "name": "reference",
      "imageDigest": "sha256:<same exact prepared image ID>",
      "subpath": "agenai-qualification-dataset"
    }
  ],
  "datasetFixture": {
    "name": "reference",
    "subpath": "agenai-qualification-dataset",
    "path": "manifest.txt",
    "byteLength": 82,
    "sha256": "<preparation.datasetFixture.sha256>"
  }
}
```

After building the matching packages, run `pnpm exec tsx examples/sandbox/datasets.ts` with the same explicit `AGENAI_SANDBOX_TEST_ENGINE`, `AGENAI_SANDBOX_TEST_PROFILE`, `AGENAI_SANDBOX_TEST_MANIFEST` and fresh `AGENAI_SANDBOX_TEST_OUTPUT` inputs described below. The installed platform consumer emits this entrypoint at `platform-dist/examples/sandbox/datasets.js` for execution with plain Node.

The example hashes the exact file in both sandboxes, rejects file append and sibling creation with `EROFS`, writes different private workspace contents, destroys the first sandbox while the second remains live, and reads the unchanged dataset again. The source file and directory deliberately permit Unix writes so the rejection depends on the actual read-only mount. It destroys both sandbox owners and records exact resource-absence observations under `packed-datasets/report.json`. It grants no physical-storage-sharing claim: identical mount identities and file bytes do not measure image-store deduplication or allocation.

The example requests no workspace disk quota. `policy.workspaceDiskQuota: { kind: "required", bytes, accounting: "allocated_blocks" }` is a separate requirement; the current backend reports it unavailable and rejects it before returning a reservation. No transfer quota, ordinary Docker volume or caller attestation establishes a hard disk quota. Positive project-quota enforcement remains a separately deferred qualification.

## Directory transfers

[`filesystem.ts`](filesystem.ts) exports `roundTripSandboxDirectory` for a borrowed ready sandbox before its first process reservation. It streams an explicit host source directory into the guest workspace, stops the whole compute boundary, and exports the workspace into a newly created output namespace. The published tree is returned as `destination/files`, with separate import and export summaries. This credential-free file workflow launches no agent, makes no model request, and needs only `@agen-ai/sandbox` and its explicit `/node` entrypoint. The caller chooses and retains the backend and sandbox owner.

```ts
import { roundTripSandboxDirectory } from "./filesystem.js";

const result = await roundTripSandboxDirectory(
  sandbox,
  "/absolute/stable-source-directory",
  "/absolute/new-output-namespace",
  { quotas: { maxTotalBytes: 20n * 1024n ** 3n } },
);
console.log(result.directory);
console.log(result.exported.payloadBytes.toString());
```

The source hierarchy must remain stable while it is read, and the destination must initially be absent under a stable parent. Keep the new output namespace exclusive until the helper settles. Symbolic links and special files reject; binary bytes, empty files, executable flags and nested or empty directories are preserved. Other host permissions and ownership are not reproduced, and a live source is not an immutable snapshot: same-length concurrent edits can escape change detection. The example assumes the default 64 KiB transfer chunk buffer. Callers selecting smaller working buffers can use `importSandboxDirectory` directly with a matching `chunkBytes`.

Exports remain private until the complete transfer and its metadata validation succeed. A failed export preserves an existing destination and cleans its owned unpublished staging. Retain `SandboxDirectoryCleanupError` and its `retryCleanup()` owner when filesystem cleanup fails. Its `publishedDirectory`, when present, identifies output already published before a later cleanup failure; retry preserves those files and never replays the transfer. Signal/deadline expiry ends the transfer observation but does not prove that entered filesystem work has finished. The directory helper joins its own sink work and cleanup before completion, while the caller retains sandbox cleanup ownership. This example calls `stop()` and leaves retained sandbox storage available; the caller decides when to call `destroy()`. No transfer deadline is installed unless the caller supplies `deadlineAt`. A supplied absolute deadline applies to both transfer phases; startup and stop retain their independent sandbox observations. Summaries contain bigint counters, so convert selected counters to decimal strings before JSON serialization.

The packed neutral consumer compiles and invokes this exact example outside the source checkout with only the two required packages installed. Its small owned source includes binary, zero-byte and executable files plus nested empty directories. It verifies published bytes and executable flags, existing-destination preservation, no publication after a late backend failure, and explicit sandbox destruction. Node filesystem permissions allow reads only in the retained consumer root and writes only in its owned spill and filesystem fixture roots; process/network effects and optional ACP/Docker packages remain absent. This is installed helper and ownership proof, not large-workspace or native-backend qualification.

The same example module exports `exportSandboxSubtree` for one directory and its descendants. It stops compute before selecting the directory, publishes into a new output namespace, and leaves retained sandbox storage with the caller:

```ts
import { exportSandboxSubtree } from "./filesystem.js";

const result = await exportSandboxSubtree(
  sandbox,
  "reports/selected",
  "/absolute/new-selected-output",
  { quotas: { maxTotalBytes: 32n * 1024n ** 2n } },
);
// Selected content remains under result.directory/reports/selected/.
console.log(result.directory);
```

The public selector is `{ kind: "subtree", path: "reports/selected" }`. It selects one canonical workspace-relative directory, including its root and empty descendants; it preserves workspace-relative output paths rather than flattening the selected directory. Siblings such as `reports/outside.bin` and prefix lookalikes such as `reports/selected-other` are outside that selection. Use `{ kind: "workspace" }` explicitly for the full tree, or `{ kind: "files", paths }` for streamed exact regular-file paths. Exact-file selections reject duplicate paths and regular-file ancestor overlap; subtree selection accepts one root and needs no multiple-root coalescing.

The installed proof invokes this exact function with a nested binary file, a zero-byte file and an empty directory. It verifies the preserved selected root, excludes unrelated siblings, and rejects backend output outside the selected subtree before its body is pulled. An out-of-scope entry following valid selected entries prevents directory publication. These small controlled cases establish public installed composition and provisional publication; backend containment and proportional selective I/O require their separately recorded native qualification.

## Sandbox ACP example

This unpublished `0.4.4` example uses the public sandbox, Docker backend and Node ACP entrypoints. It performs two controlled turns in one SDK session on one native connection/process, imports regular files, rejects guest requests for host filesystem access, closes the SDK before exporting a selected artifact, and destroys retained storage. It uses a synthetic guest peer, makes no model request and reads no provider credentials. Build matching candidate packages first with `pnpm build`.

The Docker constructor accepts an explicit `profile`, also selected by this example's `AGENAI_SANDBOX_TEST_PROFILE`. Omission preserves `linux-x64`; it does not detect Desktop or select an emulator.

| Profile | Controller / daemon / image | Required caller selection |
| --- | --- | --- |
| `linux-x64` | Linux x64 / Linux amd64 / Linux amd64 | Existing rootful Engine profile |
| `desktop-apple-virtualization-native-arm64` | Darwin arm64 / Linux arm64 Docker Desktop / Linux arm64 | Apple Virtualization framework, native guest, ECI disabled |
| `desktop-apple-virtualization-rosetta-amd64` | Darwin arm64 / Linux arm64 Docker Desktop / Linux amd64 | Apple Virtualization framework with its Rosetta amd64 setting, ECI disabled |

These are closed admission choices, not positive native Mac qualification claims. Constructors and reservations are inert; startup and reconciliation reject an incompatible real controller before spill acquisition or Engine requests. Each profile has its own backend revision, so recovery must use the original profile, endpoint, namespace and image. Desktop profile names assert the caller's chosen VMM/emulation settings; the Engine API does not independently attest those settings. Preserve their version-specific configuration evidence. The SDK never changes Desktop settings, installs Rosetta, reads a Docker context or pulls a missing image. Linux controller `/proc` observations cannot establish processes or cgroups inside the Desktop VM.

Actual Apple Silicon runs remain pending. Run native Linux arm64 first. The separately required retained Grok Build `1.0.62` guest is Linux x86_64, SHA-256 `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa`; its initialization/cleanup needs the distinct amd64 image and AVF/Rosetta row. An arm64 synthetic peer does not qualify that artifact, and the existence of a separately advertised arm64 download does not verify its payload. Other VMMs, Intel Mac and ECI remain separate unqualified extensions. The baseline requests no hard workspace quota and has no XFS prerequisite.

Docker documents Rosetta as an [Apple Virtualization framework setting](https://docs.docker.com/desktop/settings-and-maintenance/settings/); [Docker VMM currently has no Rosetta support](https://docs.docker.com/desktop/features/vmm/). Record the installed Desktop version rather than inferring behavior from the VMM name. For a Mac endpoint, explicitly choose the inspected existing socket, commonly `unix://<absolute-user-home>/.docker/run/docker.sock`; Docker's [permission documentation](https://docs.docker.com/desktop/setup/install/mac-permission-requirements/) explains that `/var/run/docker.sock` is an optional symlink. No socket symlink or Desktop setting change is necessary for this SDK.

Use an image matching the selected profile and the recorded Engine API 1.52 contract described in `@agen-ai/sandbox-docker`. Prepare a compatible trusted image separately: it must contain `/usr/local/bin/node`, `/bin/sh` and the required shell utilities, support the non-root read-only-root profile, and declare no volumes. Its environment metadata must contain no variables beyond the backend's fixed `HOME=/home/sandbox`, `TMPDIR=/tmp`, and `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, with those exact values when present. An ordinary official Node image includes additional `NODE_VERSION` and `YARN_VERSION` metadata and needs explicit preparation.

The explicit preparation helper accepts an exact already-present local Linux image ID and `--architecture amd64|arm64`, which must match the selected guest profile. It exports and imports its filesystem with clean metadata, retains the prepared image, and writes its exact image ID in `preparation.json` and standard output. Supply `--source-image` explicitly for this Node example; the helper's historical default image does not contain Node. It never pulls an image or starts the preparation container. The following command is the Linux row; Desktop qualification uses its separately selected platform lane and matching images:

```sh
node scripts/development/agent-sandbox-qualification/prepare-fixture.mjs \
  --engine unix:///var/run/docker.sock \
  --source-image sha256:<exact-local-source-image-ID> \
  --output /absolute/new-preparation-directory
```

Image preparation is a caller-owned operation. The SDK performs no image pull, build, installation, or environment normalization. Select the prepared image's exact existing local ID in an explicit manifest:

```json
{
  "format": "agenai.sandbox-docker-fixture.v1",
  "imageDigest": "sha256:<64 lowercase hexadecimal characters>",
  "user": { "uid": 65534, "gid": 65534 }
}
```

Run from the standalone SDK with absolute paths and a fresh output directory:

```sh
AGENAI_SANDBOX_TEST_ENGINE=unix:///var/run/docker.sock \
AGENAI_SANDBOX_TEST_PROFILE=linux-x64 \
AGENAI_SANDBOX_TEST_MANIFEST=/absolute/fixture-manifest.json \
AGENAI_SANDBOX_TEST_OUTPUT=/absolute/fresh-output \
pnpm examples:sandbox
```

`pnpm test:sandbox-consumer` first runs the complete packed consumer regression outside the checkout, then runs this same example from that installed consumer. Supply `--consumer /absolute/retained-proof/consumer` to reuse a previously retained complete packed proof. A selected real lane fails if its environment, daemon or image is missing; the ordinary packed consumer proof needs none of them.

For a fresh portable sandbox consumer from the standalone SDK, use `pnpm test:sandbox-platform-consumer --output /absolute/new-packed-root`. This explicit mode builds and inspects the same complete ten-package tarball set, installs it on the current controller, typechecks the public examples/session helper, runs the neutral filesystem proof and verifies inert profile construction plus wrong-controller rejection under filesystem permissions. It retains the installed consumer at `/absolute/new-packed-root/consumer`. It does not run the full SDK's unrelated Linux/private-harness rows or native Docker qualification. The default `full` consumer remains unchanged; no row is silently skipped based on OS. Do not transplant Linux `node_modules` to a Mac or treat this portable preparation as a successful Mac execution row.

Both packed consumer profiles also compile the sandbox example modules into the retained consumer's `platform-dist/examples/sandbox/` directory and copy the controlled `peer.mjs` beside them. The platform qualification launcher runs `node platform-dist/examples/sandbox/docker.js` from that consumer. This prepared JavaScript path keeps the qualification controller free of TypeScript loader helper processes while preserving the source example's normal TypeScript development command.

[`policy.ts`](policy.ts) supplies explicit resource, tmpfs, network, execution, startup/cleanup and stream policy, plus fixed transfer working buffers. [`configuration.ts`](configuration.ts) validates the caller's endpoint, manifest and output inputs. The Docker constructor receives the example's canonical owned output directory as its explicit `spillDirectory`; anonymous metadata files are created there and unlinked before data is written. The SDK does not choose a spill directory from environment or home paths. Transfer quotas are separate caller choices and do not establish a workspace disk quota. Docker controller access remains powerful host authority. The guest receives neither its socket nor host mounts. The ACP bridge returns an empty host facility object; this example grants no host filesystem, terminal, browser, MCP or runtime host-binding authority. Separately supplied host callbacks, MCP servers or runtime host bindings retain their caller's authority rather than becoming guest effects.

The smoke example deliberately selects `execution: { kind: "deadline", timeoutMs: 60_000 }`. That finite budget starts when its process startup enters. Applications choose their own execution lifetime:

- Omit `policy.execution` from a `SandboxRequestInput` to keep execution available until the application stops or destroys its sandbox.
- Set `execution: { kind: "until_stopped" }` for the same explicit choice.
- Set `execution: { kind: "deadline", timeoutMs: 86_400_000 }` for an explicit one-day budget. Any positive safe integer in milliseconds is supported; execution has no SDK business-duration ceiling.

Parsed `SandboxRequest` values always include the normalized execution policy. Startup and cleanup retain separate bounded observations: this example selects 60 seconds and 30 seconds respectively. Streaming transfers have no implicit whole-operation deadline. This smoke caller explicitly chooses a fresh 60-second `deadlineAt` for each import/export; the reusable session helper installs no transfer timer when its caller omits that choice. CPU, memory, PID and explicit temporary-storage sizes still apply with `until_stopped`; stream staging and transfer working buffers remain bounded. Optional cumulative stream and transfer quotas belong to the application. The caller must retain its live owner and close it. This policy does not keep a controller alive or recover a runnable connection after a controller crash. The installed neutral consumer exercises both omitted execution and explicit `until_stopped` through binary streams, streaming file export and destruction.

[`session.ts`](session.ts) is the reusable lifecycle for a separately prepared native ACP agent. `withSandboxAcpSession` and `SandboxAcpSessionError` are exports of this example source, not npm package APIs. Call the helper with an explicit backend, request, recovery policy, streaming `entries`, launch recipe and native mapping options; perform turns inside its callback. `fileFromBytes` borrows small caller-owned input arrays and yields bounded views; keep those bytes unchanged until import settles. Select `exportPaths` and a required `maxExportBytes` for small collected results. [`collect.ts`](collect.ts) consumes `exportTree` callbacks with that aggregate byte budget and the explicit path count, copies each admitted body chunk, and returns files only after the complete transfer succeeds. Its output arrays are a caller-bounded example convenience; large consumers should stream to their own provisional sink or staged destination. The helper's optional `transferOptions(operation)` callback lets a caller select cancellation or a fresh absolute deadline for each phase.

The launch callback receives the authoritative guest workspace. Use that returned workspace for launch and session opening; guest paths grant no host filesystem authority. Native image compatibility, authentication, provider mapping and model qualification require separate evidence. Selecting outbound networking grants broad reachable host/LAN/internet access and supplies no destination allowlist. Any explicit guest credentials are readable by guest code and the trusted Docker controller.

The helper retains its reservation before startup and finishes imports before process reservation. Provider materialization eagerly initializes the one native connection and can start its process before a session opens. Keep the registry or materialized instance even if opening fails. One session can run multiple turns; a second connection/session or authentication reconnect requires a fresh sandbox. The helper closes the SDK and joins whole-compute stop and streams before export, then destroys retained resources. `SandboxAcpSessionError` retains the original primary failure, cleanup failures, sandbox owner and explicit `retryCleanup()` closure. Failed opening cleanup and failed close are not automatically retried. The closure retains the exact public native cleanup handle, session and registry where needed; a later successful retry never erases the original errors. Keep that live error with its controller until cleanup succeeds; JSON evidence cannot replace its retry authority.

Persisted recovery checkpoints use a caller-owned file and precede resource effects. This example atomically renames each checkpoint; applications that need power-loss durability must additionally synchronize the file and directory. A recovery record alone authorizes no mutation: recovery requires the original explicit backend configuration, namespace and image plus a quiescent prior controller. It restores cleanup ownership, never a runnable connection or an automatic command replay.

`packed-sandbox/report.json` records the image and daemon tuple, guest artifact digest, independent compute absence before export and independent resource absence after destroy. It preserves the original workflow failure separately from cleanup and evidence-write failures. Real-engine evidence applies only to the recorded tuple.

The retained pre-streaming installed native qualification used Grok Build 1.0.62 with API-key authentication and four turns on the exact [Docker qualification tuple](../../packages/sandbox-docker/README.md#qualification-scope). That historical evidence covers exact task/follow-up artifacts, a fresh isolated repeat and cancellation after observed native output on its recorded source and tarballs. It does not qualify the revised streaming implementation, turn this synthetic example into a model test or qualify other providers, subscription authentication, fleet execution or billing. Hosted Docker CI is configured but has no recorded hosted execution result.
