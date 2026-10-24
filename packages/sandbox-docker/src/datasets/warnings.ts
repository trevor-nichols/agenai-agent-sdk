// ------------------------------------------------------------------------------------------------
//                warnings.ts - Exact advisory admission for explicitly selected image mounts
// ------------------------------------------------------------------------------------------------

const IMAGE_MOUNT_ADVISORY = 'Image mount is an experimental feature';

export function hasUnexpectedImageMountWarnings(warnings: readonly string[], imageMounts: number): boolean {
  return warnings.length > 0 && (warnings.length !== imageMounts || warnings.some((warning) => warning !== IMAGE_MOUNT_ADVISORY));
}
