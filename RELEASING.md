# Releasing

The three packages ship together at one version. Publish them in dependency order:

1. `@agen-ai/validation`
2. `@agen-ai/agent-protocol`
3. `@agen-ai/agent-runtime`

The public repository uses npm trusted publishing. GitHub Actions receives a short-lived npm
credential through OIDC, so the repository does not need an npm token secret. npm attaches
provenance to releases made from the workflow.

## First release setup

The first release needs a one-time bootstrap because npm trusted publishing is configured on an
existing package.

1. Create the `agen-ai` organization on npm with the free public-package plan.
2. Enable two-factor authentication on the maintainer account.
3. Sign in locally with `npm login`.
4. Run `pnpm check` from a clean `main` checkout.
5. Pack the packages with pnpm and publish `0.1.0` under the `beta` dist-tag.
6. Add `release.yml` as the trusted GitHub Actions publisher for each package.
7. Restrict package publishing so traditional tokens cannot publish.

The initial local publish uses the signed-in maintainer session and an interactive 2FA check. All
later releases use the workflow.

## Routine release

1. Update all package versions and release notes in the private source repository.
2. Export the approved SDK snapshot to this repository.
3. Merge the projection to `main` and wait for CI.
4. Tag the public commit as `v<version>` and push the tag.
5. Open **Actions**, choose **Publish to npm**, and run it from the version tag.
6. Keep prerelease builds on `beta` or `next`. Use `latest` only for the default stable release.
7. Verify all three registry entries, install the runtime in a clean project, and create the GitHub
   release from the same tag.

The workflow rejects a branch ref and rejects tags that do not match every package version. npm
never permits the same package name and version to be published twice, so fix a failed release with
a new version when any published tarball needs to change.

## Trusted publisher configuration

The same trust relationship is required for all three packages:

```text
Provider: GitHub Actions
GitHub owner: trevor-nichols
Repository: agenai-agent-sdk
Workflow: release.yml
Allowed action: npm publish
```

The npm CLI can create the relationships after the bootstrap release:

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
```

Confirm the result with `npm trust list <package>`.
