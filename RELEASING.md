# Releasing

The three core packages and four optional packages (orchestration, ACP transport, ACP provider and
ACP registry) ship together at one version. Publish the complete seven-package set in dependency order:

1. `@agen-ai/validation`
2. `@agen-ai/agent-protocol`
3. `@agen-ai/agent-runtime`
4. `@agen-ai/agent-orchestration` (optional managed delegation, tools, completion and storage contracts)
5. `@agen-ai/acp-transport` (independent optional transport)
6. `@agen-ai/provider-acp` (optional local-process and injected-stream provider)
7. `@agen-ai/acp-registry` (optional catalog planning, verified installation and retained launch)

The coordinated release version is `0.4.0`. Verify current registry versions and dist-tags before
starting or resuming a release. Source preparation and local validation do not authorize publication,
tag creation, dist-tag changes or host deployment. The unpublished `0.3.2` preparation is superseded;
its steering retirement correction is retained in `0.4.0`. Review
[MIGRATING-TO-0.4.md](MIGRATING-TO-0.4.md) before releasing or upgrading.

The public repository uses npm trusted publishing. GitHub Actions receives a short-lived npm
credential through OIDC, so the repository does not need an npm token secret. npm attaches
provenance to releases made from the workflow.

## Source preparation

Prepare and review all seven package manifests, public exports, dependency ranges, licenses, README
files, migration notes and changelog from the same source revision. Keep the core dependency rules
unchanged and make optional orchestration/ACP dependencies explicit. The public root is private
and is never published as an additional package.

From a clean standalone checkout, run `pnpm check`. It validates repository and release contracts,
generated schemas, builds, types, executable examples, package tests and the packed external
consumer. Registry installation fixtures require the documented Python/uv prerequisites; the
credentialless local, registry, direct-delegation and ACP-delegation workflows need no installed
agent or account. The process-launch examples retain their documented POSIX requirements.
The native-runner tests are also hermetic and run against both source and packed
packages. Installed-consumer proof covers the provider's default standard extension
policy, explicit rejection through the Node launcher, and actual managed completion
after an unknown extension request receives its correlated error response.
Source checks do not contact npm publication APIs.
`node scripts/release/verify-release-set.mjs` additionally admits the exact coordinated source
inventory without publishing anything.

Retain the inspected source revision, complete seven-package archive set, package versions and
check results for release review. The workflow checks the archive inventory before its first
publication, rejecting missing, unknown or mixed-version artifacts. Package checks and
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

## Initial publication of optional packages

The core packages already completed their one-time npm bootstrap. Each new optional package needs
its own separately authorized package setup and trusted publisher relationship. npm requires the
package to exist before configuring trust. [npm trust documentation](https://docs.npmjs.com/cli/v11/commands/npm-trust/)

For a new package, npm staging can create a public `0.0.0-stage` placeholder while withholding the
staged payload. It requires npm >=11.15.0 and Node >=22.14.0. This is a registry write requiring
separate approval. [npm staged-publishing documentation](https://docs.npmjs.com/staged-publishing/)

During the `0.4.0` setup, staging admitted trusted-publisher configuration for all four optional
package names even while public package metadata returned HTTP 404. Inspect the authenticated stage
and trust records rather than relying on a public placeholder. Use organization access, a signed-in
maintainer session and account 2FA:

1. In a disposable directory outside the SDK checkout, review a minimal manifest for one new
   optional package. Use a distinct version such as `0.0.0-bootstrap.0`, with no SDK payload:

   ```json
   {
     "name": "@agen-ai/acp-transport",
     "version": "0.0.0-bootstrap.0",
     "description": "Package-name setup only; do not approve this staged version.",
     "license": "MIT",
     "files": []
   }
   ```

2. From that directory, run `npm stage publish --access public --tag bootstrap`. Inspect
   `npm stage list @agen-ai/acp-transport`, `npm stage view STAGE_ID` and
   `npm view @agen-ai/acp-transport versions dist-tags --json`, replacing `STAGE_ID` with the
   exact returned stage identity. Confirm the intended name and distinct staged version, and record
   whether public metadata exposes a placeholder or still returns HTTP 404.
3. Configure the exact trusted publisher below and inspect it with `npm trust list`. Repeat the
   isolated setup for `@agen-ai/agent-orchestration`, `@agen-ai/provider-acp` and `@agen-ai/acp-registry`.
4. Reject each unneeded bootstrap stage with `npm stage reject STAGE_ID`; never approve it. Confirm
   that the package name and correct trust relationship remain, the bootstrap stage is absent and
   `0.4.0` is neither published nor staged. A staged version reserves its semver identity, so staging
   the target `0.4.0` would block ordinary publication of that version.
   [npm stage command reference](https://docs.npmjs.com/cli/v11/commands/npm-stage/)
5. After separate release approval, publish fresh coordinated `0.4.0` artifacts through the
   unchanged workflow so its release provenance is available. Inspect package access and token
   restrictions, then verify all seven artifacts and attestations before promotion.

Do not locally publish target `0.4.0` bytes as a bootstrap. The verifier rejects an existing target
version without the required GitHub release provenance, and npm will not overwrite it. Live setup
must confirm the composition above works without weakening publication verification. Source
preparation creates no placeholder, stage, trusted publisher, release tag or registry dist-tag.

## Routine release

1. Update all package versions and release notes in the private source repository.
2. Export the approved SDK snapshot to this repository.
3. Merge the projection to `main` and wait for CI.
4. Tag the public commit as `v<version>` and push the tag.
5. Open **Actions**, choose **Publish to npm**, and run it from the version tag.
6. Keep prerelease builds on `beta` or `next`. Use `latest` only for the default stable release.
7. Verify all seven registry entries, their provenance, and a clean registry consumer before any
   `latest` promotion.
8. When separately approved, sign in with the maintainer account and move `latest` to the exact
   verified version for all seven packages. Create the GitHub release from the same tag.

The ordinary workflow requires a version tag and rejects tags that do not match every package
version. A branch run is admitted only through the guarded recovery path below. Before
each publish it compares an existing version's normalized manifest, exact tarball bytes, requested
tag, and npm publish/provenance attestations with the intended artifact and release commit. A partial
retry skips only an exact match, and the completed workflow verifies registry signatures and
provenance cryptographically with `npm audit signatures`. Each post-publish verification allows up
to five minutes for npm's registry and attestation endpoints to converge before stopping safely.

npm never permits the same package name and version to be published twice. If published bytes do
not match, stop and release a new patch version rather than overwriting or unpublishing casually.

If a tagged workflow fails because the workflow itself needs a non-package correction, commit that
correction to `main` without moving the tag. Dispatch the workflow from `main` with `release_ref`
set to the existing `v<version>` tag. Recovery is admitted only when every package-producing source,
manifest, lockfile, and consumer proof is byte-identical to the tag. An exact package published by
the original run retains the tag and resolved tag commit in its immutable provenance and is skipped;
packages first published by the recovery run identify the corrected `main` workflow commit. Never
use recovery to publish changed package sources under an existing version.

## Promoting an exact release to latest

This workflow and its trust configuration authorize `npm publish` only. Promotion uses a
maintainer-authenticated npm session after the immutable version and provenance pass readback;
the release does not request OIDC dist-tag permission:

```sh
VERSION=0.4.0
npm dist-tag add "@agen-ai/validation@$VERSION" latest
npm dist-tag add "@agen-ai/agent-protocol@$VERSION" latest
npm dist-tag add "@agen-ai/agent-runtime@$VERSION" latest
npm dist-tag add "@agen-ai/agent-orchestration@$VERSION" latest
npm dist-tag add "@agen-ai/acp-transport@$VERSION" latest
npm dist-tag add "@agen-ai/provider-acp@$VERSION" latest
npm dist-tag add "@agen-ai/acp-registry@$VERSION" latest
```

Read every tag back after the seven commands. A promotion changes package resolution, not tarball
bytes; `beta` may continue to select the same exact version.

## Trusted publisher configuration

The same trust relationship is required for all seven packages:

```text
Provider: GitHub Actions
GitHub owner: trevor-nichols
Repository: agenai-agent-sdk
Workflow: release.yml
Allowed action: npm publish
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

Confirm the result with `npm trust list <package>`.
