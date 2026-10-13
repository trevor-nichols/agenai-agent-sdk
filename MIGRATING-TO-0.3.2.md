# Migrating to 0.3.2

> Superseded unpublished preparation: `0.3.2` was never published. Its runtime correction is
> carried into coordinated `0.4.0`. Use [MIGRATING-TO-0.4.md](MIGRATING-TO-0.4.md) for the current
> release and upgrade instructions.

Version `0.3.2` was prepared as a compatible patch over `0.3.1` and was never published.
The following describes that historical preparation, not the current SDK contract.

Agent Protocol V9, exported types, entrypoints, serialized schemas and dependency boundaries are
unchanged. The patch corrects enforcement of the existing steering uncertainty contract. All three
packages were prepared together under the coordinated release policy. The successor `0.4.0`
release advances to Agent Protocol V10 and replaces the segmented turn API.

## Steering lifecycle correction

If a provider returns `{ status: "delivery_uncertain", error }`, the validated session preserves
that receipt and becomes unusable for later mutation. Its active output stream can still reach
the existing terminal or pending-request boundary. Further mutations fail with `session_unusable`;
the host must close and rematerialize the session before continuing.

The host must preserve the unresolved delivery state. Closing or reopening a session does not prove
that the original input was delivered or rejected. Do not automatically resend the steering text,
convert it into a follow-up turn, or retry a pending action based on that uncertainty.

A definitive `rejected` result remains reusable. Pre-delegation validation failures still preserve
their original errors, and provider-invoked steering failures retain the existing started-execution
evidence. Accepted interruption of an already-waiting turn already invalidated the session in
`0.3.1`; this patch does not introduce that behavior.

## Historical preparation checklist

The original prepared install command is retained below as historical evidence. Use the current
[MIGRATING-TO-0.4.md](MIGRATING-TO-0.4.md) checklist for the current release:

```sh
pnpm add @agen-ai/validation@0.3.2 @agen-ai/agent-protocol@0.3.2 @agen-ai/agent-runtime@0.3.2
```

Run the consumer's typecheck and lifecycle tests. Verify that returned steering uncertainty is
shown honestly, that the current output stream can settle, and that a later action closes and
rematerializes the unusable session without replaying the unresolved input. No adapter signature or
serialized-data migration is required.

Maintainers validate this source through the governed public projection and packed consumer before
the separate publication workflow. Preparing or exporting this source does not publish packages,
create release tags, submit provenance, or promote registry dist-tags.
