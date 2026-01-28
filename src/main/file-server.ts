import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { FileOps } from './database';
import type { FileRequest } from '../shared/types';
import type { I2PConnection } from './i2p-connection';

interface UploadSession {
  peerId: string;
  fileHash: string;
  filename: string;
  startTime: number;
  bytesSent: number;
  speed: number;
}

export class FileServer extends EventEmitter {
  private activeSessions: Map<string, UploadSession> = new Map();
  private maxUploadSlots: number = 10;
  private maxBandwidth: number = 5 * 1024 * 1024; // 5 MB/s
  private messageHandler: ((to: string, data: Buffer) => void) | null = null;
  private connection: I2PConnection | null = null;

  constructor() {
    super();
  }

  // Set the I2P connection to use for sending data
  setConnection(conn: I2PConnection): void {
    this.connection = conn;
    this.messageHandler = (to, data) => {
      conn.sendData(to, data);
    };

    // Listen for incoming file requests
    conn.on('message', ({ from, message }) => {
      if (message.type === 'file_request') {
        this.handleFileRequest(from, message);
      }
    });
  }

  setMessageHandler(handler: (to: string, data: Buffer) => void): void {
    this.messageHandler = handler;
  }

  setMaxUploadSlots(slots: number): void {
    this.maxUploadSlots = slots;
  }

  setMaxBandwidth(bytesPerSecond: number): void {
    this.maxBandwidth = bytesPerSecond;
  }

  // Handle incoming file request
  async handleFileRequest(peerId: string, request: FileRequest): Promise<void> {
    const { fileHash, range } = request;

    // Check if we have slots available
    if (this.activeSessions.size >= this.maxUploadSlots) {
      this.sendError(peerId, 'Server busy - no upload slots available');
      return;
    }

    // Find the file
    const file = FileOps.getByHash(fileHash) as any;
    if (!file) {
      this.sendError(peerId, 'File not found');
      return;
    }

    // Validate range
    const fileStats = fs.statSync(file.path);
    const start = range.start;
    const end = Math.min(range.end, fileStats.size - 1);

    if (start < 0 || start >= fileStats.size || start > end) {
      this.sendError(peerId, 'Invalid range');
      return;
    }

    // Create session
    const sessionId = `${peerId}:${fileHash}:${Date.now()}`;
    const session: UploadSession = {
      peerId,
      fileHash,
      filename: file.filename,
      startTime: Date.now(),
      bytesSent: 0,
      speed: 0
    };
    this.activeSessions.set(sessionId, session);

    this.emit('upload:start', {
      sessionId,
      peerId,
      filename: file.filename,
      size: end - start + 1
    });

    try {
      await this.streamFile(peerId, file.path, start, end, session, sessionId);
    } catch (error: any) {
      console.error(`[FileServer] Error streaming file:`, error);
      this.sendError(peerId, `Error: ${error.message}`);
    } finally {
      this.activeSessions.delete(sessionId);
      this.emit('upload:complete', { sessionId });
    }
  }

  private async streamFile(
    peerId: string,
    filePath: string,
    start: number,
    end: number,
    session: UploadSession,
    sessionId: string
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const chunkSize = 64 * 1024; // 64KB chunks
      const stream = fs.createReadStream(filePath, {
        start,
        end,
        highWaterMark: chunkSize
      });

      let lastTime = Date.now();
      let lastBytes = 0;
      let chunkIndex = 0;

      stream.on('data', (chunk) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (!this.connection) {
          stream.destroy();
          reject(new Error('No connection'));
          return;
        }

        // Send chunk as JSON message with base64-encoded data
        // This ensures the _from field is included for proper routing
        const response = {
          type: 'file_chunk',
          fileHash: session.fileHash,
          chunkIndex: chunkIndex++,
          data: chunkBuffer.toString('base64'),
          offset: start + session.bytesSent,
          size: chunkBuffer.length
        };

        this.connection.sendMessage(peerId, response);
        session.bytesSent += chunkBuffer.length;

        // Calculate speed
        const now = Date.now();
        const timeDiff = now - lastTime;
        if (timeDiff >= 1000) {
          const bytesDiff = session.bytesSent - lastBytes;
          session.speed = Math.round((bytesDiff / timeDiff) * 1000);
          lastTime = now;
          lastBytes = session.bytesSent;

          this.emit('upload:progress', {
            sessionId,
            bytesSent: session.bytesSent,
            speed: session.speed
          });
        }

        // Bandwidth throttling
        if (this.maxBandwidth > 0) {
          const expectedTime = (session.bytesSent / this.maxBandwidth) * 1000;
          const actualTime = Date.now() - session.startTime;
          if (actualTime < expectedTime) {
            stream.pause();
            setTimeout(() => stream.resume(), expectedTime - actualTime);
          }
        }
      });

      stream.on('end', () => {
        // Send completion message
        if (this.connection) {
          this.connection.sendMessage(peerId, {
            type: 'file_complete',
            fileHash: session.fileHash,
            totalSize: session.bytesSent
          });
        }
        resolve();
      });

      stream.on('error', (error) => {
        reject(error);
      });
    });
  }

  private sendError(peerId: string, errorMessage: string): void {
    if (this.connection) {
      this.connection.sendMessage(peerId, {
        type: 'file_error',
        error: errorMessage
      });
    }
  }

  // Get active uploads info
  getActiveUploads(): UploadSession[] {
    return Array.from(this.activeSessions.values());
  }

  // Get upload stats
  getStats(): { activeUploads: number; totalSpeed: number } {
    const uploads = this.getActiveUploads();
    return {
      activeUploads: uploads.length,
      totalSpeed: uploads.reduce((sum, u) => sum + u.speed, 0)
    };
  }

  // Cancel an upload
  cancelUpload(sessionId: string): boolean {
    if (this.activeSessions.has(sessionId)) {
      this.activeSessions.delete(sessionId);
      this.emit('upload:cancelled', { sessionId });
      return true;
    }
    return false;
  }
}

export const fileServer = new FileServer();
