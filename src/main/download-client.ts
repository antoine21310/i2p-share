import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { app } from 'electron';
import { DownloadOps } from './database';
import type { Download, FileRequest } from '../shared/types';
import type { I2PConnection } from './i2p-connection';

const CHUNK_SIZE = 256 * 1024; // 256KB chunks
const MAX_PARALLEL_CHUNKS = 4;

interface DownloadTask {
  id: number;
  filename: string;
  fileHash: string;
  peerId: string;
  peerName: string;
  totalSize: number;
  downloadedSize: number;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'failed';
  savePath: string;
  chunkMap: boolean[];
  currentChunk: number;
  speed: number;
  startTime: number;
  stream?: fs.WriteStream;
}

export class DownloadClient extends EventEmitter {
  private activeDownloads: Map<number, DownloadTask> = new Map();
  private downloadQueue: number[] = [];
  private maxParallelDownloads = 3;
  private downloadPath: string;
  private messageHandler: ((to: string, message: any) => Promise<Buffer>) | null = null;

  constructor() {
    super();
    this.downloadPath = app?.getPath('downloads') || path.join(process.cwd(), 'downloads');

    // Ensure download directory exists
    if (!fs.existsSync(this.downloadPath)) {
      fs.mkdirSync(this.downloadPath, { recursive: true });
    }
  }

  setMessageHandler(handler: (to: string, message: any) => Promise<Buffer>): void {
    this.messageHandler = handler;
  }

  // Set the I2P connection for file transfers
  setConnection(conn: I2PConnection): void {
    // Create a message handler that sends requests and waits for response
    this.messageHandler = async (to: string, message: any): Promise<Buffer> => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Request timeout'));
        }, 30000);

        // Set up one-time listener for the response
        const onData = ({ from, data }: { from: string; data: Buffer }) => {
          if (from === to) {
            clearTimeout(timeout);
            conn.off('data', onData);
            resolve(data);
          }
        };

        conn.on('data', onData);

        // Send the request
        conn.sendMessage(to, message).catch((err) => {
          clearTimeout(timeout);
          conn.off('data', onData);
          reject(err);
        });
      });
    };
  }

  setDownloadPath(downloadPath: string): void {
    this.downloadPath = downloadPath;
    if (!fs.existsSync(this.downloadPath)) {
      fs.mkdirSync(this.downloadPath, { recursive: true });
    }
  }

  // Add a new download
  async addDownload(
    filename: string,
    fileHash: string,
    peerId: string,
    peerName: string,
    totalSize: number
  ): Promise<number> {
    const savePath = path.join(this.downloadPath, filename);

    // Check if download already exists
    const existing = Array.from(this.activeDownloads.values())
      .find(d => d.fileHash === fileHash);
    if (existing) {
      return existing.id;
    }

    // Create database entry
    const id = DownloadOps.create({
      filename,
      fileHash,
      peerId,
      peerName,
      totalSize,
      savePath
    }) as number;

    const chunksCount = Math.ceil(totalSize / CHUNK_SIZE);
    const chunkMap = new Array(chunksCount).fill(false);

    const task: DownloadTask = {
      id,
      filename,
      fileHash,
      peerId,
      peerName,
      totalSize,
      downloadedSize: 0,
      status: 'pending',
      savePath,
      chunkMap,
      currentChunk: 0,
      speed: 0,
      startTime: 0
    };

    this.activeDownloads.set(id, task);
    this.downloadQueue.push(id);

    this.emit('download:added', {
      id,
      filename,
      totalSize,
      peerId: peerName
    });

    // Try to start download
    this.processQueue();

    return id;
  }

  private processQueue(): void {
    const activeCount = Array.from(this.activeDownloads.values())
      .filter(d => d.status === 'downloading').length;

    while (
      activeCount < this.maxParallelDownloads &&
      this.downloadQueue.length > 0
    ) {
      const id = this.downloadQueue.shift()!;
      const task = this.activeDownloads.get(id);
      if (task && task.status === 'pending') {
        this.startDownload(id);
      }
    }
  }

  private async startDownload(id: number): Promise<void> {
    const task = this.activeDownloads.get(id);
    if (!task) return;

    task.status = 'downloading';
    task.startTime = Date.now();
    DownloadOps.setStatus(id, 'downloading');

    // Create write stream
    const partPath = task.savePath + '.part';
    task.stream = fs.createWriteStream(partPath, { flags: 'a' });

    this.emit('download:started', { id, filename: task.filename });

    try {
      await this.downloadChunks(task);

      // Verify hash
      const isValid = await this.verifyFile(partPath, task.fileHash);

      if (isValid) {
        // Rename to final path
        fs.renameSync(partPath, task.savePath);
        task.status = 'completed';
        DownloadOps.setStatus(id, 'completed');
        this.emit('download:completed', { id, filename: task.filename, path: task.savePath });
      } else {
        throw new Error('File hash mismatch');
      }
    } catch (error: any) {
      console.error(`[Download] Error:`, error);
      task.status = 'failed';
      DownloadOps.setStatus(id, 'failed');
      this.emit('download:failed', { id, filename: task.filename, error: error.message });
    } finally {
      if (task.stream) {
        task.stream.close();
      }
      this.processQueue();
    }
  }

  private async downloadChunks(task: DownloadTask): Promise<void> {
    const chunksCount = task.chunkMap.length;
    let lastSpeedUpdate = Date.now();
    let lastBytes = 0;

    for (let i = task.currentChunk; i < chunksCount; i++) {
      if (task.status !== 'downloading') break;
      if (task.chunkMap[i]) continue;

      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE - 1, task.totalSize - 1);

      const request: FileRequest = {
        type: 'file_request',
        fileHash: task.fileHash,
        range: { start, end }
      };

      try {
        if (!this.messageHandler) {
          throw new Error('No message handler');
        }

        const chunkData = await this.messageHandler(task.peerId, request);

        if (task.stream && chunkData.length > 0) {
          task.stream.write(chunkData);
          task.chunkMap[i] = true;
          task.downloadedSize += chunkData.length;
          task.currentChunk = i + 1;

          // Update progress in database
          DownloadOps.updateProgress(
            task.id,
            task.downloadedSize,
            JSON.stringify(task.chunkMap)
          );

          // Calculate speed
          const now = Date.now();
          if (now - lastSpeedUpdate >= 1000) {
            const bytesDiff = task.downloadedSize - lastBytes;
            const timeDiff = now - lastSpeedUpdate;
            task.speed = Math.round((bytesDiff / timeDiff) * 1000);
            lastSpeedUpdate = now;
            lastBytes = task.downloadedSize;
          }

          this.emit('download:progress', {
            id: task.id,
            downloadedSize: task.downloadedSize,
            totalSize: task.totalSize,
            progress: (task.downloadedSize / task.totalSize) * 100,
            speed: task.speed
          });
        }
      } catch (error: any) {
        console.error(`[Download] Chunk ${i} failed:`, error);
        // Retry logic could be added here
        throw error;
      }
    }
  }

  private async verifyFile(filePath: string, expectedHash: string): Promise<boolean> {
    return new Promise((resolve) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => {
        const actualHash = hash.digest('hex');
        resolve(actualHash === expectedHash);
      });
      stream.on('error', () => resolve(false));
    });
  }

  // Pause a download
  pauseDownload(id: number): boolean {
    const task = this.activeDownloads.get(id);
    if (task && task.status === 'downloading') {
      task.status = 'paused';
      DownloadOps.setStatus(id, 'paused');
      this.emit('download:paused', { id });
      return true;
    }
    return false;
  }

  // Resume a download
  resumeDownload(id: number): boolean {
    const task = this.activeDownloads.get(id);
    if (task && task.status === 'paused') {
      task.status = 'pending';
      this.downloadQueue.push(id);
      this.processQueue();
      this.emit('download:resumed', { id });
      return true;
    }
    return false;
  }

  // Cancel a download
  cancelDownload(id: number): boolean {
    const task = this.activeDownloads.get(id);
    if (task) {
      task.status = 'failed';
      if (task.stream) {
        task.stream.close();
      }

      // Clean up partial file
      const partPath = task.savePath + '.part';
      if (fs.existsSync(partPath)) {
        fs.unlinkSync(partPath);
      }

      this.activeDownloads.delete(id);
      DownloadOps.delete(id);
      this.emit('download:cancelled', { id });
      return true;
    }
    return false;
  }

  // Get all downloads
  getDownloads(): Download[] {
    const dbDownloads = DownloadOps.getAll() as any[];

    return dbDownloads.map(d => {
      const active = this.activeDownloads.get(d.id);
      return {
        id: d.id,
        filename: d.filename,
        fileHash: d.fileHash,
        peerId: d.peerId,
        peerName: d.peerName || 'Unknown',
        totalSize: d.totalSize,
        downloadedSize: active?.downloadedSize || d.downloadedSize,
        status: active?.status || d.status,
        createdAt: d.createdAt,
        startedAt: d.startedAt,
        completedAt: d.completedAt,
        progress: ((active?.downloadedSize || d.downloadedSize) / d.totalSize) * 100,
        speed: active?.speed || 0
      };
    });
  }

  // Get active downloads
  getActiveDownloads(): DownloadTask[] {
    return Array.from(this.activeDownloads.values())
      .filter(d => d.status === 'downloading');
  }

  // Load pending downloads from database
  loadFromDatabase(): void {
    const pending = DownloadOps.getActive() as any[];
    for (const d of pending) {
      const chunksCount = Math.ceil(d.totalSize / CHUNK_SIZE);
      let chunkMap = new Array(chunksCount).fill(false);

      if (d.chunkMap) {
        try {
          chunkMap = JSON.parse(d.chunkMap);
        } catch (e) {
          // Invalid chunk map, start fresh
        }
      }

      const currentChunk = chunkMap.findIndex((c: boolean) => !c);

      const task: DownloadTask = {
        id: d.id,
        filename: d.filename,
        fileHash: d.fileHash,
        peerId: d.peerId,
        peerName: d.peerName,
        totalSize: d.totalSize,
        downloadedSize: d.downloadedSize,
        status: 'pending',
        savePath: d.savePath,
        chunkMap,
        currentChunk: currentChunk >= 0 ? currentChunk : chunksCount,
        speed: 0,
        startTime: 0
      };

      this.activeDownloads.set(d.id, task);
      this.downloadQueue.push(d.id);
    }

    console.log(`[Download] Loaded ${pending.length} pending downloads`);
  }
}

export const downloadClient = new DownloadClient();
