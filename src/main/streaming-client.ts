import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { createStream, I2pSamStream } from '@diva.exchange/i2p-sam';
import { app } from 'electron';
import { DownloadOps } from './database';
import type { Download } from '../shared/types';
import {
  CONSTANTS,
  MSG_FILE_REQUEST,
  MSG_FILE_HEADER,
  MSG_FILE_CHUNK,
  MSG_FILE_COMPLETE,
  MSG_FILE_ERROR
} from '../shared/types';

// Chunk size for progress tracking
const PROGRESS_CHUNK_SIZE = CONSTANTS.PROGRESS_CHUNK_SIZE;

interface StreamDownload {
  id: number;
  filename: string;
  fileHash: string;
  peerId: string;
  peerName: string;
  totalSize: number;
  downloadedSize: number;
  status: 'pending' | 'connecting' | 'downloading' | 'paused' | 'completed' | 'failed';
  savePath: string;
  stream: I2pSamStream | null;
  writeStream: fs.WriteStream | null;
  speed: number;
  startTime: number;
  lastError?: string;
  retryCount: number;
  retryTimeout?: NodeJS.Timeout;
}

interface StreamingClientConfig {
  samHost: string;
  samPortTCP: number;
  downloadPath: string;
  maxParallelDownloads: number;
  connectionTimeout: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  minFreeSpaceBytes: number;
  autoResumeOnStart: boolean;
}

export class StreamingClient extends EventEmitter {
  private config: StreamingClientConfig;
  private activeDownloads: Map<number, StreamDownload> = new Map();
  private downloadQueue: number[] = [];
  private isInitialized: boolean = false;
  private peerDestinationMap: Map<string, string> = new Map(); // b32 -> full destination

  constructor(config: Partial<StreamingClientConfig> = {}) {
    super();
    const downloadPath = app?.getPath('downloads') || path.join(process.cwd(), 'downloads');

    this.config = {
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      downloadPath: config.downloadPath || downloadPath,
      maxParallelDownloads: config.maxParallelDownloads || CONSTANTS.MAX_PARALLEL_DOWNLOADS,
      connectionTimeout: config.connectionTimeout || CONSTANTS.CONNECTION_TIMEOUT,
      maxRetries: config.maxRetries || CONSTANTS.MAX_RETRIES,
      retryBaseDelayMs: config.retryBaseDelayMs || CONSTANTS.RETRY_BASE_DELAY,
      retryMaxDelayMs: config.retryMaxDelayMs || CONSTANTS.RETRY_MAX_DELAY,
      minFreeSpaceBytes: config.minFreeSpaceBytes || CONSTANTS.MIN_FREE_SPACE_BYTES,
      autoResumeOnStart: config.autoResumeOnStart ?? true
    };

    // Ensure download directory exists
    if (!fs.existsSync(this.config.downloadPath)) {
      fs.mkdirSync(this.config.downloadPath, { recursive: true });
    }

    this.isInitialized = true;
  }

  /**
   * Update peer destination mapping (for handling reconnections)
   */
  updatePeerDestination(b32Address: string, newDestination: string): void {
    this.peerDestinationMap.set(b32Address, newDestination);

    // Update any active downloads that use this peer
    for (const download of this.activeDownloads.values()) {
      const downloadB32 = this.getB32FromDestination(download.peerId);
      if (downloadB32 === b32Address && download.peerId !== newDestination) {
        console.log(`[StreamingClient] Updating peer destination for download ${download.id}`);
        download.peerId = newDestination;
        // Update in database too
        DownloadOps.updatePeerId(download.id, newDestination);
      }
    }
  }

  private getB32FromDestination(dest: string): string {
    // First 52 chars of base64 destination form a unique-ish identifier
    return dest.substring(0, 52);
  }

  setDownloadPath(downloadPath: string): void {
    this.config.downloadPath = downloadPath;
    if (!fs.existsSync(this.config.downloadPath)) {
      fs.mkdirSync(this.config.downloadPath, { recursive: true });
    }
  }

  /**
   * Check available disk space (Windows compatible)
   */
  private async checkDiskSpace(requiredBytes: number): Promise<{ enough: boolean; available: number }> {
    return new Promise((resolve) => {
      try {
        if (process.platform === 'win32') {
          const { exec } = require('child_process');
          const drive = path.parse(this.config.downloadPath).root || 'C:\\';
          const driveLetter = drive.charAt(0).toUpperCase();

          exec(`wmic logicaldisk where "DeviceID='${driveLetter}:'" get FreeSpace /format:value`,
            (error: any, stdout: string) => {
              if (error) {
                // If we can't check, assume we have space
                resolve({ enough: true, available: Infinity });
                return;
              }
              const match = stdout.match(/FreeSpace=(\d+)/);
              const available = match ? parseInt(match[1], 10) : Infinity;
              const totalRequired = requiredBytes + this.config.minFreeSpaceBytes;
              resolve({ enough: available >= totalRequired, available });
            }
          );
        } else {
          // Unix/Mac - use statfs
          fs.statfs(this.config.downloadPath, (err, stats) => {
            if (err) {
              resolve({ enough: true, available: Infinity });
              return;
            }
            const available = stats.bavail * stats.bsize;
            const totalRequired = requiredBytes + this.config.minFreeSpaceBytes;
            resolve({ enough: available >= totalRequired, available });
          });
        }
      } catch {
        resolve({ enough: true, available: Infinity });
      }
    });
  }

  /**
   * Sanitize filename to prevent path traversal
   */
  private sanitizeFilename(filename: string): string {
    if (!filename) return 'unnamed';
    let safe = path.basename(filename);
    safe = safe.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    if (safe.startsWith('.')) {
      safe = '_' + safe.substring(1);
    }
    if (safe.length > 255) {
      const ext = path.extname(safe);
      const name = path.basename(safe, ext);
      safe = name.substring(0, 255 - ext.length) + ext;
    }
    return safe || 'unnamed';
  }

  async addDownload(
    filename: string,
    fileHash: string,
    peerId: string,
    peerName: string,
    totalSize: number
  ): Promise<number> {
    // Sanitize filename
    const safeFilename = this.sanitizeFilename(filename);
    const savePath = path.join(this.config.downloadPath, safeFilename);

    // Check disk space
    const diskCheck = await this.checkDiskSpace(totalSize);
    if (!diskCheck.enough) {
      const availableMB = Math.round(diskCheck.available / (1024 * 1024));
      const requiredMB = Math.round((totalSize + this.config.minFreeSpaceBytes) / (1024 * 1024));
      throw new Error(`Not enough disk space. Available: ${availableMB}MB, Required: ${requiredMB}MB`);
    }

    // Check if download already exists in memory
    const existing = Array.from(this.activeDownloads.values())
      .find(d => d.fileHash === fileHash);
    if (existing) {
      return existing.id;
    }

    // Check if there's a paused/pending download in database
    const allDownloads = DownloadOps.getAll() as any[];
    const dbDownload = allDownloads.find(d => d.fileHash === fileHash && d.status !== 'completed');

    let id: number;
    let downloadedSize = 0;

    if (dbDownload) {
      // Resume existing download
      id = dbDownload.id;
      downloadedSize = dbDownload.downloadedSize || 0;
      // Update peerId in case it changed (peer reconnected)
      DownloadOps.updatePeerId(id, peerId);
      console.log(`[StreamingClient] Resuming download ${id}, already downloaded: ${downloadedSize}`);
    } else {
      // Create new database entry
      id = DownloadOps.create({
        filename: safeFilename,
        fileHash,
        peerId,
        peerName,
        totalSize,
        savePath
      }) as number;
    }

    const download: StreamDownload = {
      id,
      filename: safeFilename,
      fileHash,
      peerId,
      peerName,
      totalSize,
      downloadedSize,
      status: 'pending',
      savePath,
      stream: null,
      writeStream: null,
      speed: 0,
      startTime: 0,
      retryCount: 0
    };

    this.activeDownloads.set(id, download);
    this.downloadQueue.push(id);

    this.emit('download:added', {
      id,
      filename: safeFilename,
      totalSize,
      peerName
    });

    // Try to start download
    this.processQueue();

    return id;
  }

  private async processQueue(): Promise<void> {
    const activeCount = Array.from(this.activeDownloads.values())
      .filter(d => d.status === 'connecting' || d.status === 'downloading').length;

    while (
      activeCount < this.config.maxParallelDownloads &&
      this.downloadQueue.length > 0
    ) {
      const id = this.downloadQueue.shift()!;
      const download = this.activeDownloads.get(id);
      if (download && download.status === 'pending') {
        this.startDownload(id);
      }
    }
  }

  /**
   * Calculate exponential backoff delay with jitter
   */
  private calculateBackoff(attempt: number): number {
    const delay = Math.min(
      this.config.retryBaseDelayMs * Math.pow(2, attempt),
      this.config.retryMaxDelayMs
    );
    // Add jitter (±20%)
    const jitter = delay * 0.2 * (Math.random() - 0.5);
    return Math.round(delay + jitter);
  }

  private async startDownload(id: number): Promise<void> {
    const download = this.activeDownloads.get(id);
    if (!download) return;

    download.status = 'connecting';
    download.startTime = Date.now();
    DownloadOps.setStatus(id, 'downloading');

    console.log(`[StreamingClient] Starting download ${id}: ${download.filename} (attempt ${download.retryCount + 1})`);
    console.log(`[StreamingClient] Connecting to peer: ${download.peerId.substring(0, 30)}...`);

    this.emit('download:started', { id, filename: download.filename });

    try {
      // Create streaming connection to peer
      const samStream = await createStream({
        sam: {
          host: this.config.samHost,
          portTCP: this.config.samPortTCP,
          timeout: Math.floor(this.config.connectionTimeout / 1000)
        },
        stream: {
          destination: download.peerId
        }
      });

      download.stream = samStream;
      download.retryCount = 0; // Reset retry count on successful connection
      console.log(`[StreamingClient] Connected to peer for download ${id}`);

      // Set up data handler
      let buffer: Buffer = Buffer.alloc(0);
      let headerReceived = false;

      samStream.on('data', (data: Buffer) => {
        buffer = Buffer.concat([buffer, data]);
        buffer = this.processIncomingData(download, buffer, headerReceived, () => {
          headerReceived = true;
        });
      });

      samStream.on('error', (error: Error) => {
        console.error(`[StreamingClient] Stream error for ${id}:`, error.message);
        this.handleDownloadError(id, error.message);
      });

      samStream.on('close', () => {
        console.log(`[StreamingClient] Stream closed for ${id}`);
        if (download.status === 'downloading') {
          // Unexpected close, mark as failed (can be resumed)
          this.handleDownloadError(id, 'Connection closed unexpectedly');
        }
      });

      // Open write stream for file (append mode for resume)
      const partPath = download.savePath + '.part';
      download.writeStream = fs.createWriteStream(partPath, {
        flags: download.downloadedSize > 0 ? 'r+' : 'w',
        start: download.downloadedSize
      });

      // Send file request
      const request = JSON.stringify({
        fileHash: download.fileHash,
        startOffset: download.downloadedSize
      });
      const requestBuf = Buffer.from(request, 'utf8');
      const requestMsg = Buffer.alloc(1 + requestBuf.length);
      requestMsg[0] = MSG_FILE_REQUEST;
      requestBuf.copy(requestMsg, 1);

      samStream.stream(requestMsg);
      console.log(`[StreamingClient] Sent file request for ${download.fileHash.substring(0, 16)}...`);

    } catch (error: any) {
      console.error(`[StreamingClient] Failed to connect for download ${id}:`, error.message);
      this.handleDownloadError(id, error.message);
    }
  }

  private processIncomingData(
    download: StreamDownload,
    inputBuffer: Buffer,
    headerReceived: boolean,
    onHeaderReceived: () => void
  ): Buffer {
    let buffer: Buffer = inputBuffer;
    while (buffer.length > 0) {
      const msgType = buffer[0];

      switch (msgType) {
        case MSG_FILE_HEADER: {
          if (buffer.length < 5) return buffer; // Need more data
          const headerLen = buffer.readUInt32BE(1);
          if (buffer.length < 5 + headerLen) return buffer;

          const headerJson = buffer.slice(5, 5 + headerLen).toString('utf8');
          const header = JSON.parse(headerJson);
          console.log(`[StreamingClient] Received header:`, header);

          download.status = 'downloading';
          download.totalSize = header.totalSize;
          onHeaderReceived();

          buffer = buffer.slice(5 + headerLen);
          break;
        }

        case MSG_FILE_CHUNK: {
          if (buffer.length < 13) return buffer; // Need more data (1 + 4 + 8)
          const chunkLen = buffer.readUInt32BE(1);
          const offset = Number(buffer.readBigUInt64BE(5));
          if (buffer.length < 13 + chunkLen) return buffer;

          const chunkData = buffer.slice(13, 13 + chunkLen);

          // Write to file
          if (download.writeStream) {
            download.writeStream.write(chunkData);
          }

          download.downloadedSize = offset + chunkLen;

          // Calculate speed
          const elapsed = Date.now() - download.startTime;
          if (elapsed > 0) {
            download.speed = Math.round((download.downloadedSize / elapsed) * 1000);
          }

          // Update progress periodically (not every chunk)
          if (download.downloadedSize % PROGRESS_CHUNK_SIZE < chunkLen) {
            DownloadOps.updateProgress(download.id, download.downloadedSize);

            this.emit('download:progress', {
              id: download.id,
              downloadedSize: download.downloadedSize,
              totalSize: download.totalSize,
              progress: (download.downloadedSize / download.totalSize) * 100,
              speed: download.speed
            });
          }

          buffer = buffer.slice(13 + chunkLen);
          break;
        }

        case MSG_FILE_COMPLETE: {
          if (buffer.length < 9) return buffer;
          const finalSize = Number(buffer.readBigUInt64BE(1));
          console.log(`[StreamingClient] Download complete: ${finalSize} bytes`);

          this.completeDownload(download.id);
          buffer = buffer.slice(9);
          break;
        }

        case MSG_FILE_ERROR: {
          if (buffer.length < 5) return buffer;
          const errLen = buffer.readUInt32BE(1);
          if (buffer.length < 5 + errLen) return buffer;

          const errorMsg = buffer.slice(5, 5 + errLen).toString('utf8');
          console.error(`[StreamingClient] Server error: ${errorMsg}`);
          this.handleDownloadError(download.id, errorMsg);

          buffer = buffer.slice(5 + errLen);
          break;
        }

        default:
          console.warn(`[StreamingClient] Unknown message type: ${msgType}`);
          // Skip one byte and try again
          buffer = buffer.slice(1);
      }
    }

    return buffer;
  }

  private async completeDownload(id: number): Promise<void> {
    const download = this.activeDownloads.get(id);
    if (!download) return;

    // Close streams
    if (download.writeStream) {
      download.writeStream.close();
    }
    if (download.stream) {
      download.stream.close();
    }

    // Clear any retry timeout
    if (download.retryTimeout) {
      clearTimeout(download.retryTimeout);
    }

    // Verify file hash
    const partPath = download.savePath + '.part';
    const isValid = await this.verifyFile(partPath, download.fileHash);

    if (isValid) {
      // Rename to final path
      fs.renameSync(partPath, download.savePath);
      download.status = 'completed';
      DownloadOps.setStatus(id, 'completed');

      console.log(`[StreamingClient] Download verified and completed: ${download.filename}`);
      this.emit('download:completed', {
        id,
        filename: download.filename,
        path: download.savePath
      });
    } else {
      console.error(`[StreamingClient] Hash mismatch for ${download.filename}`);
      download.status = 'failed';
      download.lastError = 'File hash mismatch';
      DownloadOps.setStatus(id, 'failed');

      this.emit('download:failed', {
        id,
        filename: download.filename,
        error: 'File hash mismatch - download corrupted'
      });
    }

    this.activeDownloads.delete(id);
    this.processQueue();
  }

  private handleDownloadError(id: number, errorMessage: string): void {
    const download = this.activeDownloads.get(id);
    if (!download) return;

    // Save progress before marking as failed
    DownloadOps.updateProgress(download.id, download.downloadedSize);

    // Close streams
    if (download.writeStream) {
      download.writeStream.close();
    }
    if (download.stream) {
      try {
        download.stream.close();
      } catch (e) {}
    }

    download.stream = null;
    download.writeStream = null;
    download.lastError = errorMessage;

    // Check if we should retry
    if (download.retryCount < this.config.maxRetries) {
      download.retryCount++;
      const delay = this.calculateBackoff(download.retryCount);

      console.log(`[StreamingClient] Scheduling retry ${download.retryCount}/${this.config.maxRetries} for download ${id} in ${delay}ms`);

      download.status = 'pending';
      download.retryTimeout = setTimeout(() => {
        if (download.status === 'pending') {
          this.startDownload(id);
        }
      }, delay);

      this.emit('download:retrying', {
        id,
        filename: download.filename,
        attempt: download.retryCount,
        maxRetries: this.config.maxRetries,
        nextRetryMs: delay
      });
    } else {
      // Max retries reached, mark as failed
      download.status = 'failed';
      DownloadOps.setStatus(id, 'paused'); // Use 'paused' so it can be manually resumed

      this.emit('download:failed', {
        id,
        filename: download.filename,
        error: errorMessage
      });

      this.processQueue();
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

  pauseDownload(id: number): boolean {
    const download = this.activeDownloads.get(id);
    if (download && (download.status === 'downloading' || download.status === 'connecting' || download.status === 'pending')) {
      // Save current progress
      DownloadOps.updateProgress(id, download.downloadedSize);

      // Clear retry timeout if any
      if (download.retryTimeout) {
        clearTimeout(download.retryTimeout);
      }

      // Close streams
      if (download.stream) {
        try {
          download.stream.close();
        } catch (e) {}
      }
      if (download.writeStream) {
        download.writeStream.close();
      }

      download.status = 'paused';
      download.stream = null;
      download.writeStream = null;
      DownloadOps.setStatus(id, 'paused');

      this.emit('download:paused', { id });
      console.log(`[StreamingClient] Paused download ${id} at ${download.downloadedSize} bytes`);
      return true;
    }
    return false;
  }

  resumeDownload(id: number): boolean {
    const download = this.activeDownloads.get(id);
    if (download && (download.status === 'paused' || download.status === 'failed')) {
      download.status = 'pending';
      download.retryCount = 0; // Reset retry count for manual resume
      this.downloadQueue.push(id);
      this.processQueue();

      this.emit('download:resumed', { id });
      console.log(`[StreamingClient] Resuming download ${id} from ${download.downloadedSize} bytes`);
      return true;
    }
    return false;
  }

  cancelDownload(id: number): boolean {
    const download = this.activeDownloads.get(id);
    if (download) {
      // Clear retry timeout
      if (download.retryTimeout) {
        clearTimeout(download.retryTimeout);
      }

      // Close streams
      if (download.stream) {
        try {
          download.stream.close();
        } catch (e) {}
      }
      if (download.writeStream) {
        download.writeStream.close();
      }

      // Clean up partial file
      const partPath = download.savePath + '.part';
      if (fs.existsSync(partPath)) {
        fs.unlinkSync(partPath);
      }

      this.activeDownloads.delete(id);
      DownloadOps.delete(id);

      this.emit('download:cancelled', { id });
      console.log(`[StreamingClient] Cancelled download ${id}`);
      return true;
    }
    return false;
  }

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
        speed: active?.speed || 0,
        error: active?.lastError,
        retryCount: active?.retryCount
      };
    });
  }

  getActiveDownloads(): StreamDownload[] {
    return Array.from(this.activeDownloads.values())
      .filter(d => d.status === 'downloading' || d.status === 'connecting');
  }

  /**
   * Load pending/paused downloads from database on startup
   * @param autoResume If true, automatically start pending downloads
   */
  loadFromDatabase(autoResume: boolean = false): void {
    const pending = DownloadOps.getActive() as any[];
    for (const d of pending) {
      if (this.activeDownloads.has(d.id)) continue;

      const download: StreamDownload = {
        id: d.id,
        filename: d.filename,
        fileHash: d.fileHash,
        peerId: d.peerId,
        peerName: d.peerName,
        totalSize: d.totalSize,
        downloadedSize: d.downloadedSize || 0,
        status: autoResume ? 'pending' : 'paused',
        savePath: d.savePath,
        stream: null,
        writeStream: null,
        speed: 0,
        startTime: 0,
        retryCount: 0
      };

      this.activeDownloads.set(d.id, download);

      if (autoResume) {
        this.downloadQueue.push(d.id);
      }
    }

    console.log(`[StreamingClient] Loaded ${pending.length} pending downloads (autoResume: ${autoResume})`);

    if (autoResume && pending.length > 0) {
      // Start processing queue after a short delay to let I2P stabilize
      setTimeout(() => {
        this.processQueue();
      }, 2000);
    }
  }

  /**
   * Cleanup all resources (call on app shutdown)
   */
  cleanup(): void {
    console.log('[StreamingClient] Cleaning up...');

    // Clear all retry timeouts
    for (const download of this.activeDownloads.values()) {
      if (download.retryTimeout) {
        clearTimeout(download.retryTimeout);
      }
      if (download.stream) {
        try {
          download.stream.close();
        } catch (e) {}
      }
      if (download.writeStream) {
        try {
          download.writeStream.close();
        } catch (e) {}
      }
      // Save progress
      DownloadOps.updateProgress(download.id, download.downloadedSize);
    }

    this.activeDownloads.clear();
    this.downloadQueue = [];
    this.removeAllListeners();
  }
}

export const streamingClient = new StreamingClient();
