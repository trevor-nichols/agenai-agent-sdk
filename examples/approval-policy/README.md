# Explicit approval policies

This example teaches the runtime contract and provides an opt-in runner for the
owned Grok Docker composition. Its exact Grok 1.0.77 / `grok-4.6` personal-account composition
passed seven behavioral cases each on Linux x64 and native-arm64 Desktop; see the
[qualification/release handoff](HANDOFF.md). A successful teaching fixture is still separate from
native reviewer/account/isolation evidence. Use the matching `0.4.14` package family and built source checkout; the preceding
ten-package `0.4.13` release lacks these additions.

## Start without credentials

From the standalone SDK checkout:

```bash
pnpm examples:approval-policy
pnpm test:examples:approval-policy
```

The [walkthrough](walkthrough.ts) uses public entrypoints and an explicitly labeled teaching
adapter. It displays support, requested policy and effective policy for omission, explicit
`host`, `provider_auto_review` and `provider_bypass`. Each selected-policy fixture still emits a
genuine host approval. The example selects the exact offered once-only consequence, waits for
its delivery receipt, drains the sole reader, closes the original session and disposes its registry.
It then independently reads a marker written by the fixture. A separate denied row proves marker
absence. This demonstrates request handling and actual bounded filesystem effects; no native AI
review is simulated or asserted.

A separate unwrapped generic ACP fixture rejects explicit auto-review before opening a session,
sending a prompt or writing its marker. Omission then completes normally. Accepting ACP metadata
does not confer normalized policy support.

The default command releases its temporary directory. To inspect fixture effects yourself, call
`runApprovalPolicyWalkthrough({ artifactDirectory: absoluteFreshDirectory })` from
`walkthrough.ts`; the directory must not exist and becomes yours to remove. The test command also
covers credentialless native configuration, residual selection and authorization accounting. It
never runs a model or Docker workload.

## Choose policy independently from authority

| Choice | Contract |
| --- | --- |
| Omission | Preserve existing provider behavior without asserting an effective policy. |
| `host` | Explicitly select the provider's supported host approval behavior. |
| `provider_auto_review` | Native review applies to eligible actions; native preapprovals, denials and residual host requests remain meaningful. |
| `provider_bypass` | Native approval bypass applies within the existing filesystem, network and host-tool authority. |

Read `instance.adapter.approvalPolicy` and its operation-specific descriptors. After opening with
an explicit supported selection, inspect `session.approvalPolicy.policy` and `.verification`;
omission leaves that result absent for existing providers. The fixed Grok constructor is stricter:
it advertises only its immutable constructor policy for fresh `create` and requires the same explicit
selection, including `host`. Choose a fresh profile/image/owner to change policy. The validated
runtime refuses an unsupported explicit selection, a missing confirmation or a mismatched result. It does not silently
switch policies. See the [runtime contract](../../packages/agent-runtime/README.md#select-an-approval-policy)
for the exact public names and error codes.

Keep consuming the original output stream. Answer residual approvals only by exact offered ID and
consequence, and retain the original cleanup owner after an uncertain result. Auto-review and bypass
do not answer forms or mandatory questions on your behalf. `generateObject` may still require
`onRequest`; without it a request produces `interaction_required`. Structured output requires separate
provider support and is absent from this Grok shell composition.

## Prepare the controlled native composition

```bash
pnpm examples:approval-policy:native --help
pnpm examples:approval-policy:native check-config --config /absolute/prepare.json
pnpm examples:approval-policy:native prepare --config /absolute/prepare.json
```

`check-config` parses a bounded physical JSON file, validates its closed configuration and constructs
the public route authority without observing the Engine, reading credentials or entering inference.
`prepare` writes a credential-free offline context. It does not build, pull, download, install or
execute Grok. Configuration paths must be absolute, normalized physical paths; unknown fields and
missing required inputs fail explicitly. Help needs no configuration and has no filesystem effects.

The complete [preparation template](native/prepare-config.example.json) has this shape; replace
the digest and identities with your actual inputs:

```json
{
  "format": "agenai.approval-native-prepare.v1",
  "provider": "grok",
  "mapping": "grok-build-1.0.77-controlled-shell-v1",
  "profile": {
    "instanceId": "grok:approval-example",
    "nativeSessionId": "11111111-1111-4111-8111-111111111111",
    "policy": "provider_auto_review",
    "deniedBashPatterns": ["git reset --hard*"],
    "credentialBootstrap": { "sha256": "<compiled SDK bootstrap SHA-256>" }
  },
  "preparation": {
    "directory": "/absolute/fresh/build-context",
    "dockerProfile": "linux-x64",
    "baseImageDigest": "sha256:<actual pinned base digest>"
  }
}
```

Prepare and compile the unmodified SDK credential bootstrap explicitly, supply the exact native
Grok executable and compiled helper to the context, and build the emitted Dockerfile using the
selected platform with networking and pulling disabled. Follow the
[provider preparation contract](../../packages/provider-grok/README.md#explicit-offline-preparation).
The caller owns the trusted base, toolchain, context and final image. Rebuild after any change to
inspected launcher/profile bytes; earlier images are not interchangeable.

`profile.deniedBashPatterns` is optional and uses Grok's native Bash **prefix or glob** matching,
not exact-command matching. It supplies deny rules only, including under bypass; no allow, ask or
remembered grant is introduced. Strings and order are preserved. Limits are 32 patterns, 4,096
UTF-8 bytes each and 16,384 bytes total, with no empty string, C0/DEL control or malformed Unicode.
An empty list adds no rule. Use the identical list when preparing and running an image; changing it
requires rebuilding and qualifying the changed candidate. The example's `git reset --hard*` exclusion
illustrates native prefix/glob syntax, not an executed git-prefix qualification. The actual live
hard-deny positive-control comparison used `['*']` under bypass; configured denial is separate from
genuine classifier Block evidence.

Only Grok Build `1.0.77` / build `50ca579fa996`, model `grok-4.6`, Linux x64 and native-arm64 Docker
Desktop are admitted. Each image binds one fresh native UUID, instance identity and policy. The
profile exposes only the native terminal tool and fixes its protected configuration, permission
stores, hooks, MCP, remote-policy exclusions and control-channel protections. It cannot resume,
branch, change mode/model, add host bindings, invoke native Task, use raw slash operations or enable
structured output. A successful opening returns `verification: 'controlled_configuration'`; it is
an opening fact, not proof that every shell action received a classifier decision.

## Run one explicit native turn

```bash
pnpm examples:approval-policy:native check-config --config /absolute/run.json
pnpm examples:approval-policy:native run --config /absolute/run.json
```

The run format is `agenai.approval-native-run.v1`, with the same `provider`, `mapping` and `profile`
as preparation. Start with the complete [Linux run template](native/run-config.example.json), replace
every `/ABSOLUTE/...` path, zero digest and sample identity with the actual prepared inputs, and use
the same fresh UUID/profile as the image. The template is credential-free and cannot run unchanged.
Its remaining required inputs are defined in [native/config.ts](native/config.ts):

| Field | Required meaning |
| --- | --- |
| `runId` | Unique lowercase token for one attempt; never reuse after reservation. |
| `backend` | Actual Docker endpoint, admitted final image digest, profile, namespace, private spill directory, non-root user and explicitly prepared egress infrastructure. |
| `workload` | Finite resources, home/temp storage, execution/startup/cleanup deadlines, transfer buffers and stream limits. |
| `credential` | `{ "kind": "auth_json", "path": "/absolute/selected/auth.json" }`. |
| `workspace` | Separate physical import directory, fresh export destination, finite transfer timeout and file/path/byte quotas. |
| `prompt` | Bounded text for one SDK turn; no leading slash operation. |
| `residual` | Explicit `{ "kind": "cancel" }`, `{ "kind": "approve_once" }` or `{ "kind": "deny_once" }`. |
| `limits` | `runMs`, `maxOutputEvents`, `maxOutputBytes`, `cleanupAttempts` (one to three), and optional `maxToolActions` (integer one to 100,000). |
| `reservation` | Private existing `ledgerDirectory`, `campaignId`, `currency: "USD"`, integer `maximumCents` and `amountCents`. |
| `artifactsDirectory` | Fresh private output directory under a physical caller-owned parent. |

The existing restricted-HTTPS deployment must be prepared independently. The configuration builds
an original platform-specific route authority through the public `/node` constructor; it cannot
substitute a verifier, borrowed ACP peer or injected execution backend. Read the
[network prerequisites](../sandbox/README.md#restricted-network-composition). Native HTTP(S) proxy variables are fixed to
the sandbox CONNECT proxy; the sole admitted remote authority is `cli-chat-proxy.grok.com:443` with
ordinary TLS. This is hostname/port admission, not URL-path filtering. No alternate model, native
API endpoint, registry, telemetry, login or refresh destination is added on failure.

For native-arm64 Desktop, set `backend.egress.routeAuthority.commandTimeoutMs` to **5000**, retaining
the recorded 1000 ms poll interval and 20000 ms helper lease. The campaign's 1000 ms command deadline
failed during preparation because it could not cover stable observations/endpoint settlement. The
existing deployment, original host/VM observer pins and quiescence assumptions still apply. On the
qualified Linux host `ipExecutable.path` is the physical **`/usr/bin/ip`**; `/usr/sbin/ip` is a symlink
and was refused by `O_NOFOLLOW`. Prepare and hash your host's actual physical executable. The Linux
template's path/hash are placeholders; neither these corrections nor a policy change widens grants.

The credential route accepts an explicitly selected, bounded existing personal first-party OIDC
`auth.json` with a future access-token expiry. The SDK strips refresh authority from the injected
copy and leaves the original file untouched. An explicit personal `User` with matching principal/user
IDs may carry its billing team ID; admitted native privacy metadata is preserved. Team principals,
organization/deployment identities and API-key routes are outside this initial mapping. The guest
can read its own copied access credential. This example does not scan secret stores, refresh an account or add keys to image layers.

Each run consumes a durable exact-cent authorization reservation before reading credentials or
contacting Docker. One campaign ledger has an immutable ceiling; duplicate run IDs/native UUIDs,
inconsistent campaign settings, exhaustion and existing locks fail. There are no automatic refunds
or stale-lock removal. A reservation limits authorized attempts; it is **not a provider billing cap**.
One SDK turn can contain several foreground/reviewer requests, and a failed attempt may be charged.
Reconcile a crash and its original resources before any new attempt.

Residual `approve_once` or `deny_once` selects exactly one offered option with that decision and an
exact-action once-only consequence. Missing or ambiguous choices cancel and fail; the example
never chooses a remembered grant or invents an option. Explicit `cancel` cancels a residual request
and reports failure after cleanup. Approving a reviewed Block is a deliberate host decision, so use
`cancel` when the intended experiment must preserve native refusal.

The runner uses one original output reader, bounds event count and retained accounting, and reacts
to its deadline or SIGINT/SIGTERM through the original owners. It closes the session and instance,
exports the retained workspace after settled stop, then destroys the outer provider. Import,
generation and export are never automatically replayed. Cleanup retries use their original owner.
Delete the borrowed image only after confirming workload destruction.

Optional `limits.maxToolActions` requests an observational stop when the original reader first sees
that many distinct normalized action-item IDs across `item.started`, `item.updated` and
`item.completed`. Repeated lifecycle snapshots count once, including an item first seen in an update
or completion. The ACP adapter represents tool actions as `dynamic_tool_call`; that generic kind
does not identify the native tool class. Other normalized action kinds also count if observed. Assistant messages, plans, reasoning and unknown
items do not count. `output.observedToolItems` reports only the distinct count, without item IDs,
commands or native text. Omitting the limit preserves ordinary execution without a proactive stop.

At the threshold the runner starts cancellation through its original owners and keeps draining its
sole reader. It retains later counts and native terminal observations, and does not approve later
residual requests. The report records `toolActionLimit.outcome: "stop_requested"`, the threshold
observation count, `failureCode: "tool_action_limit"` and, after settled cleanup, `status: "cancelled"`.
The CLI exits nonzero for this intentional stop, even if a native `completed` observation races it.
Cleanup can still report `cleanup_pending` and retain its original retry owner. An unreached configured
limit reports `outcome: "not_reached"`. Existing output and time bounds remain independent.

This is **not a hard native invocation quota**: a tool may already have run before its item is
observed, and concurrent or queued work can produce further observations and effects after stopping
starts. The final observed count can exceed `maxToolActions`; it is never clamped. Missing or unknown
item mappings are not proof that no native action occurred. Inspect actual exported effects separately.

For a live bypass row with finite observation, copy the preparation and run inputs, set
`profile.policy` to `"provider_bypass"` in **both**, and choose the same fresh instance/UUID for them.
Prepare and explicitly build that matching image as above, then put its actual admitted digest into
the run input. Keep a finite `limits.maxToolActions` (the run template uses four) alongside the existing
deadlines/output bounds. With the owned account, reservation, workspace and egress inputs populated:

```bash
pnpm examples:approval-policy:native check-config --config /absolute/bypass-run.json
pnpm examples:approval-policy:native run --config /absolute/bypass-run.json
```

That selects bypass in the frozen image/profile and observes bounded stopping through the same
documented CLI. It grants no additional filesystem/network access, child-agent entrypoint or host
observer port. A prompt is an instruction to the model, not enforcement of an action count.

## Read evidence and recover cleanup

Standard output contains bounded JSON status, requested/effective policy, residual delivery receipts,
transfer counts and cleanup outcome. It omits credential values, prompt text, model output and raw
native error messages. Independently inspect the exported workspace for the expected effect; a
delivery receipt or `completed` result alone does not prove the requested change.

The fresh artifact directory retains `report.json`, immutable numbered original Sandbox recovery-v3
checkpoints and a latest-record pointer. Persisting starts with initial reservation; do not reconstruct
or translate records from CLI flags. Use the [existing recovery runbook](../sandbox/recovery/README.md)
and the original platform/route ownership for cleanup only. Recovery never resumes a session or
replays a turn. A separately recorded inspection cleanup identity is evidence about that distinct
owner, not an executable cross-process Sandbox recovery record.

Programmatic callers can import `nativeCommand` and `NativeCleanupPendingError` from `native.ts`.
Retain that error and await its `retryCleanup()` to retry only the remaining original cleanup;
keep the process alive until it settles. After its initial bounded attempts, the CLI retains the
original owner and stays alive, even with closed stdin. Its pending JSON status includes `processPID`
and a `cleanupRetryInstruction` such as `kill -USR2 12345`. After correcting the cleanup prerequisite,
send that signal to request one original cleanup retry. SIGINT and SIGTERM also request cleanup;
concurrent signals join the entered retry without queueing extra attempts. There is no automatic
retry loop. Diagnostic-write failure does not release a pending owner. Successful cleanup ends the
CLI with a nonzero exit for the original failed run.

SIGKILL or process loss cannot preserve an in-process inspection retry handle; its saved identity
alone cannot replace that owner. Persisted Sandbox recovery and inspection cleanup remain separate
responsibilities. Wait for settled cleanup before terminating the controller, and never rerun the
native command to retry cleanup.

Credentialless and packed-package checks cover fixture effects, public declarations, configuration,
authorization accounting, inert native help and the pending controller's process/signal lifecycle.
The test command imports tests in one process so Node's test-child supervisor does not intercept
the controller's signals. Those tests do not themselves qualify an account, native reviewer,
kernel protection or live cleanup. The separate completed native matrix, original failed attempts,
exact R5/R6 relationship and release prerequisites are in [HANDOFF.md](HANDOFF.md). Its Option A
memory/fd0/fd1 denial and incomplete descriptor sample do not establish complete original control-pipe
alias exclusion. Native logs are diagnostics, not per-action/auth-method attestation, and observed
review does not guarantee classifier correctness or every-action review. Native Task exclusion
retains its detailed composition/historical scope; no new direct adversarial Linux dispatch is
claimed. Actual provider charges remain unobserved.
