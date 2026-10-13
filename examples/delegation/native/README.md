# Explicit native Grok qualification

The `../native.ts` command qualifies one pinned Linux x86-64 Grok Build binary with
the public SDK. It is an opt-in diagnostic example, with a host-owned target and
explicit API-key bootstrap. It does not install or enable a production provider.
The SDK's managed delegation remains disabled unless the application and user
enable it; native harness subagents remain independent.

`discover` opens one disposable session and verifies the actual model and reasoning
configuration without prompting. `execute` requires that discovery, a separately
reviewed selection, and the explicit inference switch. `check` validates saved
evidence offline without launching a process or reading credentials.

The historical 2026-10-11 repository qualification, recorded as execution report
version 1, completed both direct launch and a verified
retained-binary launch using Grok `1.0.50` (`c58f321264ba`), `grok-4.3`, Low reasoning
and the observed default service-tier request mapping through an explicit API key.
Each mode completed six SDK turns, four actual once approvals and managed callbacks,
delivery of a real child's result to the same parent, cancellation after provider
start, and closed cleanup. The retained installer exited before a fresh process
reopened its verified installation. The exact native executable SHA-256 is
`c80de0155706ff2d995623887b102f2d0abd2c62b2643dea3a0cebaf7dd724d5`.
This evidence is specific to those inputs; it establishes neither browser login nor
other native versions, platforms or pairings. The host's completion inbox is volatile.

From the standalone public repository:

```sh
pnpm exec tsx examples/delegation/native.ts discover \
  --manifest /absolute/candidate.json --manifest-sha256 sha256:EXPECTED_BYTES \
  --launch direct --output /absolute/new-discovery-directory

pnpm exec tsx examples/delegation/native.ts execute \
  --manifest /absolute/candidate.json --manifest-sha256 sha256:EXPECTED_BYTES \
  --discovery /absolute/new-discovery-directory/discovery.json --discovery-sha256 sha256:EXPECTED_BYTES \
  --selection /absolute/selection.json --selection-sha256 sha256:EXPECTED_BYTES \
  --launch direct --output /absolute/new-evidence-directory --allow-live-inference

pnpm exec tsx examples/delegation/native.ts check \
  --manifest /absolute/candidate.json --manifest-sha256 sha256:EXPECTED_BYTES \
  --discovery /absolute/new-discovery-directory/discovery.json --discovery-sha256 sha256:EXPECTED_BYTES \
  --selection /absolute/selection.json --selection-sha256 sha256:EXPECTED_BYTES \
  --evidence /absolute/new-evidence-directory --expect qualified
```

Replace each `EXPECTED_BYTES` with the independently calculated 64-character
lowercase SHA-256 of that complete file. Semantic digests inside documents are
additional checks. Unknown fields, duplicate JSON keys, excessive nesting, symbolic
input paths, existing output directories, and overlapping input/output paths are
rejected. Evidence files are atomically published with mode `0600` inside a new
mode `0700` directory.

The closed [candidate and selection types](contracts.ts) bind the inspected native
binary, upstream compressed artifact, bounded decoder recipe, all seven built SDK
packages, Node/pnpm provenance, MCP dependency graph, and runner source files. The
credential facility names one host-owned dotenv source and reads only `XAI_API_KEY`.
Keep that input local. Credential values and raw native output are never evidence.
Prepare the candidate from an inspected checkout and independently verified bytes;
the example does not choose or approve a candidate on the user's behalf.

Preflight verifies the SDK and MCP runtime inventories and the installed MCP
dependency closure, including resolved versions, dependency edges and peer bindings.
The graph's archive integrity strings retain the inspected lockfile provenance;
they are not hashes of the installed transitive files. The fake-key mapping probe
also retains an explicit `NativeCleanupError.retryCleanup()` capability when native
shutdown fails. Keep its allocation and executable leases until that retry succeeds.

The selection binds the exact discovery catalog and both acknowledged configuration
changes. A fake-key loopback probe of the pinned native request builder supplies
the separately reviewed mapping proof. Its recorded requests must select
`grok-4.3`, explicit `low` reasoning and omitted or `default` service tier. This
establishes request behavior under the explicit API route; it does not certify
production backend billing. Native updates or changed package/runner bytes require
a new candidate and affected qualification evidence.

The optional `parentPermissionProof` binds a separate fake-key native observation
to the executable and SDK identities. It enables the runner's exact Grok 1.0.50
permission profile for its two owned MCP tools. During each admission turn, the
host may select the uniquely offered `allow once` choice once for
`agenai_delegation__delegation_targets` and once for
`agenai_delegation__delegate_task`. It correlates the live public tool item and
request to the original parent turn and retains the execution returned by
`startTurn`. One reader consumes its continuous `outputs` stream. The host selects
the answer through that execution’s `resolveRequest`, records its independent
delivery receipt, and continues reading the original stream. The target callback must
succeed before a delegation approval is considered. Exact task, target and prompt
checks still apply at the managed-tool callback. The child dispatch gate remains
held until the original admission execution reaches its actual terminal event
and its reader settles.

This is a pinned diagnostic policy, not generic authorization from a display
title. Omitted proof, unrelated tools, repeated or ambiguous requests, and requests
during ordinary inference, completion or child execution remain blocked. It never
selects a persistent grant or changes global permissions. Evidence records only
actual requests and offered once choices, delivery receipts, subsequent output
boundaries and matching callbacks; an approval alone cannot establish successful delegation.

Current executions emit `NativeModeReport.version: 2`. Approval observations record
`requestObservedAt`, `deliveryStartedAt`, `deliverySettledAt`, `deliveryStatus`,
and, for a rejected delivery, `requestState`. `runningAt` and the matching callback
remain observations from the same execution. `nextBoundaryAt` and `nextBoundary`
identify the next actual `request.opened` or terminal event; they do not describe
iterator exhaustion or imply completion when an answer is delivered. A qualified
report requires delivered answers, exact callback correlation, settled delivery
before the next handled boundary, and one terminal settlement per original turn.

The offline checker preserves the version 1 approval decoder and its historical
`pendingSettledAt`, `resolutionStartedAt`, `continuationSettledAt` and
`continuationBoundary` meaning. It rejects those fields in version 2 and rejects
version 2 fields in version 1. The enclosing evidence format, discovery report,
manifest, installation records and independently retained permission-proof profile
keep their existing identities because their meanings are unchanged. Historical
version 1 qualification does not qualify the current version 2 execution behavior;
that qualification remains pending MS009. Deterministic fixtures exercise the
current behavior without paid inference.

Admission observations record bounded assistant-text and request counts, closed
native tool-item categories, and whether the streamed response exactly claimed
`{"admitted":true}`. They retain no arbitrary response text or content hash.
These diagnostics can distinguish a text-only claim from observed tool activity;
they do not establish MCP readiness or substitute for actual managed callbacks.
Native MCP discovery and invocation helpers are permitted by the qualification
prompt, while the owned managed-tool and once-permission checks remain exact.

`--launch registry` uses the same host composition. An owned installer downloads
the exact approved gzip, checks its bytes, decodes one bounded gzip member with the
inspected Python/zlib toolchain and installs the verified raw binary offline through
a local catalog. The installer must actually exit before a fresh Node worker reopens
the committed installation. The original transformed artifact is removed before
that reopen. This does not claim support for the official script-dependent npm
distribution. Registry byte verification is separate from publisher authentication.

Each native process receives a distinct fresh HOME, GROK_HOME, XDG and temporary
allocation with a replacement environment. Updater and compatibility scanners are
disabled for this qualification. This isolates ambient configuration; it is not a
filesystem or network sandbox. The explicitly selected API key and shared network
allow native inference and the scoped loopback MCP bridge. Global login and account
settings are not modified.

Execution permits at most six SDK turns: ordinary parent inference, actual managed
tool admission, child result, later completion consumed by the same parent,
cancellation admission, and a second child canceled after its observed provider
start. A host gate delays child dispatch until the admission turn has settled. The
child chooses a harmless token; the parent sees it only through the actual completion
envelope. Configuration is verified before every provider turn, and parent and
comparison defaults must remain unchanged. At most two native sessions are open
together. Native internal requests are opaque; SDK turn limits do not promise a
dollar cap.

The execution budget is five minutes from invocation preflight, shared by artifact
preparation, installation, worker startup and host execution. It includes a
three-minute delegation phase and a separate 30-second cleanup budget. An
unsuccessful or unproven gate cannot qualify.
A deadline does not establish process closure: pending cleanup retains its actual
in-memory lease and owned directories, writes no successful evidence, and retries
cleanup without further inference. Serialized process IDs are historical evidence,
never cleanup authority. The example's parent completion inbox is volatile; process
restart does not provide durable delivery.

The deterministic tests use synthetic processes and local fixtures, never an account
or paid native inference. Run `pnpm test:examples:native` in the public checkout, or
`pnpm test:agent-sdk-native-examples` in the private source repository. The native
runner compiles with all public examples, but no default test command invokes its
`discover` or `execute` operations.
