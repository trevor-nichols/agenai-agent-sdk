# Migrating to 0.2.4

Version `0.2.4` keeps Agent Protocol V8 and makes operation observations exactly correlated and
backpressured. Upgrade `@agen-ai/validation`, `@agen-ai/agent-protocol`, and
`@agen-ai/agent-runtime` together; mixed package versions are not supported.

## Caller changes

Every `invokeOperation` call now requires an `observationTurnId`. The caller owns this identifier
and must keep it stable for the invocation. Supply `onOutput` when the host admits live operation
observations:

```ts
const result = await session.operations.invokeOperation({
  invocation,
  observationTurnId: parseAgentTurnId(`operation:${invocation.invocationId}`),
  onProviderExecutionStarted: recordProviderStart,
  onOutput: async (output) => {
    await admitProviderOutput(output);
  },
});
```

The observer is optional, but the runtime and provider await it whenever supplied. Do not launch
background admission work from the observer: its resolved promise is the operation's per-output
backpressure boundary.

## Adapter changes

An adapter emitting live operation output must use the supplied `observationTurnId` and session
identity, and must await `onOutput` before emitting the next observation or settling the result:

```ts
invokeOperation: async (input) => {
  await input.onProviderExecutionStarted?.();
  await input.onOutput?.(createAgentEventOutput({
    protocolVersion: 8,
    type: "progress.updated",
    sessionId,
    turnId: input.observationTurnId,
    occurredAt: new Date().toISOString(),
    payload: {
      progressId: "operation:progress",
      kind: "task",
      phase: "updated",
      message: "Applying provider operation",
    },
  }));
  return completedResult;
},
```

Only operation-scoped progress, context, compaction, operation, resource, warning, error, and
diagnostic events are admitted. Turn lifecycle events, requests, plans, diffs, messages, and
provider-native payloads are rejected. The validated session also rejects identity changes,
capability violations, lifecycle regressions, and output after settlement.

## Verification

Run the reusable conformance suite against every adapter and exercise at least one observed
operation. From this repository, run `pnpm check` to build, test, pack, install, compile, and execute
the complete coordinated package set from clean tarballs.
