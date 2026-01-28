import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import mime from 'mime-types';
import { FileOps, SharedFolderOps } from './database';

interface IndexedFile {
  path: string;
  filename: string;
  hash: string;
  size: number;
  mimeType: string;
  modifiedAt: number;
}

interface ScanProgress {
  folder: string;
  scanned: number;
  total: number;
  currentFile: string;
}

export class FileIndexer extends EventEmitter {
  private isScanning = false;
  private scanQueue: string[] = [];
  private chunkSize = 64 * 1024 * 1024; // 64MB chunks for hashing large files

  constructor() {
    super();
  }

  async scanFolder(folderPath: string): Promise<IndexedFile[]> {
    if (!fs.existsSync(folderPath)) {
      throw new Error(`Folder does not exist: ${folderPath}`);
    }

    const files: IndexedFile[] = [];
    const allFiles = await this.walkDirectory(folderPath);

    this.emit('scan:start', { folder: folderPath, total: allFiles.length });

    let scanned = 0;
    for (const filePath of allFiles) {
      try {
        const indexed = await this.indexFile(filePath);
        if (indexed) {
          files.push(indexed);
          // Save to database
          FileOps.insert(indexed);
        }
      } catch (error) {
        console.error(`Error indexing ${filePath}:`, error);
      }

      scanned++;
      this.emit('scan:progress', {
        folder: folderPath,
        scanned,
        total: allFiles.length,
        currentFile: path.basename(filePath)
      } as ScanProgress);
    }

    // Update folder stats
    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    SharedFolderOps.updateStats(folderPath, files.length, totalSize);

    this.emit('scan:complete', { folder: folderPath, filesCount: files.length, totalSize });

    return files;
  }

  private async walkDirectory(dir: string): Promise<string[]> {
    const files: string[] = [];

    const walk = async (currentPath: string) => {
      try {
        const entries = fs.readdirSync(currentPath, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentPath, entry.name);

          // Skip hidden files and directories
          if (entry.name.startsWith('.')) continue;

          // Skip system directories
          if (['node_modules', '$RECYCLE.BIN', 'System Volume Information'].includes(entry.name)) {
            continue;
          }

          if (entry.isDirectory()) {
            await walk(fullPath);
          } else if (entry.isFile()) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        // Skip directories we can't access
        console.warn(`Cannot access directory: ${currentPath}`);
      }
    };

    await walk(dir);
    return files;
  }

  private async indexFile(filePath: string): Promise<IndexedFile | null> {
    try {
      const stats = fs.statSync(filePath);

      // Skip very small files (less than 1KB)
      if (stats.size < 1024) return null;

      // Skip very large files (more than 100GB)
      if (stats.size > 100 * 1024 * 1024 * 1024) {
        console.warn(`Skipping file larger than 100GB: ${filePath}`);
        return null;
      }

      const hash = await this.hashFile(filePath);
      const mimeType = mime.lookup(filePath) || 'application/octet-stream';

      return {
        path: filePath,
        filename: path.basename(filePath),
        hash,
        size: stats.size,
        mimeType,
        modifiedAt: Math.floor(stats.mtimeMs / 1000)
      };
    } catch (error) {
      console.error(`Error indexing file ${filePath}:`, error);
      return null;
    }
  }

  private hashFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath, { highWaterMark: this.chunkSize });

      stream.on('data', (chunk) => {
        hash.update(chunk);
      });

      stream.on('end', () => {
        resolve(hash.digest('hex'));
      });

      stream.on('error', (error) => {
        reject(error);
      });
    });
  }

  async addFolder(folderPath: string): Promise<void> {
    SharedFolderOps.add(folderPath);
    await this.scanFolder(folderPath);
  }

  async removeFolder(folderPath: string): Promise<void> {
    SharedFolderOps.remove(folderPath);
    // Remove files from this folder from local_files
    const db = require('./database').getDatabase();
    db.prepare('DELETE FROM local_files WHERE path LIKE ?').run(`${folderPath}%`);
  }

  getSharedFolders(): any[] {
    return SharedFolderOps.getAll();
  }

  getAllFiles(): any[] {
    return FileOps.getAll();
  }

  searchFiles(query: string): any[] {
    return FileOps.search(query);
  }

  async rescanAll(): Promise<void> {
    const folders = this.getSharedFolders();
    for (const folder of folders) {
      await this.scanFolder(folder.path);
    }
  }
}

export const fileIndexer = new FileIndexer();
