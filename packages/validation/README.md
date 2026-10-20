# `@agen-ai/validation`

`@agen-ai/validation` defines a small, validator-neutral issue format for reusable packages. It
normalizes validation failures without making an ordinary public API expose a particular schema
library. The optional Zod entrypoint adapts Zod 4 issues to the same stable shape.

## Entrypoints

- `@agen-ai/validation` exports plain issue types plus normalization functions. Its declarations do
  not expose Zod.
- `@agen-ai/validation/zod` exports the deliberate Zod 4 adapter and may expose Zod types.

```ts
import { normalizeValidationIssues } from "@agen-ai/validation";

const issues = normalizeValidationIssues(
  [{ code: "invalid_type", path: ["sessionId"], message: "Invalid input" }],
  { sessionId: 42 },
);
```

Consumers should treat `ValidationIssue.code`, `path`, and `message` as the portable error
contract. Validator-native errors remain implementation details unless the consumer explicitly
imports `/zod`.

## Versioning and release

The package participates in the coordinated `0.4.3` release with Agent
Protocol V12. Published `0.4.1` retains V11 and the earlier `0.4.0` release retains V10.
Public `0.3.0` and `0.3.1` SDK releases
implemented V9 and remain the prior protocol generation. This package's ordinary validator-neutral
surface is unchanged from `0.1.0`; coordinated versioning prevents consumers from resolving a mixed
SDK release set.

All seven packages must use one coordinated version, even when this package's issue surface is
unchanged. The [0.4.2 migration guide](../../MIGRATING-TO-0.4.2.md) describes request retirement,
tagged session responses and the runtime/store changes; those lifecycles belong to their respective
packages rather than this validator-neutral prerequisite. Source readiness does not publish archives
or change registry tags.

The package follows semantic versioning. Breaking changes to ordinary types, normalized issue
semantics, or exported entrypoints require a major release. Additive issue helpers and compatible
normalization improvements may be minor releases; fixes that preserve the public contract are
patch releases.

The repository check builds and packs this package, inspects the tarball, and installs it into a
temporary project outside the workspace. Run it from the public repository root:

```sh
pnpm check
```

That command never publishes. Registry publication, tags, and release credentials are separate
release operations.
