// ------------------------------------------------------------------------------------------------
//                spill.ts - Explicit bounded byte storage for transfer metadata - Backend SPI
// ------------------------------------------------------------------------------------------------

export interface SandboxDriverSpillFile {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<Readonly<{ bytesRead: number }>>;
  write(buffer: Uint8Array, offset: number, length: number, position: number): Promise<Readonly<{ bytesWritten: number }>>;
  truncate(size: number): Promise<void>;
  close(): Promise<void>;
}

export interface SandboxDriverSpillStore {
  createFile(): Promise<SandboxDriverSpillFile>;
  close(): Promise<void>;
}
