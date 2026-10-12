/**
 * File Storage Backend
 *
 * Stores evidence in the local filesystem.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { EvidenceStorageBackend, StorageBackend } from '../types.js';

export interface FileBackendConfig {
  basePath: string;
  createDirectory?: boolean;
}

export class FileStorageBackend implements EvidenceStorageBackend {
  readonly type: StorageBackend = 'file';
  private basePath: string;
  private createDirectory: boolean;

  constructor(config: FileBackendConfig) {
    this.basePath = config.basePath;
    this.createDirectory = config.createDirectory ?? true;
  }

  async init(): Promise<void> {
    if (this.createDirectory) {
      await fs.mkdir(this.basePath, { recursive: true });
    }
  }

  async store(id: string, content: Buffer): Promise<string> {
    // Create subdirectories based on first characters of ID for better distribution
    const subdir = id.slice(0, 2);
    const dir = path.join(this.basePath, subdir);
    await fs.mkdir(dir, { recursive: true });

    const filePath = path.join(subdir, id);
    const fullPath = path.join(this.basePath, filePath);

    await fs.writeFile(fullPath, content);
    return filePath;
  }

  private safePath(storagePath: string): string {
    const fullPath = path.resolve(this.basePath, storagePath);
    if (!fullPath.startsWith(path.resolve(this.basePath))) {
      throw new Error('Invalid storage path: traversal detected');
    }
    return fullPath;
  }

  async retrieve(storagePath: string): Promise<Buffer> {
    return fs.readFile(this.safePath(storagePath));
  }

  async delete(storagePath: string): Promise<boolean> {
    try {
      await fs.unlink(this.safePath(storagePath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async exists(storagePath: string): Promise<boolean> {
    try {
      await fs.access(this.safePath(storagePath));
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // No cleanup needed for file backend
  }
}

export function createFileStorageBackend(config: FileBackendConfig): EvidenceStorageBackend {
  return new FileStorageBackend(config);
}
