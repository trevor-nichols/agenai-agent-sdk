# Upgrade to SDK 0.4.3

Upgrade the installed AgenAI Agent SDK packages together to `0.4.3`. This patch
retains Agent Protocol V12, managed store contract 4 and SQLite physical format 3.
There is no new request envelope, public method or storage migration. For an older
protocol generation, first review [the 0.4.2 migration guide](MIGRATING-TO-0.4.2.md).

## Operation ownership and cleanup

An offered `idle_session` / `immediate` operation reserves the same execution slot
as a caller turn or native continuation. A concurrent start fails rather than
running over the operation. Keep consuming and awaiting the operation's `onOutput`
callback until it settles. Exact cached idempotent results do not start new work.

Close stops admission and begins native quiescence before joining entered controls
and output callbacks. Use fresh cleanup authority. If close fails, retain the
stopped owner for retry and do not dispose its dependencies. An
`AgentProviderDelegatedOperationError` carries started-execution evidence; handle
it before classifying an abort as pre-execution cancellation. Never replay an
uncertain operation automatically.

Provider-owned `runtime.retrying` may arrive through an operation's awaited output
callback with its exact `observationTurnId`. That correlation does not create a
prompt turn, and the observation does not authorize another invocation.

## Discover support and report effects

Use the selected session's operation port and exact offered descriptor. Operation
IDs are configured for the selected provider, and descriptor revision differs
from catalog revision. Obtain the host-owned confirmation and supply the offered
fields. The [operation example](examples/operations.ts) demonstrates this flow
with a synthetic fixture and no native agent or account.

A completed command does not guarantee a compaction effect. Only an accepted
completed `context_compaction` observation establishes that effect. Compaction
can lose detail or grow context; the SDK provides no undo or guaranteed reduction.
The public SDK does not bundle the private Claude adapter.

## Managed request retirement

The orchestration package retains an explicitly aborted presentation signal after
request retirement, including across Node 24 garbage collection. Hosts continue
to honor the signal and exact request terminal; retirement does not change an
independently entered response receipt or allow an answer to be replayed.

## Qualification

Current-source tests and installed packed consumers qualify the patch's public
behavior. Prior native proofs keep their recorded versions, dependencies and
resource limits. This upgrade does not expand their scope or establish real
backend authentication, billing, native summary quality or private deployment.
