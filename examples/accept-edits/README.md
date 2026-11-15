# Accept edits with the Claude and OpenCode Node providers

This example selects `provider_accept_edits` for one fresh Claude or OpenCode session,
runs one text turn and prints a report of what actually happened. Under that policy, ordinary
structured creates/updates and all-eligible patches inside the prepared workspace apply without a
prompt. Explicit denies win, while protected paths and explicit asks retain host involvement. Every shell command still asks, and
restricted paths ask with the reason `restricted`. The example answers each request exactly once
for the exact action and denies everything it was not told to approve. Use the matching `0.4.14` package family and built source checkout; the preceding ten-package
`0.4.13` release lacks these additions.

## Requirements

- The qualified Linux x64 host or Linux arm64 Docker Desktop workload, exactly Node 24.18.0,
  and a non-root user/group. Native Darwin is unsupported. On Desktop run the entire example,
  provider and broker inside the prepared guest, not the Mac Node process.
- The native Claude or OpenCode executable, `bwrap` and the AgenAI filesystem helper at the exact
  identities pinned by the installed provider packages. The tool owner refuses anything else
  before a session opens.
- An API key in a private file: a regular file owned by you, mode `0600` or `0400`, with one key and
  at most one trailing newline. Claude uses the Anthropic route; OpenCode uses the Anthropic or
  OpenAI route. Logins and refresh flows are not used.

The [handoff](HANDOFF.md) records the exact executable/image/profile hashes and qualification
scope. Native binaries, Bubblewrap and the filesystem helper must already exist; this example
downloads or installs none of them. The helper build-context preparation API is described by
[`@agen-ai/sandbox-docker`](../../packages/sandbox-docker/README.md#live-workspace-files), and the
[owned-tool contract](../../packages/provider-tools/README.md) describes the workspace/lease.
A newly compiled executable must still match the provider's fixed byte pin. Missing or mismatched
prerequisites refuse before inference; do not replace checks with arbitrary user-supplied hashes.

## Commands

From the standalone SDK checkout:

```bash
pnpm test:examples:accept-edits
pnpm examples:accept-edits --help
pnpm examples:accept-edits check-config --config /absolute/run-config.json
pnpm examples:accept-edits prepare --config /absolute/run-config.json
pnpm examples:accept-edits run --config /absolute/run-config.json
```

The tests and `--help` need no credentials and execute no native provider. `check-config` reads
only the configuration. `prepare` creates the private state parent and prepares the workspace
store; put the files you want the agent to work on in the workspace directory it reports. `run`
reads the key, materializes the provider, discovers support, opens one session and runs the turn.
It exits `0` only when the report status is `completed`.

Build the matching source checkout with `pnpm build` first. Start from
[`run-config.example.json`](run-config.example.json). Every path must be absolute and
normalized, unknown fields are refused, and the key is never accepted inline. Set `approvals` to
`{ "kind": "exact", "commands": [...], "edits": [...], "reads": [...] }` to approve only
byte-identical commands and listed paths, or to `{ "kind": "interactive" }` to answer each request
at a terminal (only an explicit `y` approves). `restrictions` maps to the tool owner's `askEdit`,
`denyEdit`, `askRead` and `denyRead` selectors.

For the qualified Claude route set `provider: "claude"`, `route: "anthropic"` and
`model: "claude-sonnet-5-5"`. For OpenCode set `provider: "opencode"` and select either that
Anthropic model or `route: "openai"` with `model: "gpt-5.5-2026-04-23"`; use the matching native
executable and key file. OpenCode's native limit configuration is, for example:

```json
{ "provider": "opencode", "maxOutputTokensPerRequest": 4096, "maxModelStepsPerTurn": 12 }
```

These are the campaign's exact model identifiers, not aliases or a promise about later models.
The example's `prepare` output identifies the `work/` directory; only that subtree is the editing
scope. File tools do not create directories, delete, rename or alter permissions. Any such shell
operation still requires exact command approval. Multi-file patches publish sequentially and can
leave confirmed earlier changes if a later publication fails. Run a fresh session to change policy;
`provider_auto_review` and `provider_bypass` are refused by these constructors, not substituted.

## What the report means

- `support` is the instance's declared approval-policy support. An unsupported policy is reported
  as `refused` with `approval_policy_unsupported` before any session opens.
- `effectivePolicy` is the session's confirmed policy. A mismatch fails with
  `approval_policy_mismatch`; the example never switches policies.
- `requests` lists each approval with its exact action, the decision, whether a once-only exact
  option was selected, and the delivery receipt. A missing exact option or an undelivered answer
  stops the run.
- `output.fileChanges` lists completed edits reported by the provider. Read the workspace yourself
  to confirm effects.
- `output.refusals` lists each call the owned tools refused themselves, by tool and category
  (`invalid_input`, `outside_workspace`, `restricted` or `unavailable`), from the drivers'
  `owned_tool_refused` diagnostics. Host denials appear in `requests`, not here.
- A failed turn reports its error code as `failureCode`, for example `claude_max_budget_usd`.
- `limits` bounds wall time, output events and bytes, and distinct tool items. Reaching one stops
  the run, interrupts the turn and reports `stopCode`.
- `nativeLimits` passes the provider's own usage controls to its factory and must name the
  configured provider. Claude takes `maxBudgetUsdPerSession`, the SDK's estimated-cost stop for the
  session's query. OpenCode takes `maxOutputTokensPerRequest`, which bounds every model request, and
  `maxModelStepsPerTurn`. None of these is an invoice cap: costs are provider estimates checked
  after each response, so spending can pass a budget before the stop. OpenCode steps are logical
  steps rather than an absolute HTTP-request count; length continuations may occur within a step.

## Cleanup

The example closes the original session, disposes the registry and retries partial
materialization cleanup with the same owners. If cleanup cannot settle within `cleanupAttempts`,
the status is `cleanup_pending`: the process stays alive, prints its PID, and retries the original
owners on `SIGUSR2`, `SIGINT` or `SIGTERM`. The turn is never replayed. `SIGKILL` loses those owners.
