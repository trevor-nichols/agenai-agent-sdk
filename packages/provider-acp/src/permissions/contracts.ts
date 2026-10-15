export interface AcpPermissionOptionSignature {
  readonly optionId: string;
  readonly kind: 'allow_once' | 'reject_once' | 'allow_always' | 'reject_always';
}

export interface AcpPermissionMenuSignature {
  readonly toolKind: 'read' | 'edit' | 'delete' | 'move' | 'search'
    | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';
  readonly options: readonly [AcpPermissionOptionSignature, ...AcpPermissionOptionSignature[]];
}

/** Complete declarations attest that these exact menus add no unrepresented choice effects. */
export type AcpPermissionMappingSelection =
  | Readonly<{ mapping: 'once-only-v1' }>
  | Readonly<{ mapping: 'grok-build-1.0.50-edit-remembrance-v1' }>
  | Readonly<{
      mapping: 'declared-complete-consequences-v1';
      agentInfo: Readonly<{ name: string; version: string }>;
      menus: readonly [AcpPermissionMenuSignature, ...AcpPermissionMenuSignature[]];
    }>;
