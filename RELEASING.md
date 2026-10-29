# Releasing

The three core packages and seven optional packages (orchestration, ACP transport, ACP provider,
ACP registry, history, sandbox and Docker sandbox) form the published coordinated ten-package
`0.4.6` release. npm `beta` and `latest` select `0.4.6` for all ten names; see the
[v0.4.6 release](https://github.com/trevor-nichols/agenai-agent-sdk/releases/tag/v0.4.6).
Current source prepares the unpublished `0.4.7` authentication-parity candidate; read
[UPGRADING-TO-0.4.7.md](UPGRADING-TO-0.4.7.md).
Future separately authorized releases publish the complete set in dependency order:

1. `@agen-ai/validation`
2. `@agen-ai/agent-protocol`
3. `@agen-ai/agent-runtime`
4. `@agen-ai/agent-orchestration` (optional managed delegation, tools, completion and storage contracts)
5. `@agen-ai/acp-transport` (independent optional transport)
6. `@agen-ai/provider-acp` (optional local-process and injected-stream provider)
7. `@agen-ai/acp-registry` (optional catalog planning, verified installation and retained launch)
8. `@agen-ai/agent-history` (optional native catalogs, transcripts, search and explicit saved-session management)
9. `@agen-ai/sandbox` (optional neutral sandbox lifecycle, processes, files and explicit ACP bridge)
10. `@agen-ai/sandbox-docker` (optional local Docker execution backend)

The coordinated `0.4.6` release retains Agent Protocol V13 and recovery v3 from `0.4.5`. Preserve the historical seven-package
`0.4.3`/V12 release, earlier `0.4.2`/V12,
`0.4.1`/V11 and `0.4.0`/V10 releases and their historical evidence. Verify current
registry versions and dist-tags before starting or resuming any separately authorized release.
Source preparation and local validation do not authorize publication, public-repository push,
tag creation, dist-tag changes or host deployment. Review
[UPGRADING-TO-0.4.6.md](UPGRADING-TO-0.4.6.md) for the current release,
[UPGRADING-TO-0.4.5.md](UPGRADING-TO-0.4.5.md) for the preceding sandbox capability update,
[UPGRADING-TO-0.4.4.md](UPGRADING-TO-0.4.4.md) for the preceding ten-package release,
[UPGRADING-TO-0.4.3.md](UPGRADING-TO-0.4.3.md) for the published patch,
[MIGRATING-TO-0.4.2.md](MIGRATING-TO-0.4.2.md) for the V12 boundary and
[MIGRATING-TO-0.4.md](MIGRATING-TO-0.4.md) when upgrading from `0.3.1`.

All ten packages have configured npm trusted publishers for this repository's `release.yml`
workflow with publication and staging permissions, without separate dist-tag promotion permission. GitHub Actions
receives a short-lived npm credential through OIDC, and npm attaches provenance to workflow
releases. The separately authorized initial setup for `@agen-ai/agent-history`, `@agen-ai/sandbox` and `@agen-ai/sandbox-docker`, including
temporary-stage cleanup, is complete. Source checks do not create or modify those relationships;
future trust changes, publication and dist-tag promotion retain their separate authorization.

## Source preparation

Prepare and review all ten package manifests, public exports, dependency ranges, licenses, README
files, migration notes and changelog from the same source revision. Keep the core dependency rules
unchanged and make optional orchestration/ACP/history/sandbox dependencies explicit. The public root is private
and is never published as an additional package.

From a clean standalone checkout, run `pnpm check`. It validates repository and release contracts,
generated schemas, builds, types, executable examples, package tests and the packed external
consumer. Registry installation fixtures require the documented Python/uv prerequisites; the
credentialless local, registry, direct-delegation and ACP-delegation workflows need no installed
agent or account. The process-launch examples retain their documented POSIX requirements.
The core-only `examples:lifecycle-interactions` walkthrough observes a live decision after opening,
uses its bound receipt and joins cleanup without a native process or model turn. It runs against
source and matching packed packages; it does not establish native effect or whole-workload cleanup.
The native-runner tests are also hermetic and run against both source and packed
packages. Installed-consumer proof covers the provider's default standard extension
policy, explicit rejection through the Node launcher, and actual managed completion
after an unknown extension request receives its correlated error response.
The public `examples:history` workflow and reusable browser compile and execute through packed
entrypoints, including a history-only consumer with execution packages and vendor peers absent.
Its explicitly configured Claude CLI is a separate native-reader example. Read the
[history source matrix](packages/agent-history/README.md#explicit-sources-and-qualification): exact
native evidence uses Linux x86_64 / Node 24.18.0, Cursor supports SDK JSONL/SQLite stores only,
Cursor cloud replay is unqualified after the sampled HTTP 410, and generic ACP is catalog-only.
Grok mutation evidence covers only the owned unauthenticated networkless local composition.
Source checks do not contact npm publication APIs.
The credential-free Docker lane is separate: supply the explicit local Engine and a new owned
output directory to `pnpm test:sandbox-integration --engine unix:///absolute/docker.sock --output /absolute/new/evidence`.
It provisions its own image and runs package integration plus the installed public sandbox example.
The ordinary `pnpm check` includes hermetic sandbox and CI-tooling tests and requires no Docker daemon.
The [sandbox walkthrough](examples/sandbox/README.md) documents admitted image metadata and exact
ownership; the [Docker package](packages/sandbox-docker/README.md#qualification-scope) records the
real backend tuple and separate four-turn Grok API-key evidence. Hosted Docker CI is configured
separately; retain its actual workflow result and exact inputs rather than inferring hosted
qualification from a local pass or package publication.
`node scripts/release/verify-release-set.mjs` additionally admits the exact coordinated source
inventory without publishing anything.

Retain the inspected source revision, complete ten-package archive set, package versions and
check results for release review. The workflow checks the archive inventory and retains the exact
ten tarballs with the source lockfile in a GitHub Actions artifact before its first publication,
rejecting missing, duplicate, foreign or mixed-version artifacts. Package checks and
synthetic ACP examples establish source behavior; they do not establish native agent, account,
inference, installed-host or fleet qualification. Deployment remains a separate operation.

Retain actual native qualification separately using the
[opt-in runner](examples/delegation/native/README.md). The prepared source has direct
and retained-binary Grok `1.0.50` Linux x86_64 evidence for its explicit API-key route
and `grok-4.3` / Low / observed default service-tier request mapping. Retained execution
proves installer exit and reopening in a fresh process. A registry receipt alone does
not establish authenticated tool use, and a successful model statement does not
establish admission or completion. Keep unsuccessful attempts and original report
identities intact. For later source changes, compare the exact execution inputs and
record the applicability of unchanged evidence; rerun affected native behavior only
when that comparison or the behavior change requires it. Default checks never run
the authenticated qualification command.

README changes alter package archive hashes even when runtime files are unchanged. Retain the
original native-used archives and compare every non-README packed payload, native configuration,
example and launcher input before recording applicability to newly packed documentation. Run a
fresh packed consumer proof for the new archives. An unchanged runtime does not relabel a prior
native run as having used the new archive or a repaired launcher; preserve both identities and
record any separate offline verification. Repeat authenticated inference only when affected
behavior or unresolved applicability calls for it.

The separate `0.4.1` lifecycle qualification covers grant, decline and pending-close through
the selected `grok-folder-trust-v1` create mapping. Its exact retained composition is Grok Build
`1.0.50` (`c58f321264ba`), executable SHA-256
`c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5`, direct
`agent --no-leader stdio`, modern stable ACP `schema-v1.23.0`, API-key authentication, Linux
x86_64 kernel `7.0.0-38-generic`, Node `24.18.0`, systemd `259.5`, Bubblewrap `0.11.1` and the
frozen installed dependency/toolchain/network inputs. The explicitly supplied Linux owner had
64-task, 512 MiB and 180-second whole-service bounds. Each returned SDK close had an independent
same-cgroup empty checkpoint while the consumer remained alive, then host retirement without
external intervention. Grant has separate native-file effect proof; decline proves local acceptance
and absence of grant, without a separately attested acknowledgment or persisted denial.

Keep that native evidence separate from controlled wire/reference proof and fresh standalone
checks. Native wire correlation and prompt counts remain unobserved; frozen native consumers made
no SDK turn invocation. The native dependency closure included `fast-uri@3.1.8`, while the standalone
source retains its `fast-uri@3.1.0` override. Source documentation changes also change package archive
bytes. Record applicability by comparing behavior-bearing inputs, rather than presenting newly
packed `0.4.1` archives as the original native-qualified set. Source preparation does not qualify
other native/account/platform pairings, general model-turn resource sizing, interactive
materialization, root injected/shared connections, selected-profile resume/branch, outside-turn
forms/authentication, durable native recovery, SDK-managed remembered permissions or private execution.

The [typed Linux execution reference](examples/execution/linux/README.md) supplies a host-owned
`NodeAcpExecutionBoundary`; the default provider constructor supplies no implicit containment.
The optional sandbox packages provide a separately selected Docker profile through the explicit
`@agen-ai/sandbox/acp` bridge. The Linux reference selection rejects a missing
boundary before materialization. Review early handler registration, exact receipt meaning and
[retained startup/opening cleanup](MIGRATING-TO-0.4.1.md#retain-startup-and-opening-cleanup), including
`NodeAcpExecutionCleanupError` preserved through `AgentProviderRegistryError.cause`. A request terminal,
timeout or canceled wait never substitutes for successful native cleanup.

Retain separate durable-delivery qualification evidence when reviewing the SQLite reference. Follow
the [durable example instructions](examples/delegation/README.md#run-the-durable-qualification) in the
exact qualified Linux, Node `24.18.0`, SQLite `3.53.1` and local-filesystem environment:

```sh
pnpm build
pnpm typecheck:examples
pnpm test:examples:durable
```

Set `AGENT_SDK_DURABLE_TEST_ROOT` to an absolute qualified directory to include that matrix in the
packed external-consumer proof. General Node 22 support does not qualify the SQLite reference on
other environments. Completion inbox acceptance and parent dispatch must remain separate evidence;
crash recovery must not replay uncertain provider execution. These checks prepare SDK release
evidence, not application settings, product integration or provider registration.

## Package setup status

The seven existing package names completed npm setup and trusted-publisher configuration for
`0.4.0`, and the same relationships published `0.4.1`, `0.4.2` and `0.4.3`. Inspect those existing
relationships before a later authorized release; do not recreate them merely because the source
version changed. Their historical staging and publication evidence remains tied to the original
release.

`@agen-ai/agent-history`, `@agen-ai/sandbox` and `@agen-ai/sandbox-docker` were absent from those
releases. Their separately authorized initial setup and trusted-publisher verification completed
for `0.4.4`, and the temporary setup stages were removed. All ten package names now have the
reviewed relationship below, permitting publication and staging without separate dist-tag promotion permission.
Inspect each relationship before a future release; setup for one name never establishes ownership
or trust for another. A new package still needs separately authorized setup; source preparation creates no registry stage or trust relationship.

### Bootstrap a new package safely

Use a distinct temporary setup version when staging a new name to configure ownership and trust.
Keep that setup stage unapproved until the real release version has published and its original
bytes and provenance pass readback. Staged and published versions share a unique version index,
so a pending setup stage must not use the version the workflow will publish. Reject the exact
setup stage only after the real version exists; then recheck the published version, empty stage
queue and trusted publisher. The 0.4.4 preparation observed missing package access and trust after
rejecting the last setup stage before first publication; do not rely on an empty placeholder to
retain that identity. See [npm's staging contract](https://docs.npmjs.com/cli/v11/commands/npm-stage/).

## Routine release

1. Obtain separate authorization for the exact release operation. Verify package setup/trust for
   all ten names. Review all package versions and
   release notes in the private source repository.
2. Export the approved SDK snapshot to this repository.
3. Merge the projection to `main` and wait for CI.
4. Tag the public commit as `v<version>` and push the tag.
5. Open **Actions**, choose **Publish to npm**, and run it from the version tag.
6. Publish the reviewed set on `beta` and verify it before promoting a stable release to `latest`.
   Prerelease builds remain on `beta` or `next`.
7. Verify all ten registry entries, their provenance, and a clean registry consumer before any
   `latest` promotion.
8. When separately approved, sign in with the maintainer account and move `latest` to the exact
   verified version for all ten packages. Create the GitHub release from the same tag.

The ordinary workflow requires a version tag and rejects tags that do not match every package
version. A branch run is admitted only through the guarded recovery path below. Before
each publish it compares an existing version's normalized manifest, exact tarball bytes, requested
tag, and npm publish/provenance attestations with the intended artifact and release commit. A partial
retry skips only an exact match, and the completed workflow verifies registry signatures and
provenance cryptographically with `npm audit signatures`. Each post-publish verification makes up to
90 attempts at ten-second intervals, allowing a fifteen-minute polling window plus request time
for npm processing and registry/attestation visibility. A successful upload can remain unavailable
while npm processes it. If polling expires, confirm that accepted uploads have appeared and match
their intended artifacts before resuming; never blindly republish a version still being processed.

npm never permits the same package name and version to be published twice. If published bytes do
not match, stop and release a new patch version rather than overwriting or unpublishing casually.
Retain the original `npm-release-<tag>-attempt-<attempt>` artifact. A retry must compare against
those original bytes; do not infer identity from a fresh pack or replace an accepted upload.

If a tagged workflow fails because the workflow itself needs a non-package correction, commit that
correction to `main` without moving the tag. Dispatch the workflow from `main` with `release_ref`
set to the existing `v<version>` tag. Recovery is admitted only when every package-producing source,
manifest, lockfile, and consumer proof is byte-identical to the tag. An exact package published by
the original run retains the tag and resolved tag commit in its immutable provenance and is skipped;
packages first published by the recovery run identify the corrected `main` workflow commit. Never
use recovery to publish changed package sources under an existing version.

### Reuse the original archives after a partial publication

If any package version was accepted, retain its original pre-publication workflow artifact. For
an authorized workflow-only recovery, dispatch from `main` with `release_ref` set to the immutable
version tag and `original_artifact_id` set to that original artifact's numeric ID. For example,
`release_ref=v0.4.4` and `original_artifact_id=12577458147` identify the original attempt-2 archive
set. The helper rejects artifact input on tag runs; ordinary tag releases continue to pack fresh
archives. Recovery preserves the original tag attempt's completed SDK qualification and runs
focused release-tooling tests instead of rebuilding or rerunning unchanged SDK/native fixtures.
All source guards, package/provenance inspections and signature verification remain in force;
restoration does not establish a new native qualification.

Restoration verifies the artifact's repository, original tag commit, release workflow and completed
run attempt, allowing a failed attempt that already published part of the set. It verifies GitHub's
ZIP digest, decodes only the ten exact archives plus lockfile and export metadata into private
scratch, and compares retained metadata with the immutable tag rather than recovery `HEAD`.
Archives are admitted before a new `release` directory is created; existing destinations are
preserved. The helper admits ZIPs through 64 MiB and expanded contents through 512 MiB, with bounded
copying. These restoration budgets are release tooling limits, not SDK workload limits.

The new pre-publication artifact includes `release-artifact-receipt.json` with the original
artifact/run identity, digest, tagged metadata hashes and every restored archive hash. Its ordinary
root export metadata still describes the recovery checkout. No accepted archive is repacked.
Already published packages are skipped only after exact bytes, manifest, requested tag and
provenance pass the existing checks. New publications identify the corrected `main` workflow;
accepted original publications retain their original tag provenance. Keep the immutable tag fixed.

## Promoting an exact release to latest

The workflow uses npm trusted publishing. Its configured permissions allow package publication
and staging, without separate dist-tag promotion permission. Promotion uses a maintainer-authenticated npm session
after the immutable version and provenance pass readback; the release does not request OIDC
dist-tag permission:

```sh
VERSION=0.4.7
npm dist-tag add "@agen-ai/validation@$VERSION" latest
npm dist-tag add "@agen-ai/agent-protocol@$VERSION" latest
npm dist-tag add "@agen-ai/agent-runtime@$VERSION" latest
npm dist-tag add "@agen-ai/agent-orchestration@$VERSION" latest
npm dist-tag add "@agen-ai/acp-transport@$VERSION" latest
npm dist-tag add "@agen-ai/provider-acp@$VERSION" latest
npm dist-tag add "@agen-ai/acp-registry@$VERSION" latest
npm dist-tag add "@agen-ai/agent-history@$VERSION" latest
npm dist-tag add "@agen-ai/sandbox@$VERSION" latest
npm dist-tag add "@agen-ai/sandbox-docker@$VERSION" latest
```

Run these commands one package at a time. Complete that command's browser authentication, wait
for its successful exit and read its tag back before starting the next package. Do not batch
authentication links or leave concurrent maintainer challenges pending. If a challenge expires,
read the package's current tag before generating a replacement for that package alone.

Read every tag back after the ten commands. A promotion changes package resolution, not tarball
bytes; `beta` may continue to select the same exact version. Readback must establish the intended version for both tags after promotion.
These commands remain a separately authorized release procedure, not a source-readiness step.

## Trusted publisher configuration

The following trust relationship is required for every package in the ten-package release.
It is configured for all ten published names, including history and both sandbox packages:

```text
Provider: GitHub Actions
GitHub owner: trevor-nichols
Repository: agenai-agent-sdk
Workflow: release.yml
Allowed permissions: createPackage, createStagedPackage
Dist-tag authority: none
```

The npm CLI can create missing relationships after each package exists. Inspect existing
relationships first; already configured packages do not need their trust recreated:

```sh
npm trust github @agen-ai/validation \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes

npm trust github @agen-ai/agent-protocol \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes

npm trust github @agen-ai/agent-runtime \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes

npm trust github @agen-ai/agent-orchestration \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes

npm trust github @agen-ai/acp-transport \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes

npm trust github @agen-ai/provider-acp \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes

npm trust github @agen-ai/acp-registry \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes
```

Confirm each relationship with `npm trust list <package>`. The seven commands above and the
three below describe the configured ten-package set. They are reference commands for separately
authorized trust maintenance; do not recreate working relationships merely to prepare a release.
If an authorized repair is needed, preserve the reviewed repository/workflow/action and verify
that package explicitly:

```sh
npm trust github @agen-ai/agent-history \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes
npm trust list @agen-ai/agent-history

npm trust github @agen-ai/sandbox \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes
npm trust list @agen-ai/sandbox

npm trust github @agen-ai/sandbox-docker \
  --repo trevor-nichols/agenai-agent-sdk \
  --file release.yml \
  --allow-publish \
  --yes
npm trust list @agen-ai/sandbox-docker
```

These commands document trust maintenance; they do not grant permission to change it. The
`0.4.4` setup is complete. Future publication, trust changes, tag creation, promotion and deployment
remain separately authorized operations.
