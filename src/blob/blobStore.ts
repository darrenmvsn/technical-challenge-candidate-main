export interface BlobStore {
  put(key: string, bytes: Buffer): Promise<void>
  get(key: string): Promise<Buffer | null>
}

/** In-memory stub for the real blob store. Explicit `null` on a missing key — never a silent empty buffer. */
export class MemoryBlobStore implements BlobStore {
  private m = new Map<string, Buffer>()
  async put(key: string, bytes: Buffer): Promise<void> { this.m.set(key, bytes) }
  async get(key: string): Promise<Buffer | null> { return this.m.get(key) ?? null }
}
