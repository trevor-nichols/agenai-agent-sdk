# Contributing

Thanks for taking the time to work on the AgenAI Agent SDK.

## Before opening a change

For a bug, please include the package version, Node.js version, a small reproduction, and the
behavior you expected. For an API proposal, describe the provider behavior that does not fit the
current contract. Concrete adapter examples are especially useful.

Security reports should follow [SECURITY.md](SECURITY.md) instead of using a public issue.

## Local setup

The repository requires Node.js 22 or newer and pnpm 11.7.0. The complete local qualification
lane runs on Linux and also requires npm, Python 3.14.4 and uv 0.11.28. These tools install
controlled, locally generated package fixtures with network access and install scripts disabled;
the checks do not authenticate with an agent or submit inference requests. CI exercises Node 22
and 24 with these prerequisites.

```sh
corepack enable
pnpm install
pnpm check
```

The workspace pins `tsup@8.5.0` and its `esbuild@0.25.10` compiler to the inspected source
build chain. `check:repository` verifies the installed versions for every package. Upgrade these
pins deliberately with rebuilt artifact comparisons and affected qualification; a compatible
dependency range does not guarantee identical JavaScript output. Retain the destination's own
lockfile and use `pnpm install --frozen-lockfile` for subsequent validation.

`pnpm test:external-consumer` builds and packs all ten candidate packages, installs those tarballs in an
independent temporary workspace, and compiles their emitted declarations. Its process fixtures
exercise registry plans, binary/npm/uv installation, retained offline launch, permission
continuation, session-lifetime decisions, retained startup/opening cleanup, cancellation, malformed
peers and slow consumers. The fixture sources are part of
this public projection, so the proof can run without access to the private monorepo. It also
compiles and executes the public history examples across isolated native-store compositions,
including a history-only installation without execution packages or vendor peers. The recorded
native history evidence uses Linux x86_64 / Node 24.18.0; the Cursor constructor additionally
requires Node >=22.13. Ordinary portable checks do not broaden that native qualification.

Sandbox package checks are hermetic and need no Docker daemon or provider credentials. Real
backend checks are an explicit separate lane:

```sh
pnpm test:sandbox-integration \
  --engine unix:///var/run/docker.sock \
  --output /absolute/new/evidence
```

That lane explicitly pulls its pinned fixture source if absent, prepares an owned image, runs
Docker integration and the installed [public sandbox example](examples/sandbox/README.md), and
makes no model request. Its runner owns this fixture preparation; the backend itself never pulls
or builds images.
The local Engine/profile prerequisites, admitted image environment and exact native evidence
scope are documented in [the Docker package](packages/sandbox-docker/README.md). Do not infer
hosted CI success from its configured workflow; no hosted Docker result is recorded. Preserve
original operation/cleanup failures and exact resource identities when changing lifecycle code.
Recovery is cleanup-only, and uncertain command outcomes must never be replayed automatically.

Current source is the unpublished ten-package `0.4.4` candidate with Agent Protocol V13.
The recorded published family remains seven packages at `0.4.3`; it did not include history or either sandbox package.
Read [UPGRADING-TO-0.4.4.md](UPGRADING-TO-0.4.4.md) for candidate compatibility, history and sandbox setup,
and [MIGRATING-TO-0.4.2.md](MIGRATING-TO-0.4.2.md) before changing V12 lifecycle behavior.
Earlier `0.4.1` artifacts retain V11.
After building, `pnpm examples:lifecycle-interactions` runs the generic core-only walkthrough:
an early handler receives a setup question, opening returns while it is pending, a bound response
settles it and cleanup joins without starting a model turn. Turn requests have the separate
`pnpm examples:live-request-output` walkthrough.

Keep adapter support exact per phase, opening operation and request kind. Outside-turn decisions
need one exclusive producer owner, an early host handler and honest delivery receipts; request
terminality does not establish native effect or cleanup. The optional selected Node mapping
requires a host-supplied execution boundary before materialization. Its
[typed Linux reference](examples/execution/linux/README.md) has separate OS/tooling and ownership
prerequisites. Ordinary checks are credentialless and do not perform authenticated native
qualification. Preserve the exact native evidence and its frozen dependency tuple separately from
new source and packed checks; neither a matching version nor a newly packed archive transfers
that qualification automatically.

Keep changes focused and add tests for contract or lifecycle behavior. Public entrypoints are
explicit, so a new public module also needs a deliberate package export. Avoid adding product
identity, authorization, persistence, billing, or provider credentials to the neutral contracts.

## How changes reach this repository

The SDK is developed with its private AgenAI host integrations in a private monorepo. That
monorepo is the source authority, and this repository is a deterministic public projection of the
approved SDK packages.

Maintainers review public pull requests here, import accepted commits into the private authority,
run private integration checks, and export the resulting SDK snapshot back here. The public commit
may differ from the pull request commit because of that integration step. Maintainers preserve the
original contributor's name and email in the imported commit or add an appropriate `Co-authored-by`
trailer.

This workflow lets contributors work entirely in the public repository while keeping SDK and host
changes atomic for AgenAI.
