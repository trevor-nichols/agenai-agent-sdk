# `@agenai/validation`

`@agenai/validation` defines a small, validator-neutral issue format for reusable packages. It
normalizes validation failures without making an ordinary public API expose a particular schema
library. The optional Zod entrypoint adapts Zod 4 issues to the same stable shape.

## Entrypoints

- `@agenai/validation` exports plain issue types plus normalization functions. Its declarations do
  not expose Zod.
- `@agenai/validation/zod` exports the deliberate Zod 4 adapter and may expose Zod types.

```ts
import { normalizeValidationIssues } from "@agenai/validation";

const issues = normalizeValidationIssues(
  [{ code: "invalid_type", path: ["sessionId"], message: "Invalid input" }],
  { sessionId: 42 },
);
```

Consumers should treat `ValidationIssue.code`, `path`, and `message` as the portable error
contract. Validator-native errors remain implementation details unless the consumer explicitly
imports `/zod`.

## Versioning and release

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
