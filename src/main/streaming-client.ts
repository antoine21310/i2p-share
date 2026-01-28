import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { createStream, I2pSamStream } from '@diva.exchange/i2p-sam';
import { app } from 'electron';
import { DownloadOps } from './database';
import type { Download } from '../shared/types';

// Protocol message types (must match streaming-server.ts)
const MSG_FILE_REQUEST = 0x01;
const MSG_FILE_HEADER = 0x02;
const MSG_FILE_CHUNK = 0x03;
const MSG_FILE_COMPLETE = 0x04;
const MSG_FILE_ERROR = 0x05;

// Chunk size for progress tracking
const PROGRESS_CHUNK_SIZE = 256 * 1024; // 256KB for progress updates

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
}

interface StreamingClientConfig {
  samHost: string;
  samPortTCP: number;
  downloadPath: string;
  maxParallelDownloads: number;
  connectionTimeout: number;
}

export class StreamingClient extends EventEmitter {
  private config: StreamingClientConfig;
  private activeDownloads: Map<number, StreamDownload> = new Map();
  private downloadQueue: number[] = [];
  private isInitialized: boolean = false;

  constructor(config: Partial<StreamingClientConfig> = {}) {
    super();
    const downloadPath = app?.getPath('downloads') || path.join(process.cwd(), 'downloads');

    this.config = {
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      downloadPath: config.downloadPath || downloadPath,
      maxParallelDownloads: config.maxParallelDownloads || 3,
      connectionTimeout: config.connectionTimeout || 120000 // 2 minutes for I2P
    };

    // Ensure download directory exists
    if (!fs.existsSync(this.config.downloadPath)) {
      fs.mkdirSync(this.config.downloadPath, { recursive: true });
    }

    this.isInitialized = true;
  }

  setDownloadPath(downloadPath: string): void {
    this.config.downloadPath = downloadPath;
    if (!fs.existsSync(this.config.downloadPath)) {
      fs.mkdirSync(this.config.downloadPath, { recursive: true });
    }
  }

  async addDownload(
    filename: string,
    fileHash: string,
    peerId: string,
    peerName: string,
    totalSize: number
  ): Promise<number> {
    const savePath = path.join(this.config.downloadPath, filename);

    // Check if download already exists
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
      console.log(`[StreamingClient] Resuming download ${id}, already downloaded: ${downloadedSize}`);
    } else {
      // Create new database entry
      id = DownloadOps.create({
        filename,
        fileHash,
        peerId,
        peerName,
        totalSize,
        savePath
      }) as number;
    }

    const download: StreamDownload = {
      id,
      filename,
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
      startTime: 0
    };

    this.activeDownloads.set(id, download);
    this.downloadQueue.push(id);

    this.emit('download:added', {
      id,
      filename,
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

  private async startDownload(id: number): Promise<void> {
    const download = this.activeDownloads.get(id);
    if (!download) return;

    download.status = 'connecting';
    download.startTime = Date.now();
    DownloadOps.setStatus(id, 'downloading');

    console.log(`[StreamingClient] Starting download ${id}: ${download.filename}`);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let buffer: any = inputBuffer;
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

    download.status = 'failed';
    download.lastError = errorMessage;
    download.stream = null;
    download.writeStream = null;

    // Don't delete from activeDownloads yet - allow resume
    DownloadOps.setStatus(id, 'paused'); // Use 'paused' so it can be resumed

    this.emit('download:failed', {
      id,
      filename: download.filename,
      error: errorMessage
    });

    this.processQueue();
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
    if (download && (download.status === 'downloading' || download.status === 'connecting')) {
      // Save current progress
      DownloadOps.updateProgress(id, download.downloadedSize);

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
        speed: active?.speed || 0
      };
    });
  }

  getActiveDownloads(): StreamDownload[] {
    return Array.from(this.activeDownloads.values())
      .filter(d => d.status === 'downloading' || d.status === 'connecting');
  }

  // Load pending/paused downloads from database on startup
  loadFromDatabase(): void {
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
        status: 'pending',
        savePath: d.savePath,
        stream: null,
        writeStream: null,
        speed: 0,
        startTime: 0
      };

      this.activeDownloads.set(d.id, download);
      this.downloadQueue.push(d.id);
    }

    console.log(`[StreamingClient] Loaded ${pending.length} pending downloads`);
  }
}

export const streamingClient = new StreamingClient();
