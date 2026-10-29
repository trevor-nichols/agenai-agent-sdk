# Explicit sandbox workflows

Current example source targets the matching unpublished **0.4.7 candidate**. Use its reviewed
source/local archives together; published npm 0.4.6 users retain the matching `v0.4.6` examples.
The existing peer/directory/dataset workflows below remain explicit baseline compositions.
Their historical 0.4.4 native reports do not certify changed candidate bytes. Recovery now uses
v3 with Linux `engine-1.52-v5-linux-x64` and Desktop `engine-1.52-v6-*` revisions; read the
[candidate upgrade guide](../../UPGRADING-TO-0.4.7.md) and the [0.4.5 recovery migration guide](../../UPGRADING-TO-0.4.5.md) before changing controllers.

The [recorded Mac baseline](HANDOFF.md#recorded-mac-baseline-2026-10-26) covers the exact
unpublished `packed-r2` candidate on M3/macOS 26.5.1, Node 24.18.0 and Docker Desktop 4.54.0 /
Engine 29.1.2. Native arm64 and AVF/Rosetta amd64 each passed 30 source checks and the installed
two-turn controlled ACP example; internal and external APFS each passed all 183 host tests without
skips. Pinned Grok 1.0.62 passed version/hash and eager initialization only. Desktop live files
have [separate native results](HANDOFF.md#desktop-live-files-native-campaigns-2026-10-26).
Current source also admits opt-in `preserve_internal` on both Desktop profiles; the separate
[MS004 r2 campaigns](HANDOFF.md#desktop-preserving-transfer-native-campaigns-2026-10-27)
passed all 136 cases per profile across both APFS roots and workspace layouts, with complete
cleanup and 230 final-empty scopes each, on the recorded archive/controller/helper tuple.
Desktop restricted HTTPS has the [separate MS005 N12/R2 record](HANDOFF.md#desktop-restricted-https-native-campaigns-2026-10-27). Mac datasets, large-workspace
scale and Battle Bots/Electron integration remain unqualified. Supplied API-key native tasks have
the separate [0.4.6 credential record](HANDOFF.md#credential-reuse-native-campaigns-2026-10-28).

## Explicit supplied credentials

The unreleased credential-reuse work supplies deliberately selected credentials to
the caller's prepared native workload. The generic sandbox does not discover local
logins, start a login flow, select a funding route or synchronize refreshed tokens.
Each example constructs its environment from fixed recipe values and one captured
credential; there is no ambient environment merge or automatic fallback.

| Example | Selected native composition | Supplied route |
| --- | --- | --- |
| [Claude](claude/README.md) | Agent SDK 0.3.273 / Code 2.1.273 | Explicit Anthropic API key, existing OAuth token or selected native saved account |
| [Codex](codex/README.md) | Codex 0.163.0 CLI `exec` | Explicit OpenAI API key or caller-selected ChatGPT-native `auth.json`, with access-only or quiescent refresh ownership |
| [Grok](grok/README.md) | Grok Build 1.0.62 / stable ACP schema-v1.23.0 | Explicit xAI API key or selected native first-party saved account |
| [OpenCode](opencode/README.md) | OpenCode V2 2.1.2 standalone JSON CLI | API key or selected native OAuth export; explicit provider/model; legacy Anthropic key call retained |
| [Cursor](cursor/README.md) | Cursor CLI 2026.10.22-27dcf5f | API key, existing account token or selected native account file; explicit model |

The [shared CLI workflow](credentials/README.md) drains one stdout reader and a
separate bounded stderr stream, retains the actual leader receipt, stops the whole
sandbox before returning and preserves retry ownership if cleanup fails. It retains
no raw diagnostics. A zero exit is a process observation; it does not independently
prove authentication, billing or the requested artifact's correctness.

Recipe preflight contains only declared nonsecret route information. The caller
must verify its concrete image, executable, platform and launcher assets during
explicit preparation; an abstract borrowed sandbox cannot attest those identities.
The [0.4.6 follow-up](HANDOFF.md#credential-reuse-native-campaigns-2026-10-28) passed twenty API-key
rows: five providers, each with a normal task and cancellation on Linux x64 and Docker Desktop
native arm64. Cancellation requires observed native entry before abort and a cancelled settlement;
cleanup requires explicit Engine 404 responses for the original resource identities. These results
apply to the recorded archives, examples, native inputs and controller tuples. Static preflight
labels retain their historical meaning and do not attest a caller's sandbox or credentials.

That historical record deferred all four Codex saved-auth rows. The [authentication parity campaign](HANDOFF.md#authentication-parity-native-campaigns-2026-10-28) now passes all forty required key/account normal and entered-cancellation cases across all five harnesses on Linux x64 and native-arm64 Desktop, using existing access tokens without sharing refresh authority. The predecessor's
twenty-four reported passes remain historical: fixed-delay cancellation and failed `docker inspect`
commands did not establish the follow-up's entry and absence guarantees. Codex's file route remains
an explicit source-copy mechanism using the public Node bootstrap; its temporary copy stays outside
workspace exports and refreshed state is never written back to the source.

## Restricted network composition

The current Docker candidate accepts explicitly prepared Linux x64 and admitted Apple
Virtualization Desktop restricted HTTPS infrastructure, with platform-specific original authority
handles and prepared helpers. The [Docker construction guide](../../packages/sandbox-docker/README.md#restricted-https-egress)
documents inert `/node` helper-context preparation, the caller's explicit local legacy build,
opaque pinned route authority, separate helper budgets and exact destination policy. Desktop
requires its additional Darwin host executable and native arm64 VM observer image. The caller
owns route/interface/VPN/Engine/proxy/interception quiescence and supplies a client that uses the loopback
`HTTPS_PROXY`/`HTTP_PROXY` endpoint. Baseline examples do not enable this configuration implicitly.

The broker restricts CONNECT hostname/port and resolved addresses; it tunnels bytes without
TLS termination/validation. Clients authenticate the TLS endpoint, and an allowed service may
still relay data. There is no HTTP-path policy or secrecy from guest-readable credentials.
Infrastructure loss fences admission and enters whole-sandbox stop. Linux qualification separately
proved restricted network enforcement, live files, confined link transfers, the exact Claude/Grok
bridges, and four real API-key tool/cancellation cases. The API-key cases used a qualification-only
loopback admission gateway; they do not qualify every endpoint/client/account configuration.
See [HANDOFF.md](HANDOFF.md) for the exact tuple, shipped assets, separate Desktop component records
and separate combined Desktop/Linux results. Application adoption remains separate. Private capability and paid-account campaign
tooling is not part of this standalone source export; the public helpers and examples are the
reusable assembly.

## Combined public workflow

The [combined example](combined/README.md) uses one fixed credential-free Node program and public
sandbox APIs for actually empty linked-tree import, live read/write while the program runs,
certificate-verified restricted HTTPS, denial of a separately reachable explicit target, normal
completion or entered-write/process cancellation, stopped preserving export and destruction.
It requires explicit caller backend/images/prepared authority, request policy, owned host
destination and recovery persistence. It supplies no provider/account or business-policy defaults.
The portable consumer compiles the same entrypoint used by the generic platform `combined` row.
Desktop MS006 native N2 and Rosetta R1 each passed thirteen installed cases and 62 final-empty
scopes on packed-ms006-r3. Real Linux x64 R1 passed eleven combined cases and fresh eighteen-case
live-file and 68-case preserving-transfer rows, with complete row cleanup. Fresh Linux network R1
separately passed 46 network/recovery cases and 378 independent absence observations on the current
installed candidate. Exact identities are in the [combined record](HANDOFF.md#desktop-and-linux-combined-native-campaigns-2026-10-27).

## Shared image dataset example

[`datasets.ts`](datasets.ts) uses two separately owned sandboxes with the same explicitly selected image dataset. The Docker option is `datasets: [{ name, imageDigest, subpath? }]`; each attachment appears read-only at `/datasets/<name>`, outside the private writable workspace. The image must already exist locally under its exact `sha256:` ID. Construction does not pull, create or remove dataset images. Dataset execution additionally requires stable Docker Engine 29.1.4 or newer, `Driver: overlayfs` and the `driver-type=io.containerd.snapshotter.v1` image store; baseline sandbox execution and the ACP example do not select attachments automatically.

The qualification preparation helper adds the fixed 82-byte file `/agenai-qualification-dataset/manifest.txt` and records its digest in `preparation.json.datasetFixture`. It requires the controller's `tar` executable to list and append to the owned filesystem archive. GNU tar is exercised on the recorded Linux lane; BSD tar image preparation passed in the recorded Mac baseline rows. That preparation does not qualify Mac dataset mounts: Engine 29.1.2 is below their required 29.1.4 minimum, and no Mac dataset row ran. A source image already containing that reserved dataset root is rejected before import. Both the borrowed source image and its existing data remain untouched.

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

The source hierarchy must remain stable while it is read, and the destination must initially be absent under a stable parent. Keep the new output namespace exclusive until the helper settles. Symbolic links reject by default. On a supporting backend with an actually empty workspace, pass `symlinks: 'preserve_internal'` in the same options object to preserve confined raw relative link targets. Special files remain unsupported. Binary bytes, empty files, executable flags and nested or empty directories are preserved. Other host permissions and ownership are not reproduced, and a live source is not an immutable snapshot: same-length concurrent edits can escape change detection. The example assumes the default 64 KiB transfer chunk buffer. Callers selecting smaller working buffers can use `importSandboxDirectory` directly with a matching `chunkBytes`.

Exports remain private until the complete transfer and its metadata validation succeed. A failed export preserves an existing destination and cleans its owned unpublished staging. Retain `SandboxDirectoryCleanupError` and its `retryCleanup()` owner when filesystem cleanup fails. Its `publishedDirectory`, when present, identifies output already published before a later cleanup failure; retry preserves those files and never replays the transfer. Signal/deadline expiry ends the transfer observation but does not prove that entered filesystem work has finished. The directory helper joins its own sink work and cleanup before completion, while the caller retains sandbox cleanup ownership. This example calls `stop()` and leaves retained sandbox storage available; the caller decides when to call `destroy()`. No transfer deadline is installed unless the caller supplies `deadlineAt`. A supplied absolute deadline applies to both transfer phases; startup and stop retain their independent sandbox observations. Summaries contain bigint counters, so convert selected counters to decimal strings before JSON serialization.

The packed neutral consumer compiles and invokes this exact example outside the source checkout with only the two required packages installed. Its regular-file proof verifies binary, zero-byte and executable files, nested empty directories, existing-destination preservation, no publication after a late backend failure and explicit sandbox destruction. Node permissions restrict reads to the retained consumer root and writes to owned spill/filesystem fixtures. A separate preservation proof checks exact raw link targets and publication with the full filesystem permission required by Node 24.18.0's `fs.symlink` API; it still selects only fresh owned fixture paths. Process/network effects and optional ACP/Docker packages remain absent in both invocations. These are installed helper and ownership checks, with separate filesystem-authority scopes, rather than native-backend or large-workspace qualification.

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

## Live observations

Since 0.4.5 the SDK supports explicitly granted `sandbox.files` access through a
separately prepared native Docker helper. Omission grants no live access. Reads
and listings are observations of a changing guest; final artifact export still
requires successful whole-owner stop. The helper keeps its staging directory
outside the guest's mounted workspace and uses the same recovery/cleanup owner.

The [live examples](live/README.md) capture and hash file bytes once, serve later
ranges from that captured copy, and store directory metadata in a disk-backed
generation with bounded pages. They retain scratch cleanup ownership on failure
and reject stale/foreign page generations. The SQLite listing example requires
Node >=22.13; its local observation store is separate from the SDK's Node >=22
runtime requirement. App authorization, filtering, expiry, previews and final
artifact comparison remain caller responsibilities.

Use the [Docker package's helper preparation and grant contract](../../packages/sandbox-docker/README.md)
with an exact already-prepared image. Public imports do not build or pull native
helpers, read credentials or grant host filesystem callbacks. Live access retains
its exact Linux qualification; it remains unsupported on Docker Desktop.

## Sandbox ACP example

This example uses the public sandbox, Docker backend and Node ACP entrypoints. It performs two controlled turns in one SDK session on one native connection/process, imports regular files, rejects guest requests for host filesystem access, closes the SDK before exporting a selected artifact, and destroys retained storage. It uses a synthetic guest peer, makes no model request and reads no provider credentials. Build matching candidate packages first with `pnpm build`.

The Docker constructor accepts an explicit `profile`, also selected by this example's `AGENAI_SANDBOX_TEST_PROFILE`. Omission preserves `linux-x64`; it does not detect Desktop or select an emulator.

| Profile | Controller / daemon / image | Required caller selection |
| --- | --- | --- |
| `linux-x64` | Linux x64 / Linux amd64 / Linux amd64 | Existing rootful Engine profile |
| `desktop-apple-virtualization-native-arm64` | Darwin arm64 / Linux arm64 Docker Desktop / Linux arm64 | Apple Virtualization framework, native guest, ECI disabled |
| `desktop-apple-virtualization-rosetta-amd64` | Darwin arm64 / Linux arm64 Docker Desktop / Linux amd64 | Apple Virtualization framework with its Rosetta amd64 setting, ECI disabled |

These are closed admission choices; native qualification applies only to the recorded tuple and bytes. Constructors and reservations are inert; startup and reconciliation reject an incompatible real controller before spill acquisition or Engine requests. Each profile has its own backend revision, so recovery must use the original profile, endpoint, namespace and image. Desktop profile names assert the caller's chosen VMM/emulation settings; the Engine API does not independently attest those settings. Preserve their version-specific configuration evidence. The SDK never changes Desktop settings, installs Rosetta, reads a Docker context or pulls a missing image. Linux controller `/proc` observations cannot establish processes or cgroups inside the Desktop VM.

The recorded Apple Silicon campaign passed native Linux arm64 before the separate AVF/Rosetta amd64 row, with independent kernel cleanup on both. The retained Grok Build `1.0.62` (`1474f9cbdd91`) Linux x86_64 guest, SHA-256 `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa`, separately passed eager initialization and cleanup in the amd64 image. It opened no session and used no account or model. An arm64 synthetic peer does not qualify that artifact, and a separately advertised arm64 download does not verify its payload. See [HANDOFF.md](HANDOFF.md#recorded-mac-baseline-2026-10-26) for image/archive identities and APFS representation limits. Other VMMs, Intel Mac and ECI remain separate unqualified extensions. The baseline requests no hard workspace quota and has no XFS prerequisite.

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

Two separately selected consumer examples extend that composition. The [Grok client](grok/README.md) uses the public ACP transport directly and grants bounded guest filesystem callbacks to one native session and active turn. It supports a custom client without requiring `provider-acp`. The [Claude example](claude/README.md) implements the exact SDK 0.3.273 spawn contract and admits a closed guest-native configuration. Both are copied example source, not new package entrypoints. Their defaults do not enable arbitrary controller callbacks.

Claude has a private example workspace with its own exact dependency tuple; the history package's independent SDK 0.3.306 qualification is unchanged. In the standalone checkout, `pnpm test:examples:sandbox-bridges` runs the hermetic example tests. The packed consumer compiles Grok under `platform-dist/examples/sandbox/grok` and creates a separate `claude-bridge-consumer` with the packed sandbox/validation archives and exact Claude SDK. Its bridge tests prohibit process and network operations. Those tests establish composition behavior; actual pinned native tool, authentication and platform checks require their separately retained campaigns.

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
