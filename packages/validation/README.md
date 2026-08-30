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

The package source is `0.2.0` and ships in lockstep with Agent Protocol V7 and
`@agen-ai/agent-runtime@0.2.0`. Its ordinary validator-neutral surface is unchanged from `0.1.0`;
the coordinated version advance prevents consumers from resolving a mixed SDK release set.

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
