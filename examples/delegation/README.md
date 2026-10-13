# Managed delegation examples

These executable examples compose the public orchestration, runtime and ACP APIs. They use deterministic
providers and a local ACP peer, without credentials or paid inference. The same small host composition
serves the direct workflow, ACP integration and durable command-line walkthrough. Importing the SDK
starts none of these resources; each example explicitly constructs and closes its owners.

## Run the direct and ACP workflows

From the standalone SDK repository root, install dependencies and build the packages:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm examples:delegation
pnpm examples:delegation:acp
```

The direct workflow demonstrates the three independent choices: developer exclusions, end-user
selection and the main agent's choice of an effective target. Managed delegation starts disabled.
Enabling it selects certified standard execution by default; fast mode requires explicit selection.
Certified maximum reasoning remains available without a developer restriction. A restricted developer
variant demonstrates an explicit exclusion and its denial. A stale source revision cannot authorize
a new child.

The example provider exposes actual mutable session configuration. Its initial speed is fast, so
selecting and observing standard mode before the child prompt is a meaningful check. The deterministic
executor also demonstrates progress, supported steering, a queued next turn, cancellation and live
host approval. These are example model identities and certified mappings, not an inventory of real
vendors or a universal interpretation of native option labels.

The ACP walkthrough starts a credentialless native peer and a separate MCP endpoint for its parent
session. The peer discovers and invokes managed tools. Its parent turn ends while the child waits for
an approval; the host resolves the child's live request afterward and the child completes. Coordinator
ownership outlives the parent turn. MCP instructions and tool descriptions explain delegation to the
agent; policy and request authority stay in the host. Native subagents remain independent.

`pnpm test:examples` type-checks all public examples and runs the basic local-process, registry,
direct-delegation and ACP-delegation workflows. The installed-tarball consumer repeats these workflows
using only the seven packed public packages. Synthetic success proves these integration contracts;
it does not certify an arbitrary installed harness, account, model or vendor extension.

## Durable command-line walkthrough

The durable variant adds a local SQLite store and parent completion inbox. It demonstrates storage,
restart and host lifecycle responsibilities without production infrastructure.

The SDK packages continue to support Node 22 or newer. This **reference implementation** deliberately
qualifies only Linux, Node **24.18.0**, SQLite **3.53.1** from `node:sqlite`, and a local filesystem with
Linux type `0xEF53`. Opening fails on any other tuple. Network filesystems and multiple machines are
unsupported. An application can implement the public store/port interfaces for another environment
without depending on these example modules.

## Handle retries, classified failures and uncertainty

On that qualified tuple, run the connected failure-handling example:

```sh
pnpm examples:delegation:failures
```

[`failures.ts`](failures.ts) consumes a validated session's `runtime.retrying` observation followed
by exactly one successful `turn.completed`. The provider owns that retry; the host keeps the same
turn active and does not submit another prompt. For a production UI, show the retry status while
continuing to consume the original stream, and use its terminal event as the final result.

The example then delegates two children through the existing host and SQLite reference. One returns
a classified `quota_exhausted` failure with a `wait_for_quota` hint. The other starts execution and
loses its stream with a transport error carrying a `retry` hint. The coordinator records that second
outcome as `recovery_required`, because the stream cannot establish what effects already happened.
It closes every owner, reopens the actual database with a fresh registry and coordinator, and
collects the original run identities and outcomes. Recovery starts no provider turn, and attempts
to send a follow-up or queued turn to the uncertain child are rejected with `recovery_required`.

Production code should branch on the retained outcome before considering the failure's recovery
hint. Present classified failures using their neutral category and safe message; quota observations
and suggested next steps do not grant execution authority. Preserve uncertain results for explicit
host reconciliation. A fresh task after reconciliation still needs the application's normal
authorization and replay decision.

The example prints one JSON summary with the observed terminal count, collected failure, uncertain
outcome, invocation counts and successful cleanup. It creates a private directory beneath `.agent`
or the absolute `AGENT_SDK_DURABLE_TEST_ROOT` directory and removes that directory after success.
An unsuccessful run retains its directory and prints the path for inspection.

This is deterministic API integration evidence without credentials or network access. Its SQLite
reopen occurs in the same process. The existing `durableFailures.test.ts` qualification separately
covers classified outcomes across fresh processes for `collect`, `next_turn` and `automatic`, while
the `uncertain` crash walkthrough below covers loss after an observable child effect. These fixtures
do not establish a native provider's real quota exhaustion or account billing. The packed consumer
compiles this example and executes its assertions when `AGENT_SDK_DURABLE_TEST_ROOT` selects the
qualified volume; `pnpm test:examples:durable` also executes it after the existing durable tests.

## Set up and restart the durable walkthrough

Use the exact qualified environment above for these commands. `setup` allocates its own private
subdirectory under `.agent`; `--base /absolute/qualified/directory` selects a different parent. It
prints a JSON `ready` record containing the generated root. Use that printed root for subsequent
commands:

```sh
pnpm examples:delegation:durable setup --scenario normal
pnpm examples:delegation:durable inspect --root /absolute/generated/root
pnpm examples:delegation:durable restart --root /absolute/generated/root
pnpm examples:delegation:durable cleanup --root /absolute/generated/root
```

The commands emit bounded JSON Lines. `inspect` reports retained task, notification and inbox state
plus cumulative child/parent invocation counts and the completion input observed by the example
parent provider. That input contains the accepted envelope's task, run and outcome data, so a fresh
parent conversation can use the child result. Inspection acquires exclusive storage ownership without
constructing a provider or coordinator. Inbox inspection can mark a previously interrupted parent
dispatch as requiring recovery; it never dispatches that turn.

Run a separate setup for each deliberate crash scenario:

```sh
pnpm examples:delegation:durable setup --scenario lost-ack
pnpm examples:delegation:durable setup --scenario revoked
pnpm examples:delegation:durable setup --scenario uncertain
```

Each fault setup prints its root and a `fault` record, synchronizes its durable evidence, then kills
its own process with `SIGKILL`. That command's nonzero exit is expected. Run `restart`, `inspect` and
finally `cleanup` separately for each printed root. Do not combine the setup and restart with a shell
`&&`, which would stop at the intentional crash.

- `lost-ack` stops after inbox acceptance commits but before its acknowledgment returns. Restart
  retains the original inbox ID, one child invocation and at most one authorized parent dispatch.
- `revoked` also persists revocation of parent execution authority. Restart retains the child result
  and completion entry while parent dispatch remains blocked; the parent invocation count stays zero.
- `uncertain` stops after an observable child effect and before terminal evidence. Repeated restarts
  retain the uncertain outcome and a child invocation count of one. Recovery does not resubmit the
  saved prompt or create a replacement native conversation.

`cleanup` removes only a root created by this demo after validating its marker, current filesystem
identity, expected contents and exclusive database ownership. It does not construct an executor,
kill a process or infer ownership from age. Unknown contents, a live owner or failed cleanup preserve
the directory for inspection. Keep each generated root until its walkthrough is finished.

Every demo command also acquires process-lifetime admission for the exact root through a Linux
abstract Unix socket. Competing commands are rejected before opening SQLite, and cleanup holds
admission until directory removal finishes. The kernel releases this admission on process exit,
including the deliberate crashes; no stale lock file or elapsed-time takeover is involved. These
generated roots belong to the demo CLI. Programs that compose the reference store directly must
provide their own lifecycle admission before deleting their storage.

## Upgrade a retained durable store offline

The current reference uses task database **format 3** and store-port **contract 3**. The separate
`owner.sqlite` ownership database stays at format 1. Ordinary construction refuses older task formats;
it never upgrades records during coordinator startup.

Stop the application and quiesce every child and parent producer. The matched old owner must settle
or retire active runs and outstanding request-resolution intents, and resolve claimed notifications
and parent inbox rows in `dispatch_intended`. A settled `recovery_required` outcome remains uncertain.
Migration refuses a live exclusive owner, unknown SQL/versions, inconsistent task/inbox records and
old request authority that has not been retired.

Use the qualified Linux / Node 24.18.0 / SQLite 3.53.1 / local filesystem `0xEF53` tuple. Supply the
store directory containing `task.sqlite` and `owner.sqlite`, normally the walkthrough's `database`
subdirectory. For format 1, explicitly run the predecessor step first; then advance format 2:

```sh
# Only for retained format 1.
pnpm exec tsx examples/delegation/sqlite/migrate.ts --root /absolute/generated/root/database --inbox --target-version=2
# Format 2 to 3, or validation of already-current format 3.
pnpm exec tsx examples/delegation/sqlite/migrate.ts --root /absolute/generated/root/database --inbox
```

Omit `--inbox` only when the original database has no parent inbox tables. The optional inventory is
part of exact format validation. Programmatic callers use the same explicit boundary:

```ts
import { migrateSqliteDelegationStore } from "./sqlite/migrate.js";
import { sqliteParentInboxSchema } from "./inbox/index.js";

const result = await migrateSqliteDelegationStore({
  root: "/absolute/generated/root/database",
  inboxSchema: sqliteParentInboxSchema,
  // targetVersion: 2 selects the format-1 predecessor; the default target is 3.
});
```

Each step validates every source record with its frozen decoder and creates a private sibling bundle
`.database-format1-backup-<unique>` or `.database-format2-backup-<unique>`. Its `store/` directory
contains the restorable source databases, including committed WAL through SQLite's backup API.
Copying only `task.sqlite` would omit committed WAL data. The synchronized backup is independently
validated before publication; its `report.json` records content/file digests and the local tuple.

The 1-to-2 predecessor adds unknown category/recovery to historical failure code/message data in both
task and inbox envelopes. It retains exact text and refuses an expanded result that exceeds the
unchanged 2 KiB limit. The 2-to-3 step preserves every row value, completion envelope and receipt byte.
Old request operations with `completed` disposition retain their former continuation-boundary meaning;
they are never relabeled as a newly delivered answer. Only the database header advances after current
validation. No step restores a callback, replays an answer or dispatches a child or parent model.

Retain the JSON result and backup outside the live store. It names `sourceVersion`, `targetVersion`,
`backupRoot`, `storeId`, `sourceDigest` and `targetDigest`. Content digests cover sorted exact SQL and
typed row values, including padded blobs, and exclude page layout and the version header. Therefore
format-2-to-3 source and target content digests match. Backup file digests cover the actual snapshots.
Repeating a completed step returns `already_current` after validation and creates no new backup.

Crashing before a step's commit leaves its old format; crashing afterwards leaves the complete target
format. Retry the same step, then reopen format 3 with the current implementation in a fresh process.
The format-2 predecessor reader refuses format 3. Refusal leaves historical rows unchanged; resolve
the named old authority through its old owner rather than deleting journals or relaxing validation.

Rollback requires stopped producers and the complete backup `store/` copied to a different private
canonical directory on the qualified filesystem, with its private modes preserved. Use the exact
matched old implementation and inbox configuration. Never replace files beneath a running owner or
downgrade a new database in place. A backup omits changes committed after it was taken; preserve the
new root as evidence until the application explicitly accepts that rollback boundary.

## Run the durable qualification

From the public repository root, install its locked dependencies and build the packages:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck:examples
pnpm test:examples:durable
```

Tests create private temporary directories below `.agent` in the current repository and remove their
own fixtures afterward. To select another qualified local volume, set the absolute
`AGENT_SDK_DURABLE_TEST_ROOT` directory. The packed external-consumer check also runs these tests when
that variable is set, proving the same code against installed tarballs and public entrypoints.

The fixtures kill separate processes after admission, preparation/dispatch intent, an observable
provider effect, a waiting request, terminal output, settlement, and inbox acceptance before its
acknowledgement. Durable markers establish whether a provider was called. The fake provider makes
these failures reproducible without inference charges or network access.

## Compose ownership explicitly

`openSqliteDelegationStore({ root, inboxSchema: sqliteParentInboxSchema })` opens an exclusively owned
local store. Create the parent inbox with that handle's `database` and your `ParentInboxHost`, then
pass `store`, its exact `limits`, and `parentDelivery: inbox.port` to `createDelegationCoordinator`.
Inbox construction is inert until the coordinator has acquired its store owner.

If setup is abandoned before the first store-owner acquisition (for example, an incompatible inbox
port is rejected), call the reference handle's `closeUnused()`. It releases that unused opening and
can be retried if native close fails. It rejects an acquired owner; active coordinators must use their
normal quiescent shutdown path.

The host supplies current parent revision, result visibility, execution authority and lifecycle.
`acquireTurn` must share the exclusion used by every other parent-turn producer. Its lease checks
current authority at the actual provider boundary and retains ownership until the callback quiesces.
An acknowledged provider dispatch is still not evidence of model comprehension.

Call `inbox.dispatchPending({ parent, trigger: 'automatic' })` at an authorized idle boundary to process
a bounded page of automatic completions. At the next host-selected parent turn boundary, use
`trigger: 'next_turn'`; this can also consume pending automatic completions. Running, waiting, busy,
stopped and paused parents remain queued. Retired, revoked or expired destinations are dismissed
without deleting the child result. A restart turns unresolved parent dispatch intents into
`recovery_required`; it never automatically repeats the provider call.

Dispose the inbox **before** disposing the coordinator, and close the coordinator before the runtime
registry. A callback or lease release that has not quiesced retains a database producer reference.
The database refuses owner release while that reference remains. A `recovery_required` shutdown is
not permission to transfer the live resources to a second coordinator.

## Storage guarantees and limits

The store uses `BEGIN IMMEDIATE` transactions, WAL, `synchronous=FULL`, foreign keys and exact schema
validation. A separate SQLite connection holds a process-lifetime exclusive ownership transaction;
committed task-store owner epochs and random tokens fence writes. The owner connection is private
to the adapter. OS process exit releases its lock; elapsed time alone grants no new owner authority.

The root must be a canonical, owned `0700` directory. Database and auxiliary files must be private
regular `0600` files with one link. Every existing file is checked before either SQLite connection
opens, and first initialization requires an empty directory. Retained directory/file identities
are checked before operations. Unknown files, schema changes,
triggers, views, or indexes fail closed. The reference assumes a trusted local account and a stable
owned ancestor directory; it does not defend against an administrator or a hostile process sharing
that account and replacing its filesystem underneath SQLite.

Admission materializes a fixed 32 KiB final/notification slot and four 2 KiB critical control slots
per run. Immutable input occupies a separate row, so finalization does not rewrite the original
24 KiB input. Ordinary operation receipts use fixed 2 KiB slots. Logical SDK limits are enforced
alongside a 512 MiB database ceiling, bounded WAL checkpointing, reserved page growth and 64 MiB
filesystem headroom. Ordinary writes cannot consume reservations for pending finalization. Actual
volume loss or externally exhausted storage still fails explicitly and cannot be described as a
successful commit. Capacity reservations are not a substitute for volume provisioning and monitoring.

The inbox is in the same database but is a separate host responsibility. `(storeId, notificationId)`
deduplicates accepted envelopes; inspection returns the original stable inbox ID after a lost
acknowledgement. Child settlement and notification creation share one store transaction. Parent inbox
acceptance and parent-provider dispatch have separate transactions and receipts.

No automatic pruning or lifetime deduplication reset occurs. The reference does not expose general SQL
through the SDK. Its small synchronous database callbacks are internal example composition between
the store and inbox, reject asynchronous work, and preserve the single owned transaction boundary.
Secrets, bearer credentials, raw provider context and live permission handles do not belong in these
records. Persisted request descriptions cannot revive an approval after the original executor is lost.
