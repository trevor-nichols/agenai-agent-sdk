# Migrating to 0.3.1

Version `0.3.1` is a compatible patch over `0.3.0`. It preserves Agent Protocol V9, every exported
entrypoint, and all public runtime behavior. No source migration is required for hosts or provider
adapters that already use the coordinated `0.3.0` packages.

## Authentication ownership

The release makes the existing boundary explicit: authentication belongs to the provider adapter,
not to the public SDK. An adapter may use an existing subscription login, an interactive account
flow, an API credential, or another mechanism supported by its provider. The SDK does not require
an API key and does not define a credential preference.

Keep these concerns outside the public contracts:

- provider-native credentials and account files;
- login, logout, replacement, and recovery commands;
- product user, workspace, membership, and visibility identities;
- terminal grants, host paths, binding receipts, and persistence fences.

The host still authorizes and selects a configured provider instance before invoking the runtime.
Opaque protocol identifiers remain correlation values, never authorization credentials.

## Upgrade checklist

Upgrade all three packages together:

```sh
pnpm add @agen-ai/validation@0.3.1 @agen-ai/agent-protocol@0.3.1 @agen-ai/agent-runtime@0.3.1
```

Then run the consumer's normal typecheck and tests. No adapter or serialized-data migration is
expected. If an integration relied on an undocumented assumption that every adapter uses an API
key, replace that host-side assumption with the adapter's own configuration and readiness model.

The coordinated `0.3.1` packages are published under both npm's `beta` and `latest` tags. Package
publication and dist-tag management remain release operations outside the SDK runtime contract.
