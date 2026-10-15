# @agen-ai/acp-registry

Optional ACP catalog validation, search, immutable planning and verified installation for Node.js 22 or newer.
The coordinated source SDK version is `0.4.1` and remains unpublished; the published
release is `0.4.0`. The package is ESM, MIT licensed and side-effect-free on import.
The metadata graph depends only on `@agen-ai/validation` and exact `zod@4.4.3`. Explicit Node
installation uses pinned tar, ZIP and bzip2 readers. Public contracts are plain TypeScript values
and AgenAI validation issues, with no exposed Zod schemas or Agent Runtime dependency.

## Boundaries

The root parses inert metadata and creates plans. It never fetches, writes files, installs packages,
spawns processes, chooses credentials or activates an agent. `/node` provides explicit bounded
fetching and installation into an explicitly opened owned store. Provider composition, credentials
and process lifetime remain caller-owned.

Catalog labels, licenses, launch metadata and `bundled` flags grant no authority. Digests identify
inputs; they do not authenticate their publisher. Use an independently trusted source and expected
artifact evidence appropriate to your host. A plan's `verified: false` never changes. A separate
installation receipt records verification of its declared obligations against actual artifacts and
toolchains. This source preparation does not publish the package or authorize a host deployment.

## Parse, search and plan

```ts
import {
  createAcpInstallPlan,
  parseAcpRegistrySnapshot,
  searchAcpRegistry,
} from '@agen-ai/acp-registry';

const snapshot = parseAcpRegistrySnapshot({
  source: {
    namespace: 'my-company',
    kind: 'local',
    channel: 'stable',
    location: 'approved-catalog-2026-10-09',
    profile: 'published-v1',
  },
  content: catalogJson, // string or Uint8Array supplied by the caller
});
const [entry] = searchAcpRegistry(snapshot, {
  query: 'coding',
  target: 'linux-x86_64',
  distributionKinds: ['binary'],
});
if (!entry) throw new Error('No approved binary distribution matches.');

const plan = createAcpInstallPlan(snapshot, {
  entryIdentity: entry.identity,
  expectedSnapshotDigest: snapshot.digest,
  expectedEntryDigest: entry.digest,
  target: 'linux-x86_64',
  distributionPreference: ['binary'],
  policy: {
    network: 'offline',
    allowedOrigins: [],
    allowInsecureHttp: false,
    packageScripts: 'deny',
    integrity: 'require-expected-sha256',
    reproducibility: 'require-complete',
    allowedEnvironmentKeys: [],
  },
});
```

This example requires a matching binary with an expected SHA-256 and no catalog environment keys.
Missing evidence or a conflicting caller pin throws `AcpRegistryValidationError`; it never silently
weakens policy. For a binary without catalog integrity, supply `binaryIntegrity` with an independently
expected digest and the digest of its resolution evidence. Alternatively, explicitly select weaker
integrity/reproducibility policy and inspect the plan's recorded gaps.

Search matches all whitespace-separated query tokens case-insensitively against ID, name, description
and authors, then sorts by source-qualified identity. The explicit distribution preference is ranked;
selection never substitutes another architecture or a distribution outside that list. The six target
identifiers are `darwin`, `linux` or `windows` followed by `-aarch64` or `-x86_64`. Unsupported Windows
`.cmd`/`.bat` launches fail explicitly; no implicit shell interpreter is introduced.

Snapshots, entries, search results, distributions and plans are deeply frozen. Serializable values
are structurally revalidated and their digests recomputed before lookup or planning, so JSON round
trips remain usable without a hidden object-identity registry. The host must retain its expected
snapshot and entry pins; recomputing a digest does not establish trust in a modified object.

## Identity and the accepted profile

Source identity includes the caller-selected namespace, local/remote kind, stable/preview channel,
canonical location and profile. Agent IDs are unique within that source. Changing the source location
or channel produces a different identity. Redirect destinations never replace the selected source.
`rawDigest` is SHA-256 over exact accepted UTF-8 bytes, including whitespace and any UTF-8 BOM.
`snapshot.digest` binds the normalized source, entries and raw digest; `entry.digest` binds the
normalized entry. Public digests use `sha256:` followed by lowercase hexadecimal. Upstream binary
`sha256` fields remain normalized bare hexadecimal in distribution metadata.

The `published-v1` profile is grounded in upstream registry commit
[`7f9be29696108572a2bca70e0563af528073a0c3`](https://github.com/agentclientprotocol/registry/commit/7f9be29696108572a2bca70e0563af528073a0c3),
its [format](https://github.com/agentclientprotocol/registry/blob/7f9be29696108572a2bca70e0563af528073a0c3/FORMAT.md),
[agent schema](https://github.com/agentclientprotocol/registry/blob/7f9be29696108572a2bca70e0563af528073a0c3/agent.schema.json),
and [builder](https://github.com/agentclientprotocol/registry/blob/7f9be29696108572a2bca70e0563af528073a0c3/.github/workflows/build_registry.py).
It accepts the complete published `{ version: '1.0.0', agents, extensions?: [] }` envelope. The builder
emits an empty `extensions` array even though that commit's registry JSON Schema omits the field.
Only the empty form is accepted; extension installation and source-manifest preview overlays are
unsupported. Stable and preview are separate complete catalogs, selected by the caller.

The committed catalog fixtures are derived from pinned source entries and the builder's output
shape. They are not downloaded CDN publication bytes and do not establish the freshness or
authenticity of a live registry response. Retain and approve each actual source snapshot separately.

Agent release versions are opaque dotted numeric identities, including leading-zero date releases
such as `2026.10.01` and preview suffixes such as `1.2.3-preview.1`. They never resolve a package version.
Unknown fields, unknown distributions, duplicate agent identities or JSON keys, unsafe paths, NUL,
invalid UTF-8, unpaired surrogates and malformed URLs are rejected. URLs and argument strings remain
inert metadata; no shell expansion occurs. Binary paths become contained POSIX-relative paths,
including normalization of Windows separators. The parser accepts clean HTTP metadata, while all
network operations require their own explicit transport policy.

Default limits are 8 MiB of input, 1,024 entries, depth 16, 200,000 JSON values, 16 KiB per string,
128 launch arguments and 128 environment entries. `DEFAULT_ACP_REGISTRY_LIMITS` exposes these values;
`limits` can adjust them only within finite package ceilings. Parsing fails as a whole, without
returning a partially accepted catalog. Validation failures carry immutable `issues` with code,
path and message.

## Package resolution and reproducibility

`npx` and `uvx` describe catalog distribution kinds, not instructions to run download-on-demand
launchers. Planning requires an explicit `packageResolution` with the normalized package name,
exact version and package-owned bin or console-script command. An unversioned name or named tag
also requires caller-supplied resolution evidence. Exact catalog pins must match the supplied version.
Supported range syntax remains searchable metadata, but planning rejects it explicitly until range
resolution semantics are qualified; a digest alone does not prove that a version satisfies a range.
The command may differ from the package name. Aliases, local paths and VCS specifiers are unsupported.
No package registry is contacted by planning.

Package plans require exact Node/npm or Python/uv toolchain versions and measured executable digests,
without embedding machine-specific toolchain paths. Strict package reproducibility requires expected
artifact integrity, disabled package scripts and a supplied dependency lock. Supported lock input
profiles are a bounded npm package-lock v3 subset and hashed Python requirements. Both require a
single declared dependency closure containing the selected package, exact versions, target artifact
SHA-256 values and a digest of the complete lock document. These are locked inputs with pending
installer verification, not proof that a resolver or publisher is trustworthy. A top-level version
alone records a missing dependency closure; enabling scripts records another gap.

The npm profile requires one exact root dependency, contained `node_modules` paths, canonical
HTTP(S) artifact URLs and strong SHA-256/384/512 SRI. Links, bundled, dev, optional, platform-conditional
and peer dependency metadata require additional qualification and are rejected. Declared dependency
names must agree with the lock. The Python profile accepts canonical `name==version` lines with one
target SHA-256 each, comments and line continuations; direct URLs, options, extras and markers are
unsupported. Python requirements do not encode dependency edges, so the supplied graph remains
caller evidence until an installer compares actual package metadata and verifies closure. The same
installed-artifact verification remains mandatory for npm.

Plans bind the source, accepted snapshot and entry, selected distribution, target and preference,
literal launch arguments/environment, exact resolution and lock, toolchain identities, expected
integrity, mapping profile and explicit policy. Repeated equal normalized inputs yield the same plan
digest. `pinned-binary` describes the payload input only; it does not pin an operating system, shared
library set or all runtime behavior. Catalog environment variables are launch-only and require an
exact allowlist; process, shell, installer, proxy and runtime plumbing variables remain reserved.

## Explicit fetching

```ts
import { fetchAcpRegistrySnapshot } from '@agen-ai/acp-registry/node';

const fetched = await fetchAcpRegistrySnapshot({
  source: {
    namespace: 'approved-registry',
    kind: 'remote',
    channel: 'stable',
    location: 'https://registry.example.test/catalog.json',
    profile: 'published-v1',
  },
  trustedOrigins: ['https://registry.example.test'],
  timeoutMs: 15_000,
  maxRedirects: 3,
  signal: abortController.signal,
});
```

Fetching requires an exact canonical origin allowlist and validates the initial URL and every
redirect before contacting it. HTTP requires `allowInsecureHttp: true` in addition to the origin
allowlist; this also explicitly permits a trusted HTTPS-to-HTTP redirect. Credentials and cookies
are not forwarded. Origin trust is the caller's network policy, including any private or loopback
address it chooses; the package does not claim DNS or network sandbox enforcement.

The total deadline defaults to 15 seconds (maximum five minutes), redirects to three (maximum eight),
and the decoded response byte ceiling follows the catalog limits. Content-Length and streamed bytes
are checked, including decompressed responses. Only HTTP 200 is accepted. Cancellation, deadline,
origin, redirect, status and size failures produce `AcpRegistryFetchError` with a stable `code`;
invalid catalogs retain `AcpRegistryValidationError`. No response diagnostic body is included in
HTTP-status errors. `fetchedAt` is an observation time, not a freshness or authenticity guarantee.

The result includes the validated snapshot, exact accepted UTF-8 `content`, final URL and observation
time. Persist content and its source descriptor under caller policy if needed. Fetch failure never
chooses cached data, changes an installation or activates a provider. No cache directory is created.


## Install, retain and launch

The following lifecycle sketch assumes an approved binary plan and independently retained input
pins. A production host must persist the installation identity/reference and own error recovery.

```ts
import { parseAgentInstanceId, parseAgentProviderKey } from '@agen-ai/agent-protocol';
import { createAgentProviderRegistry } from '@agen-ai/agent-runtime';
import { openAcpInstallationStore } from '@agen-ai/acp-registry/node';
import { createNodeAcpProviderDriver } from '@agen-ai/provider-acp/node';

const store = await openAcpInstallationStore({ root: '/var/lib/my-host/acp-installations' });
const receipt = await store.install({
  plan,
  expectedPlanDigest: approvedPlanDigest,
  localArtifacts: [{ path: '/approved-inputs/agent.tar.gz', sha256: approvedArtifactSha256 }],
  signal: abortController.signal,
});
const identity = { planDigest: receipt.plan.digest, installationId: receipt.installationId };
const reference = await store.acquire({ ...identity, ownerId: 'session-123' });
// Durably persist the exact reference under the host's ownership before process launch.
const launch = await store.resolveLaunch(reference);
const providerKey = parseAgentProviderKey('installed-acp-agent');
const instanceId = parseAgentInstanceId('installed-agent:primary');
const driver = createNodeAcpProviderDriver({
  providerKey,
  launch: {
    executable: launch.executable,
    args: launch.args,
    env: { HOME: '/var/lib/my-host/agent-home', PATH: '/usr/bin:/bin', ...launch.env },
    cwd: '/work/project',
  },
});
const registry = await createAgentProviderRegistry({
  drivers: [driver],
  definitions: [{ providerKey, instanceId, driverConfiguration: {} }],
});
try {
  const instance = registry.requireInstance(instanceId);
  // Open a session and consume startTurn().outputs, answering through the execution handle.
} finally {
  await registry.dispose();
  // A failed native cleanup throws above and deliberately leaves the reference retained.
  await store.release(reference);
}
await store.remove(identity);
```

Persist the exact reference before launching. Keep it until all processes using the installation
have stopped, including startup that fails before a registry is returned. Failed startup or cleanup
does not prove quiescence and must not trigger an unconditional reference release or store deletion.
Retry owned cleanup or establish quiescence through the host before releasing the exact reference.
Keep that installation reference throughout an execution's pending human requests and later output.
An independent `resolveRequest` delivery receipt does not complete the turn or release its native
process. Retain one `startTurn` execution/output reader until actual terminality and cleanup; route
human decisions through a separately owned handler. The public
[registry example](../../examples/registry-install-run.ts) composes the shared session helper, and
the [live-output example](../../examples/live-request-output.ts) isolates that runtime lifecycle.
The provider launcher supplies no sandbox, account credentials or filesystem/network authority.
The registry is also usable without the provider package when another explicit process owner
consumes the verified launch recipe.

The `0.4.1` session-interaction API extends the same dependency rule to decisions
outside a turn. Register the runtime handler before opening and retain the exact
installation reference while a decision is pending, after a local response receipt,
and through session close and callback/native cleanup. An `answered`, `expired`,
`session_closed` or uncertain terminal does not release the reference. An uncertain
choice must never be replayed as part of installation or process recovery.

The optional Node `grok-folder-trust-v1` mapping requires an explicitly supplied
`executionBoundary` before materialization. The registry verifies installation
identity and returns a launch recipe; it supplies no process containment or
session-interaction policy. Use the provider's
[execution ownership guidance](../provider-acp/README.md#reserved-execution-ownership)
and the maintained [Linux reference](../../examples/execution/linux/README.md)
when composing that selected profile. Its exact local native qualification does
not qualify all registry-installed agents or other platforms.

If registry construction fails before returning a registry, preserve the original
`AgentProviderRegistryError.cause`. A retained `NodeAcpExecutionCleanupError` there
keeps the startup cleanup callable; invoke its `retryCleanup()` and retain the
external host and installation reference until native shutdown and entered
callbacks have actually joined. For a failed session opening, retain the exact
`AgentProviderSessionCleanupError` associated with that input object; for a returned
session, retain its close owner. Releasing a reference or deleting the store cannot
repair incomplete provider cleanup, and serializing an error does not preserve
the callable owner.

Installation and launch require the current OS/architecture to match the plan. The caller supplies
an absent store directory under an existing owned parent, or reopens a valid owned store. Foreign
and substituted roots fail closed. The library creates a private stage, verifies every retained file,
directory and contained symlink, writes a receipt, synchronizes supported filesystems and publishes
with one same-filesystem rename. POSIX receipts record `synced-rename`; platforms without directory
synchronization record only `atomic-rename`. Native Windows/macOS qualification is separate from
Linux source fixtures. Archive paths, links, special files, case collisions, payload size, entry count,
path depth and decoder output are bounded. Supported binary formats are tar, tar.gz/tgz,
tar.bz2/tbz2, ZIP and raw executables; ambiguous URLs require `binaryFormat` in the plan. System
installer formats and implicit shell command expansion are unsupported.

Binary input can be an explicitly mapped local file or a bounded download under the plan's origin,
HTTP and redirect policy. Expected SHA-256 and measured SHA-256 remain separate receipt facts.
Permissive missing-integrity plans retain their gap after successful measurement. The receipt binds
the complete payload inventory, plan, launch recipe and verification evidence. Its content identity
excludes observation time and machine-specific toolchain paths; its receipt digest binds the complete
record. Hashes establish byte identity, not publisher authenticity or immunity to same-user tampering.
Use a host-owned store and trusted toolchain roots; the library does not create an OS sandbox.

`parseAcpInstallPlan(serializedValue, independentlyRetainedDigest)` validates retained plans without
I/O. Installation reuses this check, derives launch/policy requirements again and rejects a matching
self-computed digest whose fields contradict those requirements. `read(identity)` verifies the exact
receipt and complete current payload. For `synced-rename` receipts, reads also synchronize the
installation and its parent before returning, reestablishing persistence after an earlier rename
whose final synchronization may have failed. Reads never download repairs. `resolveLaunch(reference)` also
checks retained toolchain entry hashes and needs a live exact reference. No registry access, latest
resolution, `npx` or `uvx` invocation occurs during launch. Removal and publication serialize against
references; changing a plan creates a distinct installation and leaves older referenced payloads usable.

## Explicit package toolchains and artifacts

Call `inspectAcpToolchains({ toolchains, workRoot })` with absolute locations for Node plus the npm CLI
JavaScript file, or Python plus uv. It runs bounded version probes with an explicit temporary home
and environment and measures the canonical executable entries. Use the resulting kind/version/SHA
identities in `createAcpInstallPlan`; provide the locations separately to `store.install`. An entry hash
does not attest an entire external Node/Python installation, standard library, npm dependency tree or
OS. Those roots remain caller-managed dependencies. Installation and retained launch reject changed
entry bytes instead of finding another executable on PATH.

npm receives verified local tarballs through a transformed private lock and runs real `npm ci` in
offline mode with lifecycle scripts, bin links, audit and funding disabled. The original logical lock
is retained. Actual manifests, dependency closure, version constraints and the root-owned JavaScript
bin are checked. Python receives verified wheels and runs real offline `uv pip install` into a retained
site-packages directory with hash requirements and no index, configuration, cache or source builds.
Actual metadata and the root-owned console script are checked without importing installed package
code. The launch bootstrap uses the exact Python executable and its retained payload path.

`localArtifacts` maps approved bytes by URL and/or SHA-256. `packageArtifacts` supplies explicit
name/version/URL/filename/SHA mappings where required, particularly Python wheel filenames and a
complete closure for plans without an original lock. Package managers never fetch missing artifacts.
A plan may explicitly permit the library to download approved artifacts before invoking the offline
manager. Newly observed closure does not remove a plan's missing-original-lock gap. Enabled scripts,
Python source distributions, peer/optional/platform-conditioned npm dependencies, and Python
markers/extras require additional profiles and fail explicitly here. Offline manager flags are not
network confinement; execution of arbitrary install scripts is deliberately unsupported.

## Limits, failures and recovery

`DEFAULT_ACP_INSTALLATION_LIMITS` exposes finite configurable resource limits: 256 MiB per artifact,
1 GiB total artifact and payload bytes, 2 GiB decoded archive bytes, 25,000 entries, depth 32,
4,096-byte paths, three download redirects, two-minute artifact/tool deadlines, 1 MiB combined tool
output, 16 MiB receipts and 1,024 active references. Larger values remain bounded by package ceilings.
Errors use `AcpInstallationError` with stable `code`; malformed plans retain registry validation issues.
Registry and installation failures remain distinct from Agent Protocol V11 operational failures and
provider retry observations. This package has no runtime dependency or policy for retrying an agent
turn; retained installation integrity and process quiescence do not settle uncertain native execution.

Identical-plan operations use an exclusive cross-process lock and return `store_busy` when occupied.
They do not wait indefinitely or replace a lock based on age or PID. Cancellation terminates the directly owned tool and its POSIX process group, closes retained pipes
and waits for the direct child to exit before cleanup. Processes that deliberately escape that group
require caller-provided OS containment; Windows does not gain a process-tree sandbox from this API.
Failed publication never exposes a partial installation. Crash residue remains
inspectable through `inspectAttempt(planDigest)`. `recoverAttempt({ ...attempt, ownerQuiesced: true })`
requires the exact retained attempt and caller-established quiescence before cleaning owned residue.
Unknown or conflicting residue is retained. An active reference blocks removal until its exact owner
releases it; the library does not infer process lifetime or automatically expire references.

## Real installation test prerequisites

The package tests execute real npm and uv against committed synthetic local tarballs and wheels.
They require Node/npm, Python and uv on the test host; missing tools fail with an explicit
prerequisite error. No registry credentials, real agent accounts or inference are involved. Linux
CI installs Python `3.14.4` and uv `0.11.28` through immutable action revisions before running these
tests. The standalone SDK CI runs them on Node 22 and 24; its release workflow uses the same
Python/uv prerequisites. These fixtures qualify the Linux test lane; they do not establish native
Windows or macOS installation qualification.

Run `pnpm --filter @agen-ai/acp-registry test` after installing those prerequisites. The fixture
discovery helper measures the actual tool entries and versions before constructing each plan;
production requires explicit caller-selected paths. `tests/fixtures/install-packages/generate.py`
recreates the small deterministic fixtures using only the Python standard library. Fixture
generation never imports package code or invokes package lifecycle scripts.
