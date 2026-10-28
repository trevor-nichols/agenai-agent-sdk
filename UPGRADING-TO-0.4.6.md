# Upgrading to 0.4.6

`0.4.6` is an unpublished coordinated candidate. Agent Protocol remains V13, the sandbox recovery
format remains v3, and no caller or driver change is required when moving from `0.4.5`. Upgrade all
ten packages together.

## What is new

**Credential reuse for native harnesses.** `@agen-ai/sandbox/node` adds explicit helpers for running a
native coding harness with credentials the caller already holds:

- `readSandboxCredentialFile` reads one caller-selected private file with bounded, stable identity
  checks. It never resolves a home directory, keychain or login implicitly.
- `prepareSandboxCredentialBootstrap` writes an offline C bootstrap that the caller compiles into its
  workload image.
- `reserveSandboxCredentialProcess` delivers one file to a private guest directory through that
  bootstrap, inside the same reservation, before the native process starts.

API keys and existing tokens keep using the ordinary explicit process environment. Copied files live
only in the guest's ephemeral HOME and disappear with the sandbox. Nothing is written back to the host.

**Provider recipes.** The public examples under `examples/sandbox/` add closed recipes for Claude Code,
Codex (API key, or a quiescent ChatGPT `auth.json` copy), Grok Build, OpenCode V2 and Cursor CLI. Each
recipe reports secret-free preflight facts. Under restricted HTTPS each recipe requires its declared
destinations to be admitted, then points the native client at the sandbox relay.

**Restricted HTTPS compatibility.** The egress broker now accepts a CONNECT `Host` header that omits the
default `:443` port, as Node's `fetch` sends it. Destination selection and all other rules are
unchanged. This made Node-`fetch` clients such as Cursor CLI work under restricted HTTPS.

## Responsibilities that stay with the caller

- Choose each credential explicitly; recipes never fall back to another key or route.
- For a copied login file with a rotating refresh token, keep every other user of that login stopped
  during the run. A run may rotate the token, after which the original login may need to sign in again.
- Admit every destination a recipe declares, and only those you intend. Account-level integrations,
  such as MCP servers configured on a Cursor account, are separate destinations.
- Verify the prepared image, platform and native executables before reserving. Recipes borrow an
  abstract sandbox and cannot attest an image.

See [the sandbox examples](examples/sandbox/README.md) and the qualification record in the
[sandbox handoff](examples/sandbox/HANDOFF.md#credential-reuse-native-campaigns-2026-10-28).
