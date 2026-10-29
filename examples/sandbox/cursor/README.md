# Cursor CLI API-key and existing-account recipes

[`reserveSandboxCursor`](index.ts) composes native Cursor CLI
`2026.10.22-27dcf5f` in headless stream-JSON mode using public sandbox processes. It requires an
explicit user API key, existing account token, or selected native account file, and a bounded account-admitted model ID; empty, `auto` and malformed
model choices are rejected. There is no implicit model or credential fallback.

Before construction, independently verify the caller's immutable prepared image, Linux
platform, complete Cursor bundle (including Node/native assets), executable digest and version.
Place the launcher at `/opt/agenai/native/cursor-agent`, use `/workspace/work`, and supply a fresh
private ephemeral `/home/sandbox`. This example borrows an abstract `Sandbox`, which cannot
attest the image or native tuple. Its fixed `preflight` declares the selected route and historical
qualification labels; it never reports the key, task, host source path or caller model text.
Those labels describe the predecessor record rather than attesting the caller's image or account.

```ts
import { reserveSandboxCursor } from './cursor/index.js';
import { runSandboxCli, SandboxCliRunError } from './credentials/index.js';

// All inputs and prepared image/tuple selection belong to the caller.
const selected = reserveSandboxCursor(sandbox, {
  credential: { kind: 'api_key', value: selectedUserApiKey },
  guestExecutable: '/opt/agenai/native/cursor-agent',
  model: selectedAccountModelId,
  task: nonsecretTask,
});
try {
  const observation = await runSandboxCli(selected.reservation, { stdin: 'none', signal });
  // Whole-sandbox stop has settled. Independently inspect the expected exported task artifact.
  await exportAndVerifyExpectedArtifacts(sandbox);
} catch (error) {
  if (error instanceof SandboxCliRunError) await error.retryCleanup();
  throw error;
} finally {
  await sandbox.stop();
  await sandbox.destroy();
}
```

`exportAndVerifyExpectedArtifacts` denotes caller-owned explicit export and byte verification
through `sandbox.exportTree` or the [stopped-tree directory helper](../filesystem.ts).
Retain the original owner for any failed stop/destruction. The shared runner sends EOF, owns
one reader per native output stream, bounds and discards raw output, preserves the original
leader exit receipt and stops the whole sandbox. Exit code, stdout bytes or an empty stderr
alone never establish authentication, model entitlement or task success. If the caller needs
native events, it may consume the reserved streams itself under the same bounded single-reader
and cleanup contract; those events are sensitive and do not belong in reports.

The exact argv is `agent --disable-auto-update --disable-project-configs --print --force --trust
--output-format stream-json --model <selected-model> -- <task>`. Each value is a distinct native
argument; there is no shell fragment. The explicit `agent` command and `--` keep the task a
prompt operand: option-shaped text such as `--model=auto` or a subcommand name such as `login`
cannot select a native flag or command. `--force` permits native guest tools within the caller's
sandbox. It grants no host filesystem callbacks. The task must contain no secret.

For the API-key route the secret destination is `CURSOR_API_KEY`. The replacement environment fixes
`AGENT_CLI_CREDENTIAL_STORE=memory`, `CURSOR_CONFIG_DIR=$HOME/cursor/config`,
`CURSOR_DATA_DIR=$HOME/cursor/data` under the guest HOME, fresh XDG roots, and
`CURSOR_API_ENDPOINT=https://api2.cursor.sh`. No argv secret, host dotenv, service-account document, endpoint override or imported project configuration is accepted.
`DIRENV_DISABLE=1` prevents workspace direnv from overriding the selected environment.
The empty in-memory store avoids reusing native persisted refresh state. Home/config/data must
remain outside workspace exports and disappear only after whole-sandbox stop/destruction.

The selected user-key exchange is
`https://api2.cursor.sh:443/auth/exchange_user_api_key`. The declared HTTPS/443 hosts are
`api.cursor.com`, `api2.cursor.sh`, `api5.cursor.sh`, `agent.api5.cursor.sh`, `agentn.api5.cursor.sh`,
`agent.us.api5.cursor.sh`, `agentn.us.api5.cursor.sh`, `agent.global.api5.cursor.sh` and
`agentn.global.api5.cursor.sh`. The native campaign observed this set as sufficient for a CLI file
task. MCP servers configured on the Cursor account (for example Slack or Notion) are separate
destinations; under restricted HTTPS they are refused unless the caller admits them.
The caller owns explicit egress/spend policy; this metadata does not install an allowlist.
A denied destination stays a failed attempt requiring evidence and an intentional policy revision.

A browser login is not an exported user key. This recipe performs no login, implicit token extraction,
credential-store inspection, installer or download. It does not claim Cursor SDK or service-account
task support. Current SDK user/service-account capabilities and independent SDK history browsing
qualification do not qualify this CLI composition. The [0.4.6 follow-up](../HANDOFF.md#credential-reuse-native-campaigns-2026-10-28)
records normal file tasks and cancellation after observed native entry with `grok-4.7-medium` on
the exact Linux x64 and Desktop native arm64 tuples, with explicit Engine 404 cleanup evidence.
Other models, accounts and changed inputs require their own proof; Rosetta Linux amd64 remains
unqualified for this credential route.

## Existing account selection

An explicitly supplied native token uses `credential: { kind: 'auth_token', value: selectedToken }`.
The synchronous return shape is unchanged. This maps only `CURSOR_AUTH_TOKEN`, leaves
`CURSOR_API_KEY` absent and uses the empty in-memory native store. It does not select user-key exchange.

For a selected native file, await the asynchronous overload:

```ts
const selected = await reserveSandboxCursor(sandbox, {
  guestExecutable: '/opt/agenai/native/cursor-agent', model: selectedAccountModelId, task: nonsecretTask,
  credential: { kind: 'auth_json', path: selectedPrivateAccountFile, lineage: 'caller_quiescent',
    bootstrapExecutable: '/opt/agenai/bin/agenai-credential-bootstrap', preparationTimeoutMs: 10_000 },
  signal,
});
```

The file must contain native `accessToken` and `refreshToken` strings. The bounded no-follow reader
projects only those fields: a key, Bedrock credential or other account-store data cannot override them.
Prepare the public credential bootstrap and copy `guest/launch-cursor.sh` into
`/opt/agenai/examples/cursor/launch-cursor.sh`. Its single owned process moves the privately delivered
file into `$HOME/.agenai-credentials/cursor/auth.json` with directory/file modes 0700/0600, selects
`AGENT_CLI_CREDENTIAL_STORE=file` and `XDG_CONFIG_HOME=$HOME/.agenai-credentials`, then execs the CLI.
Neither API-key nor token environment overrides are present. The native Linux file store uses XDG;
`CURSOR_CONFIG_DIR` alone does not redirect authentication. The macOS default can use Keychain, so a
missing host JSON file does not mean the user is logged out. Host-store export is explicit caller work.

All concurrent consumers of the selected refresh lineage must be stopped before file reuse. Guest
state is disposable with no host writeback. The pinned native refresh helper inspected here refreshes
API-key sessions; this example does not promise renewal of a saved account token or indefinite token
lifetime. Native authentication failure stays failure. The live token route has the separate record below; the refreshable file alternative has no live renewal qualification. Keep all account files out of workspace exports, images, tasks and retained reports.

The [authentication parity record](../HANDOFF.md#authentication-parity-native-campaigns-2026-10-28) adds real existing-account `auth_token` and API-key normal/cancellation proof on Linux x64 and native-arm64 Docker Desktop. The token was read from the existing native macOS credential store by the explicitly authorized campaign controller. The SDK takes the selected token explicitly; it does not discover keychain entries. The refreshable `auth_json` alternative retains deterministic and native synthetic file-store proof, without a live renewal claim.
