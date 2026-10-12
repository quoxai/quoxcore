/**
 * In-Memory Storage Backend
 *
 * Stores evidence in memory. Useful for testing and development.
 */

import { EvidenceStorageBackend, StorageBackend } from '../types.js';

export class MemoryStorageBackend implements EvidenceStorageBackend {
  readonly type: StorageBackend = 'memory';
  private storage: Map<string, Buffer> = new Map();

  async init(): Promise<void> {
    // No initialization needed
  }

  async store(id: string, content: Buffer): Promise<string> {
    const path = `memory://${id}`;
    this.storage.set(path, content);
    return path;
  }

  async retrieve(storagePath: string): Promise<Buffer> {
    const content = this.storage.get(storagePath);
    if (!content) {
      throw new Error(`Evidence not found: ${storagePath}`);
    }
    return content;
  }

  async delete(storagePath: string): Promise<boolean> {
    return this.storage.delete(storagePath);
  }

  async exists(storagePath: string): Promise<boolean> {
    return this.storage.has(storagePath);
  }

  async close(): Promise<void> {
    this.storage.clear();
  }

  /**
   * Get the number of stored items (for testing)
   */
  size(): number {
    return this.storage.size;
  }
}

export function createMemoryStorageBackend(): EvidenceStorageBackend {
  return new MemoryStorageBackend();
}
