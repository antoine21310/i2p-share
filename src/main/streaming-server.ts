import fs from 'fs';
import net from 'net';
import { EventEmitter } from 'events';
import { createForward, I2pSamStream } from '@diva.exchange/i2p-sam';
import { FileOps } from './database';

// Protocol message types
const MSG_FILE_REQUEST = 0x01;
const MSG_FILE_HEADER = 0x02;
const MSG_FILE_CHUNK = 0x03;
const MSG_FILE_COMPLETE = 0x04;
const MSG_FILE_ERROR = 0x05;

// Chunk size for streaming (64KB)
const STREAM_CHUNK_SIZE = 64 * 1024;

interface StreamSession {
  clientId: string;
  fileHash: string;
  filename: string;
  totalSize: number;
  bytesSent: number;
  startTime: number;
  speed: number;
  socket: net.Socket;
  isPaused: boolean;
}

interface StreamingServerConfig {
  samHost: string;
  samPortTCP: number;
  localForwardHost: string;
  localForwardPort: number;
}

export class StreamingServer extends EventEmitter {
  private config: StreamingServerConfig;
  private samForward: I2pSamStream | null = null;
  private tcpServer: net.Server | null = null;
  private activeSessions: Map<string, StreamSession> = new Map();
  private publicKey: string = '';
  private isRunning: boolean = false;

  constructor(config: Partial<StreamingServerConfig> = {}) {
    super();
    this.config = {
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      localForwardHost: config.localForwardHost || '127.0.0.1',
      localForwardPort: config.localForwardPort || 17700
    };
  }

  async start(publicKey?: string, privateKey?: string): Promise<string> {
    if (this.isRunning) {
      console.log('[StreamingServer] Already running');
      return this.publicKey;
    }

    console.log('[StreamingServer] Starting...');

    // Start local TCP server first
    await this.startTcpServer();

    try {
      // Create SAM forward session
      const samConfig: any = {
        sam: {
          host: this.config.samHost,
          portTCP: this.config.samPortTCP
        },
        forward: {
          host: this.config.localForwardHost,
          port: this.config.localForwardPort,
          silent: false
        }
      };

      // Reuse existing keys if provided
      if (publicKey && privateKey) {
        samConfig.sam.publicKey = publicKey;
        samConfig.sam.privateKey = privateKey;
      }

      this.samForward = await createForward(samConfig);
      this.publicKey = this.samForward.getPublicKey();

      this.samForward.on('error', (error: Error) => {
        console.error('[StreamingServer] SAM error:', error.message);
      });

      this.samForward.on('close', () => {
        console.log('[StreamingServer] SAM session closed');
        this.isRunning = false;
      });

      this.isRunning = true;
      console.log('[StreamingServer] Started, listening for streaming connections');
      console.log('[StreamingServer] Public key:', this.publicKey.substring(0, 30) + '...');

      return this.publicKey;
    } catch (error: any) {
      console.error('[StreamingServer] Failed to start:', error.message);
      throw error;
    }
  }

  private startTcpServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.tcpServer = net.createServer((socket) => {
        this.handleConnection(socket);
      });

      this.tcpServer.on('error', (error) => {
        console.error('[StreamingServer] TCP server error:', error.message);
        reject(error);
      });

      this.tcpServer.listen(this.config.localForwardPort, this.config.localForwardHost, () => {
        console.log(`[StreamingServer] TCP server listening on ${this.config.localForwardHost}:${this.config.localForwardPort}`);
        resolve();
      });
    });
  }

  private handleConnection(socket: net.Socket): void {
    const sessionId = `${Date.now()}-${Math.random().toString(36).substring(7)}`;
    console.log(`[StreamingServer] New connection: ${sessionId}`);

    let buffer = Buffer.alloc(0);

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      this.processBuffer(sessionId, socket, buffer);
      buffer = Buffer.alloc(0); // Clear buffer after processing
    });

    socket.on('close', () => {
      console.log(`[StreamingServer] Connection closed: ${sessionId}`);
      const session = this.activeSessions.get(sessionId);
      if (session) {
        this.activeSessions.delete(sessionId);
        this.emit('upload:cancelled', { sessionId });
      }
    });

    socket.on('error', (error) => {
      console.error(`[StreamingServer] Socket error (${sessionId}):`, error.message);
    });
  }

  private processBuffer(sessionId: string, socket: net.Socket, buffer: Buffer): void {
    if (buffer.length < 1) return;

    const msgType = buffer[0];

    switch (msgType) {
      case MSG_FILE_REQUEST:
        this.handleFileRequest(sessionId, socket, buffer.slice(1));
        break;
      default:
        console.warn(`[StreamingServer] Unknown message type: ${msgType}`);
    }
  }

  private handleFileRequest(sessionId: string, socket: net.Socket, data: Buffer): void {
    try {
      // Parse request: fileHash (64 bytes hex) + startOffset (8 bytes)
      const requestJson = data.toString('utf8');
      const request = JSON.parse(requestJson);
      const { fileHash, startOffset = 0 } = request;

      console.log(`[StreamingServer] File request: ${fileHash.substring(0, 16)}... offset: ${startOffset}`);

      // Find the file
      const file = FileOps.getByHash(fileHash) as any;
      if (!file) {
        this.sendError(socket, 'File not found');
        return;
      }

      // Check file exists and get stats
      if (!fs.existsSync(file.path)) {
        this.sendError(socket, 'File no longer available');
        return;
      }

      const stats = fs.statSync(file.path);
      const totalSize = stats.size;

      if (startOffset >= totalSize) {
        this.sendError(socket, 'Invalid start offset');
        return;
      }

      // Create session
      const session: StreamSession = {
        clientId: sessionId,
        fileHash,
        filename: file.filename,
        totalSize,
        bytesSent: startOffset,
        startTime: Date.now(),
        speed: 0,
        socket,
        isPaused: false
      };
      this.activeSessions.set(sessionId, session);

      // Send file header
      this.sendHeader(socket, fileHash, file.filename, totalSize, startOffset);

      this.emit('upload:start', {
        sessionId,
        filename: file.filename,
        size: totalSize - startOffset
      });

      // Start streaming file
      this.streamFile(sessionId, file.path, startOffset, totalSize);
    } catch (error: any) {
      console.error('[StreamingServer] Error handling file request:', error);
      this.sendError(socket, error.message);
    }
  }

  private sendHeader(socket: net.Socket, fileHash: string, filename: string, totalSize: number, startOffset: number): void {
    const header = JSON.stringify({
      fileHash,
      filename,
      totalSize,
      startOffset
    });
    const headerBuf = Buffer.from(header, 'utf8');
    const msg = Buffer.alloc(1 + 4 + headerBuf.length);
    msg[0] = MSG_FILE_HEADER;
    msg.writeUInt32BE(headerBuf.length, 1);
    headerBuf.copy(msg, 5);
    socket.write(msg);
  }

  private sendError(socket: net.Socket, errorMessage: string): void {
    const errorBuf = Buffer.from(errorMessage, 'utf8');
    const msg = Buffer.alloc(1 + 4 + errorBuf.length);
    msg[0] = MSG_FILE_ERROR;
    msg.writeUInt32BE(errorBuf.length, 1);
    errorBuf.copy(msg, 5);
    socket.write(msg);
    socket.end();
  }

  private async streamFile(sessionId: string, filePath: string, startOffset: number, totalSize: number): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;

    const { socket } = session;

    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath, {
        start: startOffset,
        highWaterMark: STREAM_CHUNK_SIZE
      });

      let lastSpeedCalc = Date.now();
      let lastBytesSent = startOffset;
      let chunkIndex = 0;

      stream.on('data', (data) => {
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (!this.activeSessions.has(sessionId)) {
          stream.destroy();
          return;
        }

        if (session.isPaused) {
          stream.pause();
          return;
        }

        // Send chunk with header
        const chunkMsg = Buffer.alloc(1 + 4 + 8 + chunk.length);
        chunkMsg[0] = MSG_FILE_CHUNK;
        chunkMsg.writeUInt32BE(chunk.length, 1);
        chunkMsg.writeBigUInt64BE(BigInt(session.bytesSent), 5);
        chunk.copy(chunkMsg, 13);

        const canWrite = socket.write(chunkMsg);
        session.bytesSent += chunk.length;
        chunkIndex++;

        // Apply backpressure if needed
        if (!canWrite) {
          stream.pause();
          socket.once('drain', () => stream.resume());
        }

        // Calculate speed every second
        const now = Date.now();
        if (now - lastSpeedCalc >= 1000) {
          const bytesDiff = session.bytesSent - lastBytesSent;
          const timeDiff = now - lastSpeedCalc;
          session.speed = Math.round((bytesDiff / timeDiff) * 1000);
          lastSpeedCalc = now;
          lastBytesSent = session.bytesSent;

          this.emit('upload:progress', {
            sessionId,
            bytesSent: session.bytesSent,
            totalSize,
            speed: session.speed
          });
        }
      });

      stream.on('end', () => {
        // Send completion message
        const completeMsg = Buffer.alloc(1 + 8);
        completeMsg[0] = MSG_FILE_COMPLETE;
        completeMsg.writeBigUInt64BE(BigInt(session.bytesSent), 1);
        socket.write(completeMsg);

        this.activeSessions.delete(sessionId);
        this.emit('upload:complete', {
          sessionId,
          filename: session.filename,
          totalSize: session.bytesSent
        });
        resolve();
      });

      stream.on('error', (error) => {
        console.error(`[StreamingServer] Stream error:`, error);
        this.sendError(socket, `Read error: ${error.message}`);
        this.activeSessions.delete(sessionId);
        reject(error);
      });
    });
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  isReady(): boolean {
    return this.isRunning && this.publicKey.length > 0;
  }

  getActiveSessions(): StreamSession[] {
    return Array.from(this.activeSessions.values());
  }

  getStats(): { activeSessions: number; totalSpeed: number } {
    const sessions = this.getActiveSessions();
    return {
      activeSessions: sessions.length,
      totalSpeed: sessions.reduce((sum, s) => sum + s.speed, 0)
    };
  }

  pauseSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.isPaused = true;
      return true;
    }
    return false;
  }

  resumeSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (session && session.isPaused) {
      session.isPaused = false;
      return true;
    }
    return false;
  }

  async stop(): Promise<void> {
    console.log('[StreamingServer] Stopping...');

    // Close all active sessions
    for (const [sessionId, session] of this.activeSessions) {
      session.socket.end();
      this.activeSessions.delete(sessionId);
    }

    // Close SAM forward
    if (this.samForward) {
      this.samForward.close();
      this.samForward = null;
    }

    // Close TCP server
    if (this.tcpServer) {
      this.tcpServer.close();
      this.tcpServer = null;
    }

    this.isRunning = false;
    this.publicKey = '';
    console.log('[StreamingServer] Stopped');
  }
}

export const streamingServer = new StreamingServer();
