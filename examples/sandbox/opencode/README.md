# OpenCode V2 standalone API-key recipe

[`reserveSandboxOpenCode`](index.ts) composes exact OpenCode CLI `2.1.2` using the
public sandbox process API. It selects Anthropic Messages and
`anthropic/claude-haiku-4-5-20251001`; this is a native CLI example, with no SDK or ACP driver.
The [credential-reuse campaign record](../HANDOFF.md#credential-reuse-native-campaigns-2026-10-28) qualifies this route on Linux x86_64 and Docker Desktop native arm64; account
entitlement elsewhere is not implied. The secret-free `preflight` describes the selected route and endpoint only.

Before construction, the caller must independently verify its immutable prepared image,
Linux platform, complete native dependency closure and executable digest/version. Install the
matching executable at `/opt/agenai/native/opencode`, use workspace `/workspace/work`,
and start with a fresh private ephemeral `/home/sandbox`. The abstract `Sandbox` handle has no
image attestation API, so accepting this recipe does not perform those checks. No installer,
model catalog download or credential discovery runs here.

```ts
import { reserveSandboxOpenCode } from './opencode/index.js';
import { runSandboxCli, SandboxCliRunError } from './credentials/index.js';

// `sandbox` is a caller-owned ready sandbox whose prepared tuple was verified before start.
// `selectedKey` is explicitly supplied by the caller; `task` is bounded nonsecret text.
const selected = reserveSandboxOpenCode(sandbox, {
  credential: { kind: 'api_key', value: selectedKey },
  guestExecutable: '/opt/agenai/native/opencode',
  task,
});
try {
  const observation = await runSandboxCli(selected.reservation, { stdin: 'none', signal });
  // The returned leader receipt and output byte counts do not establish auth or task success.
  // The runner has stopped the whole sandbox. Export selected artifacts and verify expected bytes.
  await exportAndVerifyExpectedArtifacts(sandbox);
} catch (error) {
  if (error instanceof SandboxCliRunError) await error.retryCleanup();
  throw error;
} finally {
  await sandbox.stop();
  await sandbox.destroy();
}
```

`exportAndVerifyExpectedArtifacts` is the caller's own explicit artifact selection and
verification, using `sandbox.exportTree` or the [stopped-tree directory helper](../filesystem.ts).
Keep the original sandbox owner if stop or destruction fails; retry that owner. The shared
runner closes stdin, consumes stdout and stderr once under fixed byte/event bounds, retains the
original leader receipt (including nonzero exits), and discards raw output. It does not parse
native events into an authentication assertion. Callers needing sensitive native events can own
the reserved streams directly, with one reader and the same stop/export/destruction obligations.

The task is exactly one argv element after `run --standalone --format json --model
anthropic/claude-haiku-4-5-20251001 --agent build --auto --`. The `--` delimiter makes it the
run message, so option-shaped text such as `--model=…` or `--server=…` cannot select a native
flag. Native tools run inside the sandbox;
`--auto` is not a host tool callback or permission grant. Do not place secrets in the task,
workspace, image or output artifact.

Only the supplied key enters `ANTHROPIC_API_KEY`. The replacement environment fixes fresh XDG
roots and `OPENCODE_DB=$HOME/data/opencode/opencode.db` under the guest HOME, disables updates, remote model
fetching, project configuration, Claude imports, free models, filewatching and FFF. Nonsecret
`OPENCODE_CONFIG_CONTENT` pins the model and `providers.anthropic.settings.baseURL` to
`https://api.anthropic.com/v1`, disables the browser plugin and limits provider use to Anthropic.
It contains no auth/key field. Prepare the image without system provider configuration,
external plugins, MCP or skills; import no workspace `.env`, saved accounts or legacy state.
Saved native accounts take precedence over environment connections, so a fresh home and DB
are part of the route contract. Never copy a host V1 store, V2 SQLite database or auth file.

Runtime generation selects `https://api.anthropic.com:443/v1/messages`, the only endpoint the
native campaign needed. The caller separately prepares its explicit networking policy and
spend bounds; these URL facts do not configure sandbox egress. Missing credentials, unavailable
models or denied destinations are failed/unavailable inputs, with no model or credential fallback.
OpenCode OAuth, OpenCode Go keys and account export/import are outside this recipe.
