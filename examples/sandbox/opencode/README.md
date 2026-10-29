# OpenCode V2 API-key and existing-account recipes

[`reserveSandboxOpenCode`](index.ts) composes exact OpenCode CLI `2.1.2` using the
public sandbox process API. Existing key-only calls retain Anthropic Messages and
`anthropic/claude-haiku-4-5-20251001`. The configured recipe selects an explicit native provider/model
and accepts either an API key or one account from the official native `auth export`. This is a native
CLI example, with no SDK or ACP driver.
The [credential-reuse campaign record](../HANDOFF.md#credential-reuse-native-campaigns-2026-10-28) qualifies the original Anthropic key route on Linux x86_64 and Docker Desktop native arm64; account
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

For the original key-only call, only the supplied key enters `ANTHROPIC_API_KEY`. The replacement environment fixes fresh XDG
roots and `OPENCODE_DB=$HOME/data/opencode/opencode.db` under the guest HOME, disables updates, remote model
fetching, project configuration, Claude imports, free models, filewatching and FFF. Nonsecret
`OPENCODE_CONFIG_CONTENT` pins the model and `providers.anthropic.settings.baseURL` to
`https://api.anthropic.com/v1`, disables the browser plugin and limits provider use to Anthropic.
It contains no auth/key field. Prepare the image without system provider configuration,
external plugins, MCP or skills; import no workspace `.env`, saved accounts or legacy state.
Saved native accounts take precedence over environment connections, so a fresh home and DB
are part of the route contract. Do not mount or copy the host V2 SQLite database. The configured route below imports a selected official export instead.

Runtime generation selects `https://api.anthropic.com:443/v1/messages`, the only endpoint the
native campaign needed. The caller separately prepares its explicit networking policy and
spend bounds; these URL facts do not configure sandbox egress. Missing credentials, unavailable
models or denied destinations are failed/unavailable inputs, with no model or credential fallback.

## Explicit native provider and account import

The configured overload is asynchronous for both keys and account exports. Select the exact native
provider/integration ID and a full `provider/model` identity admitted by the pinned binary and account.
There is no Anthropic-only catalog in this route. Native plugins retain their own authentication,
endpoint and refresh semantics; this example neither implements OAuth nor overrides a provider URL.

```ts
const selected = await reserveSandboxOpenCode(sandbox, {
  guestExecutable: '/opt/agenai/native/opencode', task,
  selection: {
    provider: 'openai', model: selectedOpenAIModel,
    httpsDestinations: ['https://chatgpt.com', 'https://auth.openai.com'],
  },
  preparation: { bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 10_000 },
  credential: { kind: 'auth_export', path: selectedPrivateExport, credentialId: selectedNativeCredentialId,
    lineage: 'access_token_only' },
  signal,
});
```

Use the native `opencode auth export --standalone` interface to create an explicitly selected private
export with mode 0600; never log or retain its output as evidence. The bounded no-follow reader selects
exactly one matching OAuth credential ID and integration, preserves native method metadata for refreshable copies,
and makes that selected entry active in the guest. Other keys/accounts and private account labels are
omitted. Missing, ambiguous, mismatched, key-only or externally managed references fail before process
reservation. External references contain no self-contained account credential; export a native OAuth
entry whose method the prepared binary supports. Native validation and refresh remain authoritative.

For a different API provider, use the same configured shape with
`credential: { kind: 'api_key', value: selectedKey }`, its native provider/model and that provider's
explicit HTTPS origins. This creates a single native key export in memory; it never writes a host secret
file. The import route sets no API-key environment variables. Unknown native integrations or unsupported
methods fail natively; there is no fallback to another credential or provider.

Prepare the public credential bootstrap and copy `guest/launch-opencode.sh` to
`/opt/agenai/examples/opencode/launch-opencode.sh`. The image also needs `/bin/sh` and GNU
`/usr/bin/timeout`. The same owned process privately receives `auth-export.json`, imports it with
`auth import --standalone` into a fresh `$HOME/.agenai-credentials/opencode.db`, removes the export,
then executes the task. Import output is discarded and import failure has a content-free error before
inference. The preparation timeout bounds file delivery and separately bounds native import, followed
by at most one second of termination grace. No existing database is accepted. The original sandbox
owner still owns cancellation, every subprocess and cleanup.

Declare the actual native integration's inference and refresh HTTPS origins. ChatGPT method variants,
Copilot and custom GitLab instances can require different origins; the example above is not an endpoint
allowlist for every OAuth method. Restricted HTTPS requires all declared origins to be admitted before
reservation. Provider/model selection is passed to native policy and CLI as data, never shell code.

`access_token_only` supports the native OpenAI `chatgpt-browser` and `chatgpt-headless` methods. It removes refresh authority and projects only access token, expiry, method and optional native accountID metadata. The selected expiry must be more than five minutes away when the recipe captures the credential. OpenCode 2.1.2 proactively refreshes inside that window even with an empty refresh field, so preflight reports `refresh: not_supplied`, not disabled. A delayed start or later native credential resolution may enter the window and fail before token expiry; obtain a fresh native snapshot and explicitly start a new task only after the prior owner settles. The recipe does not extend expiry, suppress native refresh or replay inference. This permits bounded reuse of an active ChatGPT login without sharing refresh authority or falling back to a key. Other methods require their explicit refresh ownership contract. The native import can also receive an access-only OpenAI credential constructed from an explicitly selected existing ChatGPT login; it does not require a new login or API key.

`caller_quiescent` means all other refreshers of the selected account lineage are stopped. Refreshed
state lives only in the disposable guest database and is not written back to the export or host store.
After native rotation the original snapshot may be stale; reacquire valid native state before reuse.
Keep home/config/database outside workspace exports. Synthetic import proof does not establish live
account entitlement. The [authentication parity record](../HANDOFF.md#authentication-parity-native-campaigns-2026-10-28) separately qualifies the legacy Anthropic key, explicitly configured OpenAI key, and native OpenAI headless import of an existing ChatGPT access token on Linux x64 and native-arm64 Docker Desktop. Other native providers, OAuth methods, refresh behavior and account entitlements require their own live qualification.
