# Contributing

Thanks for taking the time to work on the AgenAI Agent SDK.

## Before opening a change

For a bug, please include the package version, Node.js version, a small reproduction, and the
behavior you expected. For an API proposal, describe the provider behavior that does not fit the
current contract. Concrete adapter examples are especially useful.

Security reports should follow [SECURITY.md](SECURITY.md) instead of using a public issue.

## Local setup

The repository requires Node.js 22 or newer and pnpm 11.7.0.

```sh
corepack enable
pnpm install
pnpm check
```

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
