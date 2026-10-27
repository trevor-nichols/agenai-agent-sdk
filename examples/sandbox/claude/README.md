# Exact Claude SDK sandbox consumer example

This private example workspace composes an explicitly supplied Claude Agent SDK **0.3.273** with a borrowed public `@agen-ai/sandbox` owner. Its selected native tuple is Claude Code **2.1.273** on Linux x64, with image identity supplied by the qualification campaign. It adds no public SDK export or vendor peer to the sandbox packages. The supplied SDK module remains trusted controller code; the facade relocates the selected native process and its descendants into the guest.

```ts
import * as claude from '@anthropic-ai/claude-agent-sdk';
import { createSandboxClaudeRun } from './index.js';

const run = createSandboxClaudeRun(claude, sandbox, {
  guestExecutable: '/opt/agenai/native-harness/claude-tools',
  model: 'claude-sonnet-4-6',
  tools: ['Read', 'Write', 'Bash'],
  maxTurns: 8,
  prompt: 'Perform the admitted local scripted tool sequence.',
  signal: controller.signal,
});
try {
  for await (const message of run.messages) {
    // The caller owns consumption and any further controller effects.
    observe(message);
  }
  const nativeObservation = await run.settled;
  observe(nativeObservation);
} finally {
  await run.cleanup();
  // The original caller still owns final export and sandbox-owner destruction.
}
```

The executable must already exist at the selected canonical absolute guest path in the caller's verified image. Paths ending in JavaScript/TypeScript extensions reject because this exact SDK interprets them as controller runtime launch configuration. There is no controller PATH/executable lookup or launch transformation callback. The MS005 fixture supplies immutable executable shims which start a guest-local scripted endpoint and the exact native binary within the single primary workload. The tools and cancellation shims are `/opt/agenai/native-harness/claude-tools` and `/opt/agenai/native-harness/claude-cancel`; their preparation and identity belong to the qualification campaign.

| Facility | Selected example behavior |
| --- | --- |
| Native built-ins | Only the caller's duplicate-free subset of `Read`, `Write`, `Edit`, `Bash`; the same set is auto-allowed by the native permission layer |
| Native permission prompts | `dontAsk` and `permissionPrompts: 'none'`; no bypass-permissions mode or controller permission handler |
| File and shell effects | Guest paths and guest children, with whole-workload stop ownership; no independent terminal process facility |
| Environment and working directory | Fresh fixed guest environment, guest-private home/config/tmp, and exactly `sandbox.workspace`; no caller environment map or ambient merge |
| Hooks, custom tools, in-process MCP | Rejected configuration; their JavaScript handlers would execute on the controller |
| Guest MCP commands, remote MCP, plugins | Disabled in this selected composition; adding them requires explicit guest materialization, endpoint admission and new native qualification |
| Skills and instructions | Empty explicit skills/plugins/settings sources reduce discovery. Native files in the guest can still provide instructions or skills; their authority is caller-selected guest input, and the scripted fixture imports only its inventoried files |
| Settings and persistence | Empty settings sources, strict empty MCP config and session persistence disabled; no settings path/object, resume, session store or controller transcript mirror |
| Authentication | This example exposes no credential input, refresh callback or route fallback. MS005 used a non-secret scripted fixture; MS006 separately supplied the selected API key at the final sandbox process boundary through private qualification tooling. Reusable application credential ownership remains caller-owned |
| Diagnostics | Bounded raw stderr snapshot, copied on access; no diagnostic controller callback |

Configuration is copied synchronously from plain enumerable data properties. Unknown fields, accessors, symbols and hidden fields reject before the supplied SDK or a process reservation is entered. The prompt's JSON string is limited to 32 KiB, the model to 128 ASCII identity characters, tools to the four declared names and turns to 1–32. The spawn callback independently checks exact command, working directory, argument order and environment. Only the exact `.273` SDK-added entrypoint/version fields are admitted; new tracing/environment additions reject without disclosing values.

The facade returns synchronous Node streams while sandbox startup is asynchronous. Both `write` and `end(payload)` enforce a shared 64-KiB buffered-input limit, including callers that ignore backpressure; input high water mark is 8 KiB. Stdout high water mark is 16 KiB, with at most one 64-KiB working source chunk. The bridge also caps stdout at 8 MiB/4,096 newline frames and stderr at 1 MiB; the sandbox policy retains its independent stream limits. Diagnostic and message consumers must respect the declared scope and continue the sole message reader through cancellation. A second reader or concurrent pull rejects.

Actual numeric exits and the selected supported signal receipts are preserved. There is no PID field, inferred signal or invented exit code. A successful `kill('SIGTERM'|'SIGKILL')` return acknowledges one entered whole-sandbox teardown dispatch. It does not promise independent signal delivery or physical death. An unavailable native exit produces an error and retains the actual unavailable receipt in `settled`. Caller cancellation initiates whole-run cleanup immediately; the SDK's forwarded spawn signal keeps its separate graceful-EOF meaning.

Query iteration ending and native process observation are separate from physical cleanup. Ordinary message exhaustion leaves the owner available for admitted live artifact inspection until explicit cleanup. Premature or failed reader retirement initiates cleanup. `cleanup()` closes the SDK query, stops the borrowed workload, joins its process pumps and entered reader, and keeps the same run available for explicit retry if cleanup fails. It preserves guest storage for the original caller's final export/destruction. Retain the run and original sandbox owner until both settle.

The dedicated memory-only tests use public backend ports and run with filesystem reads restricted to the installed consumer, filesystem writes absent, and process/network/worker facilities prohibited. They establish configuration, stream and lifecycle behavior. Installed scripted native tools and descendant cancellation require the separate MS005 campaign; these tests make no real authentication or billing claim.
