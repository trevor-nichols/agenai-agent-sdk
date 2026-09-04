// ------------------------------------------------------------------------------------------------
//                index.ts - Deliberate Zod schema composition surface
// ------------------------------------------------------------------------------------------------

export {
  AgentApprovalOptionIdSchema,
  AgentArtifactIdSchema,
  AgentCollaborationIdSchema,
  AgentConfigurationRevisionIdSchema,
  AgentErrorContextSchema,
  AgentErrorSchema,
  AgentInstanceIdSchema,
  AgentIntegrationIdSchema,
  AgentIntegrationResourceIdSchema,
  AgentIntegrationServerIdSchema,
  AgentIntegrationToolIdSchema,
  AgentIsoDateTimeSchema,
  AgentItemIdSchema,
  AgentJsonValueSchema,
  AgentManagedContentIdSchema,
  AgentOperationIdSchema,
  AgentOperationInvocationIdSchema,
  AgentProviderConversationIdSchema,
  AgentProviderHistoryAnchorSchema,
  AgentProviderItemRefSchema,
  AgentProviderKeySchema,
  AgentProviderRefsSchema,
  AgentProviderRequestRefSchema,
  AgentProviderTurnRefSchema,
  AgentRequestFieldIdSchema,
  AgentRequestIdSchema,
  AgentSessionIdSchema,
  AgentGeneratedResourceIdSchema,
  AgentTurnIdSchema,
} from './foundation.js';
export {
  AgentSessionBindingSchema,
  AgentSessionBranchSourceSchema,
  AgentSessionBranchInputSchema,
  AgentSessionConfigurationSchema,
  AgentSessionCreateInputSchema,
  AgentSessionOpenInputSchema,
  AgentSessionResumeInputSchema,
} from './sessions.js';
export {
  AgentBrowserActionDetailsSchema,
  AgentCollaborationToolCallDetailsSchema,
  AgentCommandExecutionDetailsSchema,
  AgentComputerActionDetailsSchema,
  AgentContentStreamKindSchema,
  AgentContextCompactionDetailsSchema,
  AgentDiffSummarySchema,
  AgentDynamicToolCallDetailsSchema,
  AgentFileChangeDetailsSchema,
  AgentFileChangeSchema,
  AgentImageViewDetailsSchema,
  AgentItemSnapshotSchema,
  AgentMcpToolCallDetailsSchema,
  AgentPlanStepSchema,
  AgentReviewDetailsSchema,
  AgentTurnCompletedPayloadSchema,
  AgentTurnInputContentCompositionSchema,
  AgentTurnInputContentSchema,
  AgentTurnInteractionModeSchema,
  AgentTurnInputPartSchema,
  AgentTurnInterruptionInputSchema,
  AgentTurnRunInputSchema,
  AgentWebSearchDetailsSchema,
} from './turns.js';
export {
  AgentApprovalRequestSchema,
  AgentApprovalResolutionSchema,
  AgentElicitationRequestSchema,
  AgentRequestResolutionSchema,
  AgentRequestSchema,
} from './requests.js';
export {
  AgentOperationCatalogSchema,
  AgentOperationDescriptorSchema,
  AgentOperationFieldSchema,
  AgentOperationInvocationSchema,
  AgentOperationResultSchema,
} from './operations.js';
export {
  AgentManagedContentCatalogSchema,
  AgentManagedContentDescriptorSchema,
} from './managedContent.js';
export {
  AgentConfigurationCatalogSchema,
  AgentConfigurationFieldPortableSchema,
  AgentConfigurationSelectionInputSchema,
  AgentConfigurationValueSchema,
} from './configuration.js';
export {
  AgentIntegrationCatalogSchema,
  AgentIntegrationDescriptorSchema,
} from './integrations.js';
export {
  AgentCollaborationControlInputSchema,
  AgentCollaborationNodeSchema,
  AgentCollaborationSpawnInputSchema,
} from './collaboration.js';
export { AgentGeneratedResourceDescriptorSchema } from './resources.js';
export {
  AgentApprovalCapabilitySchema,
  AgentCapabilitiesSchema,
} from './capabilities.js';
export { AgentArtifactDescriptorSchema } from './artifacts.js';
export { AgentContextUsageSchema, AgentEventSchema } from './events.js';
export type { AgentProtocolSchemaTypeAssertions } from './typeEquality.generated.js';
