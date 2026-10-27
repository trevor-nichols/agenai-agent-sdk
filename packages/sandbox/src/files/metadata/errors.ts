import { SandboxValidationError } from '../../errors.js';

export class MetadataConflictError extends SandboxValidationError {
  constructor(readonly code: 'duplicate_path' | 'file_ancestor' | 'symlink_ancestor', readonly path: string) {
    super([{ code: 'invalid_input', path: ['path'], message: `Metadata ${code}: ${path}` }]);
    this.name = 'MetadataConflictError';
  }
}
