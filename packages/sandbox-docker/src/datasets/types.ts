// ------------------------------------------------------------------------------------------------
//                types.ts - Explicit borrowed image datasets at fixed guest mount targets
// ------------------------------------------------------------------------------------------------

export interface DockerSandboxDataset {
  readonly name: string;
  readonly imageDigest: string;
  readonly subpath?: string;
}
