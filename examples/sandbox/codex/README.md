# Codex 0.163.0 native CLI sandbox example

This example borrows one public sandbox and reserves **Codex CLI 0.163.0 `exec`**. It offers two mutually exclusive supplied-credential routes. It does not implement the TypeScript SDK, app-server, ACP, login, keychain export or a refresh coordinator. The API-key route passed normal and entered-native cancellation rows on the exact Linux x64 and Docker Desktop native arm64 tuples in the [0.4.6 follow-up record](../HANDOFF.md#credential-reuse-native-campaigns-2026-10-28). The historical follow-up deferred its four `auth_json` rows. The current correction adds access-token-only reuse for active existing logins; its real key/account normal and cancellation qualification on both platforms is in the [authentication parity record](../HANDOFF.md#authentication-parity-native-campaigns-2026-10-28). Earlier saved-auth reports retain their historical scope and do not establish the follow-up's cancellation or explicit-404 cleanup guarantees.

| Selected route | Explicit input | Native destination |
| --- | --- | --- |
| `api_key` | `{ kind: 'api_key', value: selectedKey }` | Only `CODEX_API_KEY`; native API login and ephemeral credential store |
| `auth_json` | `{ kind: 'auth_json', path: selectedPhysicalFile, lineage: 'access_token_only', bootstrapExecutable, preparationTimeoutMs }` | Private native `chatgptAuthTokens` projection without refresh authority; existing active login reuse |
| Refreshable `auth_json` | The same input with `lineage: 'caller_quiescent'` | Byte-exact native ChatGPT file copy; caller owns exclusive refresh lineage |

Codex refuses a `CODEX_HOME` that does not exist. The API-key route therefore uses the guest's private temporary HOME, `/home/sandbox`, itself; the file route uses `$HOME/.agenai-credentials`, which its bootstrap creates with the selected `auth.json`. The fresh environment contains only HOME/TMPDIR/PATH/language defaults, CODEX_HOME and the one selected key when applicable. No OPENAI_API_KEY, bearer token, custom provider, endpoint override or host config is merged. The fixed native argv contains 72 arguments, with global approval controls before `exec`, an explicit `gpt-6-luna`/`low` selection, stdin task `-`, JSON output and ephemeral sessions. Native tools and their descendants execute inside the existing outer sandbox; Codex's selected `danger-full-access` delegates containment to that outer boundary.

The caller must verify its exact image/binary/platform and launcher closure before calling `reserveSandboxCodex`. Both Linux x64 and arm64 need their independently verified Linux binaries; a host Darwin executable is not a guest artifact. The canonical absolute `guestExecutable` is explicit and never resolved through controller PATH. The prepared image and imported workspace must contain no system/project Codex configuration, requirements or managed policy, MCP definitions, hooks or skill roots. The API-key route begins with an empty CODEX_HOME; the file route begins with only its selected auth file. The fixed configuration disables updates, web search, telemetry, MCP, project instructions, plugin/app/hook/delegation discovery and host skill discovery. These declarations are recipe choices; they do not attest an arbitrary supplied image or prove native enforcement.

Prepare the bootstrap for the file route explicitly through the public installed helper:

```ts
import { prepareSandboxCredentialBootstrap } from '@agen-ai/sandbox/node';

const preparation = await prepareSandboxCredentialBootstrap({ directory: freshPhysicalBuildContext });
// Independently build its fixed native assets offline into the selected Linux image.
// No credential is an image/build-context input. Verify the resulting image and executable.
```

The helper never invokes a compiler, starts Docker or downloads anything. The selected `bootstrapExecutable` must refer to that verified helper in the same prepared guest image. `preparationTimeoutMs` is an explicit integer from 1 to 60,000 covering only attachment and private file preparation. It does not set the native task lifetime; choose a finite sandbox execution policy and a separate caller cancellation signal. The optional `signal` passed to `reserveSandboxCodex` cancels before reservation. An abort before the call rejects with the signal's reason. An abort during the bounded host read surfaces as the reader's content-free source error, so classify cancellation through `signal.aborted`. An abort observed after the read still reserves nothing, and the recipe wipes its copied bytes.

The following complete caller function imports its known workspace input, runs a task, stops native descendants, exports one selected artifact and destroys storage. The passed backend/request must already select the verified image, finite resource/deadline/output policy and explicit admitted HTTPS destinations. The credential is supplied by the caller, with no environment or home-directory lookup:

```ts
import { SandboxCleanupError, type SandboxBackend, type SandboxRequestInput, type SandboxTreeSource } from '@agen-ai/sandbox';
import { reserveSandboxCodex, type SandboxCodexCredential } from './index.js';
import { runSandboxCli, SandboxCliRunError } from '../credentials/index.js';
import { collectSandboxFiles } from '../collect.js';

async function runPreparedCodex(input: {
  backend: SandboxBackend;
  request: SandboxRequestInput;
  entries: SandboxTreeSource;
  credential: SandboxCodexCredential;
  guestExecutable: string;
  signal: AbortSignal;
}) {
  const owner = input.backend.reserve(input.request, { kind: 'in_process' });
  let observed;
  try {
    const sandbox = await owner.start({ signal: input.signal });
    await sandbox.importTree(input.entries, { signal: input.signal });
    const launch = await reserveSandboxCodex(sandbox, {
      guestExecutable: input.guestExecutable,
      credential: input.credential,
      signal: input.signal,
    });
    const result = await runSandboxCli(launch.reservation, {
      stdin: { kind: 'utf8', text: 'Read input.txt and write its uppercase contents to result.txt using guest tools.' },
      signal: input.signal,
    });
    // Native descendants have stopped. Check the bytes against the known expected task effect.
    const files = await collectSandboxFiles(sandbox, ['result.txt'], 64 * 1024);
    observed = { kind: 'observed' as const, preflight: launch.preflight, result, files };
  } catch (error) {
    if (error instanceof SandboxCleanupError
      || (error instanceof SandboxCliRunError && error.cleanupFailure !== undefined)) {
      // Return the exact cleanup obligations to the caller; do not replay the task.
      return { kind: 'cleanup_pending' as const, error, owner };
    }
    await owner.destroy();
    throw error;
  }
  await owner.destroy();
  return observed;
}
```

The caller can abort its `AbortController` while the single reader remains owned by `runSandboxCli`. For `cleanup_pending`, keep both returned objects, explicitly await `error.retryCleanup()`, then await `owner.destroy()`. The runner preserves the leader's original receipt, including nonzero, signaled or unavailable observations; it does not infer authentication or task success from that receipt. Native diagnostic bytes are discarded. Consumers needing a native JSONL protocol can instead own `launch.reservation.start()` and its sole stdout reader directly, separately drain stderr, and retain the same whole-owner stop/export/destroy obligations.

The `auth_json` source is an explicit canonical absolute physical path. The public bounded source reader admits only a stable, single-linked, controller-owned regular file of 1–65,536 bytes with private permissions and no symlink traversal. The caller must trust and exclusively own its source hierarchy. Before any process reservation, refreshable copies require native `auth_mode: "chatgpt"` and nonempty access, ID and refresh tokens. Access-token-only reuse accepts `chatgpt` or native `chatgptAuthTokens` sources with access/ID tokens and a nonempty account ID; no refresh token is needed. Neither accepts a populated OPENAI_API_KEY. Malformed or competing routes reject with content-free errors. Refreshable copies preserve additional fields and original whitespace. Access-token-only reuse projects only native account tokens/identity into `chatgptAuthTokens`, with an empty refresh token and no API key. The native external-token mode does not perform OAuth refresh, so it cannot invalidate the host refresh lineage. Shape compatibility does not establish token validity or expiry. The example clears its read byte buffer after the public bootstrap owner has captured its private copy.

`lineage: 'access_token_only'` can reuse an active login while other consumers run. It lasts only as long as the selected access token; reacquire current native state for a later run. It does not refresh or replay a failed task.

`lineage: 'caller_quiescent'` acknowledges that every other native consumer of the copied rotating credential lineage is stopped. A native refresh can invalidate the source or another copy. The source is never modified; refreshed guest state is disposable, excluded from workspace export and never written back. No concurrent refresh coherence, repeated-copy continuity, expired-token fallback or automatic retry is provided. Supply a newly valid selected source after native failure.

Preflight contains only declared provider/version/transport/route/source kind/native destination, selected model/reasoning, destinations, refresh ownership and static historical qualification labels. Its `observed_in_ms005_native_campaign` and `recorded_linux_x64_and_desktop_native_arm64` values describe the predecessor record; they do not attest the borrowed sandbox, current credentials or fresh saved-auth qualification. API-key egress is `api.openai.com:443`; selected ChatGPT egress is `chatgpt.com:443` plus `auth.openai.com:443` in the recorded endpoint set. Access-token-only selection disables refresh; the refreshable alternative may use the auth endpoint. Endpoint sufficiency and proxy compatibility remain specific to the separately recorded native tuple; no wildcard or automatic host addition is selected. Preflight does not contain the key, source path, cache fields or token hashes. An `auth_json` launch uses one process with the original cleanup identity: the bootstrap first confirms its protocol, consumes the private prefix, closes mode0600 auth.json under mode0700 private HOME state, and replaces itself with Codex. Native prompt bytes start after that prefix and are never credential bytes.
