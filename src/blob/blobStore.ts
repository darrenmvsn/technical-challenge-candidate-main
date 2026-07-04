import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'

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

export class LocalBlobStore implements BlobStore {
  private readonly root: string

  constructor(rootDir: string) {
    this.root = resolve(rootDir)
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  async get(key: string): Promise<Buffer | null> {
    const path = this.pathFor(key)
    try {
      return await readFile(path)
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') return null
      throw err
    }
  }

  private pathFor(key: string): string {
    if (key.length === 0) throw new Error('blob key must not be empty')
    const full = resolve(this.root, key)
    const rootPrefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`
    if (full !== this.root && !full.startsWith(rootPrefix)) {
      throw new Error(`blob key escapes storage root: ${key}`)
    }
    return full
  }
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
