# @agen-ai/provider-tools

Owned file, search and command tools for AgenAI native provider drivers on Linux. A driver such as
[`@agen-ai/provider-claude`](../provider-claude/README.md) or
[`@agen-ai/provider-opencode`](../provider-opencode/README.md) replaces its vendor's built-in tools with
these seven fixed tools, so every model effect passes through one serial broker that this package
owns. This optional package is introduced in coordinated `0.4.14` with Agent Protocol V14.

The package root is inert: it exports the tool names, plain option types and error classes, and
reads, spawns and resolves nothing. Workspace preparation and the tool owner require the explicit
`@agen-ai/provider-tools/node` entrypoint. Application code normally reaches this package only
through a driver's options; the `/node` owner is for driver implementations.

## Workspace preparation

```ts
import { prepareNodeProviderWorkspace } from '@agen-ai/provider-tools/node';

const workspace = await prepareNodeProviderWorkspace({ directory: '/absolute/owned-store' });
// workspace.workspaceDirectory is <store>/work, the root for the owned file and search tools.
```

Preparation creates a private store (mode `0700`) with `work/`, an empty `stage/` and an exact
`.agenai-layout` marker, or reuses a store that is already valid and idle. It refuses a nonempty
unrelated directory, aliases, foreign ownership, a widened mode, unsettled staging and a stage on a
different filesystem from `work/`. It never moves, imports or repairs existing data; copy a
repository into `work/` yourself. The durable contents of `work/` belong to the caller.

A materialized driver holds an exclusive `.agenai-lease` on the store until it is disposed. A second
owner is refused with `workspace_leased`. A lease left by a crashed process is never taken over
automatically: confirm that no owner is alive, then remove the lease file deliberately.

## Platforms

Only Linux x64 and the Linux arm64 Docker Desktop workload are admitted, with Node `v24.18.0`
and an effective UID and GID from 1 through 262143, matching the filesystem helper client.
Unsupported identities fail before any process or workspace lease is acquired.
On Desktop the entire SDK caller, broker and provider run inside the Linux
guest; native Darwin is unsupported. The Bubblewrap and filesystem-helper executables are verified
against exact per-platform SHA-256 pins, must be physical files that other users cannot write, and
are re-observed before each launch. A namespace preflight must pass before anything reaches a
model. Unsupported platforms and missing prerequisites refuse before inference. The Linux arm64
admission check is not a claim that arbitrary arm64 hosts are qualified; the recorded arm64
composition is Docker Desktop. Exact hashes and container requirements are in the
[accept-edits handoff](../../examples/accept-edits/HANDOFF.md#qualified-runtime-tuples).

No constructor installs prerequisites. The filesystem helper comes from the shipped
`prepareDockerSandboxFilesystemHelper` build context in `@agen-ai/sandbox-docker/node`; explicit
building and selection remain caller-owned. A successful helper build alone does not establish the
provider pin: compare the resulting executable with the handoff before use. Keep native paths
physical, executable and writable only by root or the caller. Prepare the state parent as a private
caller-owned directory. See the [installed example](../../examples/accept-edits/README.md) for setup.

The store and state parent must be outside `/usr`, `/bin`, `/lib`, `/lib64` and `/sbin`, including
their descendants. Admission requires a physical `/usr` mount source and physical private paths;
executable paths may still reside in these system directories. The caller must not expose private
directories through additional host bind-mount aliases in `/usr`.

## The seven tools

| Tool | Effect |
| --- | --- |
| `read` | Read one UTF-8 workspace file. Links and special files are never followed. |
| `glob` | List matching workspace files, withholding restricted entries. |
| `grep` | Fixed-string search of workspace files, checking restrictions per entry. |
| `write` | Create or replace one ordinary file whose parent directory exists. |
| `edit` | Replace exact text in one ordinary file. |
| `patch` | Create or update up to sixteen files, checked together and published in order. |
| `bash` | Run one approved command in a networkless namespace. |

Input field names follow the vendor built-ins they replace, so aliased native calls validate
unchanged. Each input is a strict object: an unknown tool, an unknown field or an invalid value
refuses the whole call before any effect. `nodeProviderToolDefinitions()` returns plain
descriptors with JSON Schema inputs for a driver to register.

Structured edits require a normalized workspace-relative path that fits Agent Protocol file-change
observations: at most 500 characters, with no surrounding whitespace or control characters. Every
member of a patch is checked before reads, approval or publication; an unreportable path refuses the
whole call as `invalid_input`. Read and search tools retain the broader sandbox path limits.
Replacement edits check the complete resulting UTF-8 size before constructing expanded content.
An oversized edit leaves every file unchanged and the session usable.

A result the tools refuse themselves carries `refusal`: `invalid_input`, `outside_workspace`,
`restricted` (a session file restriction) or `unavailable` (the session no longer admits calls). A
host denial, expiry or cancellation carries none.

## One serial broker

Each session has one broker. It validates a complete request, applies file restrictions, waits for
any host decision, performs the effect and settles it before the next call enters. The queue is
bounded; there is no replay.

- Every command asks the host for the exact, complete command text, including read-only commands.
  There is no remembered grant and no prefix or pattern rule.
- Edits ask the host under the `host` policy. Under automatic edit approval, eligible edits apply
  without a host response; restricted paths still follow their restriction, and repository
  metadata and agent configuration (`.git`, `.env`, `.env.*`, `.claude/`, `.opencode/`,
  `opencode.json(c)`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`) always ask.
  Required approval settles before reading current contents and preparing the entire batch.
  Text replacements use those latest contents; a missing or ambiguous replacement target rejects
  the batch before any file is published.
- Restrictions use workspace-relative selectors. Deny wins over ask, read restrictions also
  restrict edits, and edit-only restrictions never hide readable content. Searches check every
  entry they return. An edit of a path whose reads ask is approved before its current contents
  are read, so a denied edit reveals nothing about them.
- Selectors and model globs share one grammar: `**` spans directories, `**/` may also match no
  directory, `*` and `?` stay within one name, and every other character is literal. Matching
  has a fixed work budget. A restriction decision that cannot finish within it is a denial; a
  search that exhausts it stops and reports `[pattern matching stopped at its work bound]`.
- Grep scans at most 4 MiB of file content per call. Results disclose files omitted by that
  budget, the per-file byte limit, or an unsuccessful UTF-8 read; `No matches.` accompanied by
  such a notice is an incomplete scan. Narrow the path or glob to search the remaining files.
- File publication goes through the descriptor-safe helper and reports its exact receipt. A
  publication reported as changed or uncertain preserves the known effect, stops the rest of the
  batch and fences every later effect in the session.
- Multi-file `patch` publication is sequential, not atomic. A later failure reports which files
  were published. Nothing is rolled back.
- Cancellation withdraws a pending approval without an effect, stops an entered command and joins
  its namespace descendants before the serial slot is released.

## Command containment

Each approved command runs in its own Bubblewrap user, PID, mount, IPC, UTS and network namespaces
with a cleared environment. `/usr` is read-only, `/proc`, `/dev` and `/tmp` are private, and the
workspace is the only writable host path. The controller's home, the driver's state, the store's
staging area and any credentials are not mounted. Commands have no network. Output is bounded
and truncation is reported.

## Limits

`limits` may only lower the package maxima.

| Limit | Default | Maximum |
| --- | --- | --- |
| `commandTimeoutMs` | 60,000 | 600,000 |
| `outputBytes` | 65,536 | 1,048,576 |
| `fileBytes` | 1,048,576 | 8,388,608 |
| `searchEntries` | 2,000 | 20,000 |
| `pendingCalls` | 8 | 64 |

`restrictions` accepts at most 64 selectors per field and 512 UTF-8 bytes per selector.

## Errors and cleanup

`NodeProviderToolsError.code` is one of `invalid_options`, `platform_unsupported`,
`identity_mismatch`, `workspace_invalid`, `workspace_leased`, `namespace_unavailable`,
`helper_unavailable`, `session_active` or `closed`. When cleanup cannot settle,
`NodeProviderCleanupError` keeps the original owner, lease and state, and only its `retryCleanup()`
releases them. Disposal is idempotent after success.

A namespace is joined only when its init process is confirmed gone. An unreadable or malformed
process record, an invalid or failed Bubblewrap report, or an init that cannot be identified is
unknown, never gone. A command whose namespace is not proven gone fails and fences the session,
and closing keeps rejecting with `namespace_unavailable` while it remains. A preflight, probe or
session helper that cannot be joined keeps the lease and state: the materialization, `openSession`
or `dispose` error carries the retry, the owner refuses another session until it settles, and
disposal retries it before releasing anything.

## Not provided

Application MCP servers or other integration authority, command networking, rollback, automatic
lease takeover, repository import, dependency installation and native Darwin execution. There is no
file-tool operation for mkdir, delete, rename, notebook structure, link creation or permission changes;
these do not acquire automatic permission. An approved command can perform operations within its
contained workspace authority. File tools continue to refuse symlinks, hardlinks, special files and
cross-device targets even when the host approves a request.

## Checks

```sh
pnpm --filter @agen-ai/provider-tools build
pnpm --filter @agen-ai/provider-tools test
pnpm --filter @agen-ai/provider-tools typecheck
```
