# @agen-ai/agent-history

Portable native conversation discovery, transcript reading, search and explicitly enabled saved-session management. History is separate from agent execution: browsing does not create a session, generate a prompt, resume a turn or answer a pending request.

This package is the eighth package in the coordinated **0.4.4 source candidate**, with Agent Protocol V12 unchanged. The candidate is unpublished. The recorded npm `latest` and `beta` release remains the seven-package **0.4.3** set, which did not include agent-history. Use a built candidate checkout or its complete matching packed artifacts; agent-history 0.4.4 is not a published installation target in this source-readiness record.

The root exports plain contracts, bounded parsers and `createAgentHistory` for custom adapter composition. The explicit `/zod` entrypoint exposes schemas. Root imports do not open a store, inspect a home, start a process, authenticate or access the network. No native vendor SDK is required to install or import this root.

## Explicit sources and qualification

Choose a provider entrypoint and construct a source with explicit native roots or a caller-owned connection. Imports remain inert, including when optional peers are absent. Native setup, identity checks and resource acquisition occur only at construction or operation boundaries.

| Entrypoint and constructor | Qualified native version | Source and main coverage |
| --- | --- | --- |
| `/claude`: `createClaudeHistory` | Claude Agent SDK 0.3.306; Code 2.1.306 baseline | Explicit configuration home; project/worktree policy or all projects; `retained_chain`. |
| `/codex`: `createCodexHistoryProcess` or borrowed `createCodexHistory` | Codex app-server 0.163.0 | Explicit home/initialized connection, project or all projects, selected catalog policy/source kinds; `retained_chain`. |
| `/opencode`: `createOpenCodeHistory` | OpenCode runtime and client 2.1.2 | Supplied server and exact project directory in its namespace; `retained_chain`. |
| `/cursor`: `createCursorHistory` | Cursor SDK 1.0.40 | Existing SDK JSONL/SQLite store and exact project; main `current_checkpoint`, terminal run views `stored_updates`. |
| `/grok`: `createGrokHistoryProcess` or borrowed `createGrokHistory` | Grok Build 1.0.62 | Exact selected native project; surviving-branch `stored_updates`. |
| `/acp`: `createAcpHistory` | ACP `schema-v1.23.0` | Already initialized caller-owned transport, project or all projects; negotiated catalog only. |

Exact-native qualification used Linux x86_64 and Node 24.18.0. The portable root requires Node >=22; Cursor construction requires Node >=22.13. Version checks and retained executable/module digests identify the qualified inputs rather than authenticating a publisher. These source kinds do not establish general platform, account or store compatibility. Cursor IDE and legacy CLI stores are unqualified; Cursor cloud transcript replay is also unqualified and has no shipped constructor. The cloud observation reached metadata but the sampled retained run stream returned HTTP 410.

## Reading history

Operations have independent supported/unsupported discriminants. Unsupported operations have a reason and no callable method. Catalog discovery and metadata lookup are separate because some native protocols provide only listing. A consumer can browse any constructed source through the same interface:

```ts
import type { AgentHistory } from '@agen-ai/agent-history';

export async function browse(history: AgentHistory) {
  try {
    if (history.catalog.status === 'unsupported') return history.catalog.reason;
    const catalog = await history.catalog.list({ limit: 20 });
    const conversation = catalog.items[0];
    if (!conversation || history.transcript.status === 'unsupported') return catalog;
    const transcript = await history.transcript.read({ conversation: conversation.ref, limit: 20 });
    return { conversation, transcript };
  } finally {
    await history.close();
  }
}
```

Pages include observation time, live/snapshot consistency and coverage. End of pagination means the selected native view has ended. It does not mean deleted or compacted history was recovered. Records preserve native turn/item references when available; they never invent live SDK turn IDs or stable message IDs from mutable offsets. Tool calls, tool results and attachment references are inert data. Reading does not execute tools or fetch attachment URIs.

Pass `nextCursor` back to the same history instance with the same operation, source generation, conversation, view and query. Changing filters or order starts a new traversal. Cursors are bounded opaque continuations sealed by a key held only by that history instance. Reopening a source starts a new traversal even when references retain the same source generation. The seal protects continuation integrity; it grants no account authorization or execution authority. They can contain native continuation data and should be handled like other history metadata.

A source has a stable caller-assigned `sourceId` and a configuration `generation`. Change the generation when its account, native root, server identity or effective scope changes. References from a different source/generation fail before delegation. Do not put credentials in either identifier. Supplying a history reference to an execution API still requires that API's explicit binding and authority.

## Limits and lifecycle

Default limits are 100 records and 1 MiB normalized output per page, four concurrent reads, a 30-second operation deadline and a 10-second cleanup deadline. Configuration may lower page/concurrency limits; operation deadlines cannot exceed the configured maximum or the absolute 120-second ceiling. Cursor envelopes are limited to 64 KiB. An indivisible oversized record fails instead of being truncated and skipped. Provider limits may be lower.

These limits apply to SDK-owned operations and output. Native helper input work, worker address space and caller-owned remote server memory are separate concerns. A small returned page does not prove a small native read. Native provider construction must disclose its resource policy and storage effects; a package must not infer aggregate process-tree memory limits from a per-process limit.

Admission is immediate: occupied capacity returns `busy` rather than queuing indefinitely. A timeout or caller cancellation releases the caller's wait while retaining operation capacity until the driver actually settles. Cancellation is passed through an `AbortSignal`. A driver must stop owned work on cancellation; a borrowed connection remains its owner's responsibility.

`close()` rejects new operations, aborts entered work, initiates owned disposal and then joins entered operations. Simultaneous closes share one attempt; successful repeated close is harmless. Failed cleanup throws `AgentHistoryCleanupError` with `retryCleanup()`. Keep that error or the history source until cleanup succeeds. A retry shares any still-running disposal attempt instead of starting a second one. Borrowed sources never dispose the supplied native client.

## Search and management

Metadata search and content search are separate ports. Descriptors state syntax, case sensitivity, ranking and scope; title matching does not imply transcript search. The package does not build its own index or emulate missing search by reading every conversation. Optional search scores and matched fields come from the native provider; scores are not comparable across providers. `totalEstimate` is an estimate, even when a native response can count its current result set.

Management defaults disabled. Select individual operations through the constructor's `management` array, then narrow the relevant port. Each mutation input must include `acceptEffects` matching that port's declared effects, including local/remote scope, descendants, active-session constraints and atomicity. A mismatch returns `not_applied` before native dispatch.

Well-formed mutation requests return `applied`, `not_applied` or `outcome_unknown`. Malformed arguments and foreign references reject before delegation. Once native dispatch has occurred, timeout, cancellation or an unclassified transport failure can produce `outcome_unknown`; they do not prove rollback. Never automatically retry an uncertain mutation. Further mutations on that source are fenced until the caller inspects native state and reopens; available read ports remain usable. Valid successful native receipts remain applied, including when a caller selects a small read-page budget or cleanup subsequently fails. Normal success waits for owned cleanup. If a receipt was recorded before cancellation or a deadline, that known result can return while cleanup retains operation capacity. A receipt arriving after an already returned unknown outcome cannot rewrite it.

The qualified operations differ by source:

| Source | Metadata search | Content search | Opt-in management |
| --- | --- | --- | --- |
| Claude local | Unavailable | Unavailable | Rename, delete with subagents |
| Codex app-server | Case-sensitive literal title | Unavailable | Rename, archive descendants, restore selected thread, delete descendants |
| OpenCode V2 server | Case-insensitive SQL-LIKE title | Unavailable | Rename, archive, restore, delete descendants |
| Cursor local SDK | Unavailable | Unavailable | Archive, restore, delete selected agent and its stored run data |
| Grok Build | Case-insensitive native metadata | Native ranked title/user-prompt search | Owned, caller-quiescent local rename/delete |
| Generic ACP | Unsupported by the pinned standard | Unsupported by the pinned standard | Delete unqualified; other operations unsupported |

An accepted descendant effect can include children whose project differs from their root. Project-scoped admission checks the selected root; it does not restrict a native cascade to that project. `requires_quiescent` is a caller obligation covering the affected subtree. A preflight activity observation is not a lock, lease or compare-and-swap guarantee. No native mutation is automatically retried.

```ts
// Include management: ['rename'] when constructing a provider that supports it.
if (history.rename.status === 'supported') {
  const result = await history.rename.apply({
    conversation: selected.ref,
    title: 'Release investigation',
    acceptEffects: history.rename.descriptor.effects,
  });
  // Handle all three outcomes; reconcile native state after outcome_unknown.
  console.log(result.status);
}
```

Rename accepts canonical nonblank text, up to 2,000 UTF-16 code units, with no leading/trailing whitespace or control characters. Grok has a narrower native limit described below. Empty-name native behaviors, including generated titles, are deliberately unavailable.

Read-only describes the exposed operations. Native reads may initialize storage, maintain an index or update auxiliary files. The source descriptor reports these effects; it does not promise filesystem immutability. Private native-file scraping, SDK-implemented migration of native formats and loading live sessions to simulate history are outside this package's contract.

## Public browsing examples

The standalone candidate checkout includes `examples/history/README.md` and the reusable `browseHistory(history, options)` helper. After building that checkout, `pnpm examples:history` runs its synthetic source without native SDKs, credentials or execution. `pnpm examples:history:claude` is a separate explicitly configured native reader; follow its documented root/project/resource arguments and install the exact optional peer first. The helper narrows each port, preserves pages and coverage, bounds traversal, and closes its supplied source in `finally`. Its default summary excludes IDs, titles, text, paths and cursors; the reusable result retains actual records for its caller.

MS009 compiled and executed the unchanged examples from eight packed development archives across the core-only, vendor-absent history/borrowed Codex, Claude, Codex, OpenCode, Cursor, ACP/Grok and complete-SDK compositions. Those archives retained the temporary 0.4.3 development version and were not a publication. A newly packed 0.4.4 candidate requires its own assembly checks; it does not inherit the old archive identities or broaden native qualification.

## Implementing a custom driver

`createAgentHistory({ source, driver, limits?, management? })` synchronously validates a preconstructed driver and returns the portable boundary. Every port must explicitly declare support. Supported descriptors and returned records pass through the public parsers. The driver receives validated input and a context containing `signal` and `markDispatched()`; public cursors are decoded to the driver's native continuation string.

Call `markDispatched()` immediately before entering a native mutation. Before that call, a rejected operation must have had no native mutation effect. After dispatch, return `not_applied` only when the native outcome establishes that fact; preserve an actual successful receipt. Mutation contexts additionally provide `recordReceipt(result)`: validate the native response and record its portable result once, before follow-up reads, signal checks or cleanup can fail. Return the same result when the operation settles. The boundary validates and preserves that recorded truth without relinquishing native cleanup ownership. This dispatch evidence is what lets the boundary distinguish a rejected request from a lost response. Driver errors must use bounded `AgentHistoryError` codes rather than exposing vendor response bodies, endpoints or credentials.

An owned source must provide `dispose()`, which stops native producers and resolves only when cleanup is complete. A borrowed source must not provide disposal. Driver construction and startup belong to the adapter; ownership transfers to the history object only after successful synchronous construction. If construction rejects, the caller still owns its supplied driver and any resources it already created. Native adapters must validate configuration before acquisition and retain cleanup responsibility on startup failure.

The root's portable validation does not replace native transport response limits. Validate and bound untrusted vendor responses at their ingress, normalize them into these contracts, and keep native classes and payloads out of public declarations.

## Claude native history

The explicit `/claude` entrypoint uses the official `@anthropic-ai/claude-agent-sdk@0.3.306` history helpers. Install that exact optional peer only when using Claude. Importing `/claude` works without the peer and performs no native I/O; construction checks the installed package version and qualified SDK entry digest. History helpers do not require launching the Claude Code executable. The qualification baseline records Code 2.1.306 separately.

```ts
import { createClaudeHistory } from '@agen-ai/agent-history/claude';

const history = await createClaudeHistory({
  sourceId: 'local-claude',
  generation: 'config-v1',
  configHome: '/absolute/claude-config',
  scope: { kind: 'project', projectPath: '/absolute/project', worktrees: 'excluded' },
  includeProgrammatic: true,
  resources: {
    kind: 'linux-prlimit',
    executable: '/usr/bin/prlimit',
    temporaryRoot: '/absolute/existing-temporary-directory',
  },
});

try {
  if (history.catalog.status === 'supported') {
    const page = await history.catalog.list({ limit: 20 });
    const first = page.items[0];
    if (first && history.transcript.status === 'supported') {
      const transcript = await history.transcript.read({ conversation: first.ref, limit: 20 });
      console.log(transcript.items, transcript.coverage);
    }
  }
} finally {
  await history.close();
}
```

Configuration and project directories must already exist. Each source creates a private temporary directory beneath the supplied temporary root; close removes that owned directory after its workers exit. The configured native home is never a temporary cleanup target. Select `{ kind: 'all_projects' }` to use the helper's all-project discovery. Project-only lookup/read checks the native metadata's physical working directory because the upstream direct helpers can otherwise traverse linked worktrees. Unavailable or deleted project metadata cannot establish that restricted scope. `includeProgrammatic` controls catalog discovery only; it does not restrict lookup by a known native ID.

Claude currently exposes catalog, metadata lookup and the main transcript, in native order. Search, archive and restore are unavailable. `management: ['rename', 'delete']` selectively enables native rename and deletion. Rename affects the selected session; deletion removes its native subagent artifacts but preserves independently forked sessions. Both are local, non-atomic operations requiring caller quiescence. Workers check scope before asking their parent for a single mutation permit; cancellation before that permit cannot dispatch the mutation. A titled existing conversation can have an empty transcript; missing, sidechain and summaryless files may all be unavailable through the metadata helper and return `not_found`. Reads check metadata before and after transcript retrieval, so an observed concurrent deletion does not become a successful empty result. Live native history can still change between observations.

The transcript reports `retained_chain`, with native-retention and subagent omissions. The helper can omit old content after compaction and strips some system-record metadata. Opaque system records become notices; they are never guessed to be compaction events. Ordered text/thinking/attachment content and tool observations remain in their native order across pages. Several normalized records can share the same genuine native history anchor. A continuation inside a native message checks that anchor again and rejects a changed record. Attachments remain inert references; small bounded inline data references are preserved, while unsupported or larger inline content reports an omission.

The qualified implementation uses a separate Linux process for each operation, with the configured home set before SDK import and no mutation of the caller's environment. The worker verifies kernel limits: 4 GiB address space, 12 CPU seconds, 128 file descriptors and zero core-file bytes. Supplementary Node settings are JITless execution and a 128 MiB heap. Each worker has a 20-second wall ceiling, a 32 KiB input envelope and a 256 KiB combined output ceiling. Source defaults lower normalized pages to 192 KiB and operation deadlines to 20 seconds. A 2 KiB continuation allowance means smaller page budgets must leave room for records and metadata.

Native helpers may load an entire file or enumerate a catalog before slicing; the process limits provide bounded failure, not a promise that every store fits. Individual returned native records also pass a 1 MiB/depth-16 ingress boundary before normalization. These per-process limits do not establish aggregate RSS containment or a general filesystem/network sandbox. The source bounds concurrent workers through ordinary read admission. Cancellation and close terminate owned process groups and wait for cleanup; incomplete cleanup remains retryable. The reader does not pass backend credentials or loader overrides into its worker environment.

## Codex native history

The explicit `/codex` entrypoint supports the qualified local app-server **0.163.0**. It exposes catalog, metadata lookup, main-transcript reading and literal, case-sensitive title search. `management` can independently enable rename, archive, restore and delete. Content search is unavailable. Importing the entrypoint does not find a home, start a process or require installation of the Codex npm package.

For an owned process, supply the exact qualified Linux x86_64 executable and explicit existing directories and launchers:

```ts
import { createCodexHistoryProcess } from '@agen-ai/agent-history/codex';

const history = await createCodexHistoryProcess({
  sourceId: 'local-codex',
  generation: 'config-v1',
  executable: '/absolute/path/to/native/codex',
  configHome: '/absolute/codex-home',
  scope: { kind: 'project', projectPath: '/absolute/project', worktrees: 'excluded' },
  catalogPolicy: 'state_db_only',
  resources: {
    kind: 'linux-prlimit-bubblewrap',
    resourceLauncher: '/usr/bin/prlimit',
    sandboxLauncher: '/usr/bin/bwrap',
    temporaryRoot: '/absolute/existing-temporary-directory',
  },
});

try {
  if (history.catalog.status === 'supported') {
    console.log(await history.catalog.list({ limit: 20, archived: 'exclude' }));
  }
} finally {
  await history.close();
}
```

This constructor checks the native executable SHA-256 `399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215` at construction and before every operation. Pass the native binary, not an npm launcher script. The package's exact Codex development dependency supplies qualification fixtures; consumers explicitly provide their executable. The host must support the configured Bubblewrap namespace policy. Unsupported hosts fail instead of silently running without containment.

`createCodexHistory` accepts a borrowed, already initialized `CodexHistoryConnection`, explicit `{ kind: 'caller_owned' }` resources, and the same source/scope/catalog configuration. That plain public connection port admits only the closed qualified history request shapes, including the four named mutation methods and returns bounded UTF-8 JSON-RPC response envelopes as `Uint8Array`. The host owns correlation, authentication, endpoint identity, startup policy and native resource containment; it must enforce the requested response-byte ceiling before allocating a complete response and honor cancellation. The adapter validates bytes before normalization, but cannot bound allocations or work that already occurred inside a supplied connection. Closing the history source never closes that connection. Its runtime assertion must identify exact `0.163.0`; this is a host assertion, not executable attestation.

Choose `catalogPolicy` deliberately. `state_db_only` omits threads that native metadata has not indexed and avoids list-time rollout scanning/repair. `scan_and_repair` uses native list repair and can add those threads to the index. On exact 0.163.0, a cold repair scan can return only a prefix and no continuation because the native index contains only that newly repaired prefix. The reader reports `provider_omission` and preserves the native cursor; it does not silently warm the whole store or invent a cursor. Complete catalog traversal is qualified for an already populated native metadata index. Neither policy promises an immutable store: native startup can initialize or migrate its SQL schema and update auxiliary files. The owned reader explicitly disables background rollout-to-indexed-store migration. Existing indexed stores are supported without enabling that migration; the qualification suite creates indexed fixtures separately.

Catalog defaults select all ten qualified native source kinds, including CLI, VS Code, app-server, programmatic and subagent categories. An explicit `sourceKinds` constructor selection limits catalog discovery, and per-call filters can only narrow it. Source-kind filters do not restrict a known-ID lookup within the configured project. The model-provider filter is unrestricted. Project matching is an exact native working-directory match, with no automatic linked-worktree traversal. Catalog supports separate active (`exclude`, the default) or archived (`only`) traversals; `include` and parent queries are unsupported. Parent references use the native subagent parent field, with the qualified stored thread-spawn source as a fallback when that field is absent. A separate native fork origin is not relabeled as a subagent parent. Native ordering means creation time descending; explicit creation/update ascending/descending orders are available. Empty saved threads can be retrieved by ID even when the catalog omits them. The qualified native file lookup can fall back to fuzzy search when an exact saved ID is missing. The adapter rejects a returned different ID with `native_failure`; it never relabels that other thread as the requested one.

Transcripts use metadata-only `thread/read`, then ascending `thread/turns/list` for legacy stores or ascending `thread/items/list` for already indexed stores. They never request a resumed execution session or a prompt. Legacy turn pagination may replay the entire native rollout internally before returning a turn; a returned page limit is not a native input-work limit. Each public read performs at most eight native requests, including metadata checks around transcript traversal. A page can be short or empty with a continuation; keep following `nextCursor`. Intra-item continuations retain genuine native turn/item anchors and reject observed changes or store-mode changes. Records preserve native order, tool call/result pairs and explicit compaction items. Unsupported native content becomes an omission or notice. The main view reports the retained chain and excludes subagent transcripts; it does not recover content removed by native compaction.

The owned reader starts a fresh stdio app-server for each operation in a clean environment. Bubblewrap provides a networkless PID namespace, a read-only host mount and writable access to the explicitly supplied native home and owned scratch directory. Remote-control startup, automatic gateway login, apps, plugins, analytics and update checks are disabled on the qualified tuple. Startup does not resume persisted threads or dispatch their queued/goal work. The reader's closed protocol surface contains no execution methods or approval replies.

Metadata search uses native `searchTerm` with the same catalog filters, ordering and continuation rules. It searches titles, not transcript contents. Rename affects the selected thread; archive and delete cascade to native descendants, including descendants in other projects and already archived descendants where the native operation includes them. Restore unarchives the selected thread only. Management reports local effects and unknown atomicity. Preflight requires the root's observed state to be idle or not loaded; callers must independently quiesce the full affected subtree, including other app-server processes.

The process verifies kernel ceilings of 2 GiB address space, 30 CPU seconds, 256 descriptors and zero core bytes. Framing limits are 2 MiB per response, 16 MiB combined output, 256 frames and one outstanding native request; each request has a 10-second ceiling and each process a 30-second ceiling. Normalized pages default to 192 KiB, with bounded continuation overhead; individual parsed envelopes also pass the shared 1 MiB/depth-16 data boundary. Native ascending catalog listing can enumerate the filesystem before returning a small page. These are per-process and per-operation bounds, not an aggregate RSS guarantee or a promise that arbitrary native stores fit. Cancellation and close terminate and join the owned process group before removing scratch data. Claude and Codex share this resource-ownership implementation; native homes are never cleanup targets.

## OpenCode V2 native history

The explicit `/opencode` entrypoint uses `@opencode/client/promise` from the exact optional peer **`@opencode/client@2.1.2`** against a supplied **OpenCode 2.1.2** server. It exposes catalog, metadata lookup and the main retained transcript. It does not start or stop the server. Importing the entrypoint works without the optional peer and makes no network request; asynchronous construction verifies the installed client version and calls the bounded native server-info route to check its reported runtime version. These checks establish compatibility, not executable or publisher attestation.

```ts
import { createOpenCodeHistory } from '@agen-ai/agent-history/opencode';

const history = await createOpenCodeHistory({
  sourceId: 'development-opencode',
  generation: 'server-project-v1',
  server: {
    baseUrl: 'http://127.0.0.1:4096/',
    runtimeVersion: '2.1.2',
    // Supply this server's authentication headers here when required.
  },
  scope: { kind: 'project', projectPath: '/absolute/server/project', worktrees: 'excluded' },
  resources: { kind: 'caller_owned' },
});

try {
  if (history.catalog.status === 'supported') {
    console.log(await history.catalog.list({ archived: 'exclude', limit: 20 }));
  }
} finally {
  await history.close();
}
```

The directory is an exact, normalized absolute POSIX path in the server's namespace; it need not exist on the SDK host. No local `realpath` or implicit process working directory is used. Optional `projectID` additionally restricts the native project identity. Catalog filters cannot widen this configured scope, and returned catalog and lookup metadata are checked against it. Source kind `opencode-v2-server` makes no claim that the server is local. Server access and native resource containment remain the caller's responsibility. Native storage effects are reported as unknown because server policy and auxiliary effects are outside this reader's ownership.

Catalog traversal defaults to native update time descending and includes archived sessions unless narrowed to `exclude` or `only`. Explicit update ascending/descending and native parent filters are supported. Creation-time orders are unavailable. The native cursor carries the initial catalog filters; subsequent native requests pass that cursor without respecifying them. Message traversal is ascending, with an optional fixed constructor `messageType` selection. The selected type is repeated on native continuation requests while order comes from the native cursor. A final nonempty native page can have a continuation followed by an empty terminal page. Follow `nextCursor` until it is absent, including after short or empty pages.

Transcripts preserve native message identifiers, ordered user/assistant/system content, tool observations and completed compaction summaries. Partial or failed compaction remains an observation, not a claim that compaction completed. Splitting a message across portable pages retains its native anchor and content fingerprint; an observed change invalidates that continuation. Native retention, excluded subagents, selected message types and unsupported content are disclosed through coverage and inert omission records. Attachments are bounded references and are never fetched. Metadata is checked before and after each transcript page so an observed deletion or scope change cannot be returned as a successful empty conversation.

The client admits only the qualified GET history/server-info/activity routes and explicitly selected PATCH/DELETE session routes on the configured origin and base path. Redirects are rejected. Request URLs and headers together are capped at 32 KiB; response streams are stopped above 1 MiB before the official client parses JSON, with strict UTF-8 validation. Parsed history also passes the shared structural bounds. Each public operation makes at most eight native requests; transcript pages reserve two of those for metadata checks. Normalized pages default to and cannot exceed 192 KiB, and operation deadlines cannot exceed 30 seconds. These limits bound client-owned work; they do not bound the remote server's memory or prove a small native input scan.

Authentication denial returns a sanitized `access_denied` error. Native missing sessions, invalid continuations, inaccessible scope, malformed responses and oversized bodies remain distinct outcomes. Cancellation and close abort and drain this client's entered HTTP operations, while leaving the supplied server usable. They do not assert that a remote server rolled back or stopped all internal work. Metadata search uses native title SQL-LIKE matching: `%` and `_` retain wildcard meanings and native ASCII case folding. Catalog filters and continuation rules also apply to search. Transcript content search is unavailable.

Opt-in rename, archive and restore affect the selected session. Delete cascades through native descendants, including cross-project children. Effects have `provider_managed` scope because the supplied server owns storage and any replication; the adapter cannot promise local-only deletion. All operations require caller quiescence and report unknown atomicity. The bounded active-session map can reject an observed active root, but cannot certify inactivity across processes or lock its descendants. Only the official successful HTTP 204 response confirms application; interruption after dispatch remains uncertain.

## Cursor local SDK history

The explicit `/cursor` entrypoint reads existing **`@cursor/sdk@1.0.40`** JSONL or SQLite local stores through the official SDK. Install that exact optional peer when using this provider. Construction requires Linux, Node **22.13 or later**, explicit existing store/project directories and an executable resource launcher. The ordinary package root retains Node >=22 compatibility. Importing `/cursor` remains inert without the optional peer; construction and each isolated worker verify the qualified SDK entry bytes. Executor platform binaries are unnecessary for these history reads.

```ts
import { createCursorHistory } from '@agen-ai/agent-history/cursor';

const history = await createCursorHistory({
  sourceId: 'local-cursor-sdk',
  generation: 'store-project-v1',
  store: { kind: 'jsonl', path: '/absolute/existing-sdk-store' },
  scope: { kind: 'project', projectPath: '/absolute/project', worktrees: 'excluded' },
  resources: {
    kind: 'linux-prlimit',
    executable: '/usr/bin/prlimit',
    temporaryRoot: '/absolute/existing-temporary-directory',
  },
});

try {
  if (history.catalog.status === 'supported' && history.views.status === 'supported'
    && history.transcript.status === 'supported') {
    const conversation = (await history.catalog.list({ limit: 20 })).items[0];
    if (conversation) {
      const checkpoint = await history.transcript.read({ conversation: conversation.ref });
      const runs = await history.views.list({ conversation: conversation.ref, kind: 'run' });
      const run = runs.items[0];
      const replay = run && await history.transcript.read({
        conversation: conversation.ref, view: run.view,
      });
      console.log({ checkpoint, runs, replay });
    }
  }
} finally {
  await history.close();
}
```

Use `store.kind: 'sqlite'` for the official SQLite backend. Source kind `cursor-local-sdk` identifies a specific SDK store and project; it does not discover arbitrary IDE chats or legacy CLI databases. Project matching is exact, with no implicit current directory or worktree expansion. An omitted project would let the native helper use the worker's working directory, so all-project browsing is unavailable. Cloud-shaped IDs are rejected before native lookup, preventing the SDK's automatic cloud routing.

Catalog and lookup preserve native agent identity, title, available timestamps and archive observations. Catalog uses native order and project scope; it has no archive filter or search fallback. Catalog and run discovery each make at most eight native list calls per page, preserving continuations after short or empty pages. `views.list` discovers terminal run views for the selected conversation. Running/queued runs are excluded because their native conversation reader can tail execution. Runs are named transcript views, not child conversations or fabricated portable turn IDs. Other providers explicitly report whether named-view discovery is supported.

The main transcript comes from `Agent.messages.list` and describes the **current checkpoint**. A run view comes from `Agent.getRun(...).conversation()` and describes **stored updates** for that run; a checkpoint-only run can have no replay events. Neither promises a complete lifetime transcript. Native helper omissions, retention and excluded subagents remain visible in coverage, including the native helper's ability to return an empty result for malformed checkpoint content. Tools and attachments remain inert. Genuine stored user message IDs are preserved; native helper identifiers derived from list offsets, missing assistant IDs, tool call IDs and timestamps are never invented. Continuations retain checkpoint-root or settled-run revision observations and content fingerprints, rejecting observed changes during traversal.

JSONL reads do not modify the selected source store. SQLite opening can initialize or migrate native storage and update auxiliary files, which the source descriptor discloses. Worker-owned home/cache/temp directories are separate from the selected store. The adapter never configures the SDK globally in the caller process, starts a run, resumes an agent or supplies a backend key.

Opt-in archive/restore update the selected agent's native status and require caller quiescence. Delete removes the selected agent and its native runs, events and checkpoints; it does not recursively delete other agent conversations. All three are local and non-atomic. Preflight rejects an observed active agent/run, and native deletion also rejects its nonterminal active run. This guard is not an atomic cross-process exclusion guarantee. Missing selected agents fail preflight; repeated archive/restore preserve native idempotent status behavior. Rename and search are unavailable. The shared worker sends its native receipt before SQLite disposal, so a later disposal failure cannot rewrite a confirmed mutation.

Claude and Cursor share the isolated JSON worker transport: 4 GiB address space, 12 CPU seconds, 128 file descriptors, zero core bytes, a 128 MiB Node heap and a 20-second wall ceiling. Worker input is capped at 32 KiB, combined output at 256 KiB and normalized pages at 192 KiB. The native SDK can read a whole checkpoint or replay before returning a page; these limits can reject large stores and do not establish aggregate RSS bounds or filesystem sandboxing. Cancellation and close terminate and join owned process groups before deleting scratch directories. Native stores are never cleanup targets.

Cursor on Node 22 uses a separate bounded WebAssembly profile: JIT is enabled and `--disable-wasm-trap-handler` selects inline WebAssembly bounds checks so Node's bundled HTTP implementation fits the existing address-space limit. Its ESM HTTP import otherwise initializes Undici with WebAssembly unavailable under `--jitless`. All numeric worker limits remain enforced and checked inside the worker. Cursor on Node 24 retains the JITless profile; Claude always retains its existing JITless profile. This is an internal compatibility policy, not caller-selected Node flags or a general executable-memory isolation guarantee.

Cursor Cloud is a separate **unqualified source kind** in this release. Authenticated read-only probes established that current v1 agent/run metadata was reachable, but the sampled saved run's event stream had expired with HTTP 410. The current API documents retention-limited run streams; metadata availability alone does not qualify successful transcript replay. The SDK's local message helper is not a cloud transcript API. No cloud constructor, legacy v0 fallback, private IDE scraping, or universal Cursor-history claim is shipped. See the official [TypeScript SDK](https://cursor.com/docs/sdk/typescript) and [Cloud API stream retention](https://cursor.com/docs/cloud-agent/api/endpoints#retention) for the native distinction.

## Negotiated ACP discovery

The explicit `/acp` entrypoint provides saved-session discovery through an already initialized ACP connection using **`schema-v1.23.0`**. It does not launch or initialize the agent. Supply the actual initialization response and a narrow listing port backed by the existing `@agen-ai/acp-transport` implementation:

```ts
import { createAcpStandardSessionOperations } from '@agen-ai/acp-transport';
import { createAcpHistory } from '@agen-ai/agent-history/acp';

// The host constructs and owns a bounded ACP client and its native process.
const operations = createAcpStandardSessionOperations(client);
const initialization = await operations.initialize({
  protocolVersion: 1,
  clientCapabilities: {},
});
const history = createAcpHistory({
  providerKey: 'my-acp-agent',
  sourceId: 'connected-agent',
  generation: 'connection-project-v1',
  scope: { kind: 'project', projectPath: '/absolute/native/project', worktrees: 'excluded' },
  connection: {
    protocolProfile: 'schema-v1.23.0',
    initialization,
    resources: { kind: 'caller_owned', maxInboundFrameBytes: 1_048_576 },
    listSessions: (params, options) => operations.listSessions(params, options),
  },
});
try {
  if (history.catalog.status === 'supported') {
    console.log(await history.catalog.list({ limit: 20 }));
  }
} finally {
  await history.close();
  // The host still owns client disposal and native process cleanup.
}
```

The connection's ingress limit describes the bound the host actually configured on the transport; it is not a request to reconfigure that client. The adapter additionally validates bounded parsed responses. `providerKey` identifies the connected provider but grants no capability. Catalog support requires the observed native `agentCapabilities.sessionCapabilities.list` field. Absent negotiation produces an unsupported port and no list dispatch. A previously initialized client supplies its existing result instead of initializing again.

Generic ACP exposes catalog discovery only. The native standard has no independent saved-transcript, lookup, search, rename, archive or restore operation. Optional standard deletion has a typed transport facade but remains unqualified in this generic history adapter; negotiation alone cannot establish its effects. `session/load` is not used as a transcript reader. A provider name never enables Grok-specific extension behavior.

Scope is an exact native project directory or explicit `all_projects`; a project filter may narrow all-project browsing. Paths belong to the native agent, not the SDK host filesystem. Catalog uses native order, unknown archive state and provider-defined coverage. The source kind is `acp-standard-discovery`, native ownership is borrowed and storage effects are unknown. Closing history aborts and drains its entered calls while preserving the host's connection.

The pinned standard list request has no page-size control. The adapter reads at most eight native pages per operation and splits an already bounded page when necessary. Continuations retain the native page-start cursor, offset and content fingerprint, then refetch that page; an observed change invalidates continuation. They never contain a copied page of messages. Short or empty pages with continuations remain valid. Parsed envelopes are limited to 1 MiB and 1,000 sessions; normalized pages to 192 KiB, with a 30-second maximum operation deadline. These bounds do not contain work or allocations inside the caller-owned agent. The standard facade preserves existing legacy-profile behavior: listing remains available there, while deletion is admitted only by a profile that includes it.

## Grok Build stored history

The explicit `/grok` entrypoint reads the qualified **Grok Build 1.0.62** saved-session store through the existing ACP transport. It supports catalog, metadata lookup and surviving stored updates for one exact project. The owned-process constructor requires the exact executable, an existing native home containing its `sessions` directory, and Linux resource launchers:

```ts
import { createGrokHistoryProcess } from '@agen-ai/agent-history/grok';

const history = await createGrokHistoryProcess({
  sourceId: 'local-grok-build',
  generation: 'home-project-v1',
  executable: '/absolute/qualified/grok',
  nativeHome: '/absolute/existing/grok-home',
  scope: { kind: 'project', projectPath: '/absolute/project', worktrees: 'excluded' },
  resources: {
    kind: 'linux-prlimit-bubblewrap',
    resourceLauncher: '/usr/bin/prlimit',
    sandboxLauncher: '/usr/bin/bwrap',
    temporaryRoot: '/absolute/existing-temporary-directory',
  },
});
try {
  if (history.catalog.status === 'supported' && history.transcript.status === 'supported') {
    const conversation = (await history.catalog.list({ limit: 20 })).items[0];
    if (conversation) console.log(await history.transcript.read({ conversation: conversation.ref }));
  }
} finally {
  await history.close();
}
```

Catalog, lookup and transcript operations start a fresh native home and mount the selected `sessions` directory read-only. A held directory descriptor and identity checks preserve the selected store across launch; Bubblewrap must support `--ro-bind-fd`. Home, XDG and launch directories live beneath a fixed sandbox path in a fresh `/tmp`, preventing configuration discovery through the host scratch directory's ancestors. The explicit host scratch root must be outside the original native home and selected project. Original account credentials, home/project configuration and machine configuration are excluded, and networking is disabled. Search indexes and read-time auxiliary caches belong to scratch storage; explicit management has the separate writable policy below. The original store is never a cleanup target. This exact storage-layout mapping is version-qualified; it is not a generic parser for Grok files.

The constructor verifies the executable SHA-256 `2a46d9e4d7ebd7a9cff7f95716714b19dad5f21dd2a497822400b1fb128969aa` and observed native version. This identifies the qualified bytes, not publisher authenticity. The official exact npm distribution contains the same executable; the history package does not install or launch it at import. Install the coordinated optional `@agen-ai/acp-transport` peer when constructing an owned reader.

For an already initialized host-owned process, synchronous `createGrokHistory` accepts the actual initialization result, exact runtime/profile identity and three required named methods: `listSessions`, `sessionState` and `sessionUpdates`. Optional `sessionSearch` enables native content search. The connection's `resources` declares its actual ingress bound. `grokHistoryExtensions()` supplies the exact outbound history/search extension definitions; an explicit management selection additionally registers only the chosen admin definitions for the host's existing ACP registry. Borrowed history does not initialize or dispose that connection, and cannot promise the owned constructor's source isolation or native resource limits. Its storage effects are unknown.

Catalog selects native Build sessions and excludes child sessions. Direct metadata and transcript reads check the returned native project, including when Grok looks up an ID outside the requested directory. Missing state is distinguished from an empty stored update list. Transcripts use `_x.ai/session/updates`, with `_x.ai/session/state` providing metadata and revision observations. Neither `session/load`, the unsupported `load_history` route, nor a prompt is used.

The main view describes **stored updates** on the surviving branch, with native-retention, provider and subagent omissions. Adjacent text chunks remain separate records; their count is not a message or turn count. Genuine event IDs and timestamps are preserved when available. Tool observations and attachments are inert; native display titles do not establish executable tool identity. Unsupported or oversized inline content produces explicit omissions. Continuations retain a native offset, observed state revision, total update count and preceding-update fingerprint. Native launch-home metadata is excluded from that revision because it describes launch context rather than persisted conversation content. Observed changes invalidate continuation; this is a live traversal, not a snapshot.

Owned reads have a 20-second wall ceiling, 4 GiB address space, 20 CPU seconds, 256 file descriptors and zero core bytes per process. ACP ingress is capped at 1 MiB, with one outstanding request, at most eight native calls per operation including initialization, and 192 KiB normalized pages. Native update retrieval can read the whole saved file before returning one update, so a small requested page does not promise success for an arbitrarily large store. Cancellation and close stop and join the owned process group before removing scratch storage. Metadata search uses native list filtering, preserves native order and excludes child sessions. Content search uses the native FTS index, including saved titles and user prompts; it does not promise assistant/tool-text matching or full lifetime history. Native token-prefix matching, AND/OR fallback, ASCII folding and UUID handling are provider-defined. Results preserve native ranking, snippets, matched fields and optional estimates. The native search window permits offsets through 1,000; truncation reports `resource_limit`, and native omissions remain disclosed, including body content in saved files larger than 30 MiB (their titles remain searchable). A settling index is retried only within the read budget and never becomes a false complete empty page.

Owned content search gives the native helper a fresh writable cache and mounts its original encoded-project directories read-only through held descriptors. Directory discovery is bounded to 256 entries and 64 project mounts; it reads no saved-session content itself. The native query and returned hits must match the exact selected project. Search neither copies the user's history into an SDK index nor modifies the source store.

Owned rename/delete require both an individual `management` selection and `localManagement: { kind: 'caller_quiescent' }`. The latter is an explicit caller obligation to exclude writers; it is not an SDK lease. After read-only scope/existence preflight, the isolated, unauthenticated, networkless native process receives a writable held-descriptor sessions mount (`--bind-fd`). These effects are local, have unknown atomicity, and preserve child conversations. Native index maintenance may accompany the explicit mutation. Rename further requires at most 100 Unicode scalars and 464 UTF-8 bytes. Native delete of an already missing ID is idempotent. Borrowed management and authenticated local/remote deletion remain unqualified; archive/restore are unavailable.
