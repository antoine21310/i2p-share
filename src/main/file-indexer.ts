import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import mime from 'mime-types';
import path from 'path';
import { calculatePieceLength } from '../shared/torrent-types.js';
import { FileOps, SharedFolderOps, getDatabase } from './database.js';

interface IndexedFile {
  path: string;
  filename: string;
  hash: string;        // SHA256 content hash (legacy)
  infoHash: string;    // SHA1 of torrent info dict (BitTorrent compatible)
  size: number;
  mimeType: string;
  modifiedAt: number;
  pieceLength: number; // Piece size for BitTorrent
  pieces: string;      // Concatenated SHA1 hashes of all pieces (hex)
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

      // Calculate piece length based on file size (BitTorrent standard)
      const pieceLength = calculatePieceLength(stats.size);

      // Compute piece hashes (SHA1 for BitTorrent compatibility)
      const pieceHashes = await this.computePieceHashes(filePath, pieceLength);
      const pieces = pieceHashes.join('');

      // Compute infoHash (SHA1 of a simplified info dict)
      // This is a simplified version - for full compatibility, use torrent-file.ts
      const infoHash = this.computeInfoHash(path.basename(filePath), stats.size, pieceLength, pieces);

      return {
        path: filePath,
        filename: path.basename(filePath),
        hash,
        infoHash,
        size: stats.size,
        mimeType,
        modifiedAt: Math.floor(stats.mtimeMs / 1000),
        pieceLength,
        pieces
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

  /**
   * Compute SHA1 hashes for each piece of a file (BitTorrent standard)
   */
  private computePieceHashes(filePath: string, pieceLength: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const hashes: string[] = [];
      const stream = fs.createReadStream(filePath, { highWaterMark: pieceLength });

      let currentPieceData = Buffer.alloc(0);

      stream.on('data', (chunk: string | Buffer) => {
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        currentPieceData = Buffer.concat([currentPieceData, data]);

        while (currentPieceData.length >= pieceLength) {
          const pieceData = currentPieceData.slice(0, pieceLength);
          currentPieceData = currentPieceData.slice(pieceLength);

          const pieceHash = crypto.createHash('sha1').update(pieceData).digest('hex');
          hashes.push(pieceHash);
        }
      });

      stream.on('end', () => {
        // Handle last piece (may be smaller)
        if (currentPieceData.length > 0) {
          const pieceHash = crypto.createHash('sha1').update(currentPieceData).digest('hex');
          hashes.push(pieceHash);
        }
        resolve(hashes);
      });

      stream.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Compute a simplified infoHash for the file
   * This creates a deterministic identifier based on file properties
   * For full BitTorrent compatibility, use TorrentFileUtils.createFromPath
   */
  private computeInfoHash(filename: string, size: number, pieceLength: number, pieces: string): string {
    // Create a simplified info dict representation
    // Note: This is NOT a standard torrent info dict, but provides a unique identifier
    const infoData = {
      name: filename,
      length: size,
      'piece length': pieceLength,
      pieces: pieces.substring(0, 1000) // Use first 1000 chars of pieces for uniqueness
    };

    // Hash the JSON representation to get a consistent infoHash
    const infoJson = JSON.stringify(infoData);
    return crypto.createHash('sha1').update(infoJson).digest('hex');
  }

  async addFolder(folderPath: string): Promise<void> {
    SharedFolderOps.add(folderPath);
    await this.scanFolder(folderPath);
  }

  async removeFolder(folderPath: string): Promise<void> {
    SharedFolderOps.remove(folderPath);
    // Remove files from this folder from local_files
    const db = getDatabase();
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
