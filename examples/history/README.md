# Browse native conversation history

Run the bundled example from the standalone public SDK checkout:

```sh
pnpm examples:history
```

`main.ts` constructs a custom source through `@agen-ai/agent-history` using the
two synthetic conversations in `fixture.ts`. The example also imports public ID
parsers from `@agen-ai/agent-protocol`; declare both packages when copying it
into a separate project. It runs without native vendor
packages, credentials, a model or an execution provider. Page size one produces
two catalog pages and five transcript pages for the selected release review.
The records include an attachment reference, historical tool call/result and
compaction. Those records are inert; browsing does not open attachments, run
tools, generate prompts or continue an agent turn.

`browse.ts` exports `browseHistory(history, options)`. Construct the source with
an explicit native root, project, account or caller-owned connection first, then
pass that source and a conversation predicate. The predicate receives only
summaries from the browsed catalog. An unmatched predicate leaves the transcript
skipped. The function reads the catalog, optionally looks up the selected
conversation, and reads its main transcript when supported. Every optional port
is narrowed and reported with its descriptor or unsupported reason. Search,
named transcript views and management ports are reported without invocation.

The result preserves the original source, catalog pages, selected summary,
optional metadata and transcript pages, including their exact coverage,
observation times, consistency and records. `traversal: 'exhausted'` means the
selected native view has ended; coverage can still report compacted, deleted or
otherwise omitted history. `traversal: 'page_limit'` means the example stopped at
its retention bound. The default is at most 32 pages per traversal, each with one
item. Both `pageSize` and `maxPages` accept integers from 1 through 100; a source
may require a lower page size. A retained cursor belongs to the same query and
history instance and cannot be reused after this function closes that instance.

The function takes responsibility for closing the supplied history in `finally`,
including selection, lookup and read failures. It returns only after successful
close. If cleanup fails, keep the thrown `AgentHistoryCleanupError` and its
`retryCleanup()` responsibility until native cleanup succeeds. Do not serialize
that error or automatically repeat a failed browsing operation to clean it up.

`summary.ts` prints a structural result: source/scope kinds, storage-effect enums,
capability status/reason codes, page counts, record kinds, consistency and
coverage. It omits conversation IDs, titles, text, paths, attachment references
and cursors. The reusable function returns the actual records to its caller;
applications must decide what their own output should disclose.

## Explicit Claude local source

Install the exact optional `@anthropic-ai/claude-agent-sdk@0.3.306` peer before
using this entrypoint. The supported resource policy requires Linux and an
explicit executable `prlimit`. All three directories must already exist. Choose
a disposable or otherwise intended native configuration; the source descriptor
reports the native storage effects. No home directory discovery, authentication
or live execution is performed by the example.

```sh
pnpm examples:history:claude \
  --config-home /absolute/claude-config \
  --project /absolute/project \
  --temporary-root /absolute/temporary-directory \
  --resource-launcher /usr/bin/prlimit \
  --conversation-id exact-native-session-id
```

Omit `--conversation-id` to select the first conversation returned by the scoped
catalog. Selection only searches the first 32 catalog pages. An empty catalog or
an ID outside those pages returns a skipped transcript, with the traversal state
showing whether the catalog was exhausted. Management stays disabled. The
constructor and browser use only public entrypoints; importing `browse.ts`,
`fixture.ts` or `summary.ts` does not import the Claude adapter. Other sources can
call the same reusable function after their own explicit construction.

This synthetic run proves portable browsing and public package consumption.
Native source qualification, supported platform/runtime tuples and backend
authentication remain separate evidence; the fixture makes no native coverage
claim.
