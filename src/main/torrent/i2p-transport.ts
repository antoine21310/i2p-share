/**
 * I2P Transport Adapter
 *
 * Wraps i2p-sam's createStream() as a Node.js Duplex stream
 * compatible with bittorrent-protocol Wire.
 */

import { Duplex } from 'stream';
import { EventEmitter } from 'events';
import { createStream, I2pSamStream, toB32 } from '@diva.exchange/i2p-sam';

/**
 * Configuration for I2P transport
 */
export interface I2PTransportConfig {
  /** SAM bridge host */
  samHost: string;
  /** SAM bridge TCP port */
  samPortTCP: number;
  /** Connection timeout in seconds */
  timeout: number;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: I2PTransportConfig = {
  samHost: '127.0.0.1',
  samPortTCP: 7656,
  timeout: 120 // 2 minutes for I2P
};

/**
 * Connection state
 */
export enum TransportState {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error'
}

/**
 * I2P Transport - Wraps I2P SAM streaming connection as a Node.js Duplex stream
 *
 * This adapter bridges i2p-sam's streaming API with Node.js streams,
 * making it compatible with bittorrent-protocol which expects standard streams.
 */
export class I2PTransport extends Duplex {
  private config: I2PTransportConfig;
  private samStream: I2pSamStream | null = null;
  private _destination: string = '';
  private _localDestination: string = '';
  private _state: TransportState = TransportState.DISCONNECTED;
  private _b32Address: string = '';
  private pendingWrites: Array<{ chunk: Buffer; callback: (error?: Error | null) => void }> = [];
  private connectPromise: Promise<void> | null = null;

  constructor(config: Partial<I2PTransportConfig> = {}) {
    super({
      allowHalfOpen: false,
      readableHighWaterMark: 64 * 1024, // 64KB
      writableHighWaterMark: 64 * 1024
    });

    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Remote I2P destination
   */
  get destination(): string {
    return this._destination;
  }

  /**
   * Remote B32 address (short form)
   */
  get b32Address(): string {
    return this._b32Address;
  }

  /**
   * Local I2P destination
   */
  get localDestination(): string {
    return this._localDestination;
  }

  /**
   * Current connection state
   */
  get state(): TransportState {
    return this._state;
  }

  /**
   * Whether transport is connected
   */
  get connected(): boolean {
    return this._state === TransportState.CONNECTED;
  }

  /**
   * Remote address (returns b32.i2p for WebTorrent compatibility)
   */
  get remoteAddress(): string {
    return this._b32Address || '';
  }

  /**
   * Remote port (I2P doesn't use ports, returns 0)
   */
  get remotePort(): number {
    return 0;
  }

  /**
   * Local address
   */
  get localAddress(): string {
    return '127.0.0.1';
  }

  /**
   * Local port
   */
  get localPort(): number {
    return 0;
  }

  /**
   * Connect to a remote I2P destination
   */
  async connect(destination: string): Promise<void> {
    if (this._state === TransportState.CONNECTING) {
      // Wait for existing connection attempt
      if (this.connectPromise) {
        return this.connectPromise;
      }
    }

    if (this._state === TransportState.CONNECTED) {
      if (this._destination === destination) {
        return; // Already connected to this destination
      }
      await this.disconnect();
    }

    this._destination = destination;
    this._b32Address = toB32(destination);
    this._state = TransportState.CONNECTING;

    this.connectPromise = this._connect(destination);

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  private async _connect(destination: string): Promise<void> {
    console.log(`[I2PTransport] Connecting to ${this._b32Address.substring(0, 16)}...`);

    try {
      this.samStream = await createStream({
        sam: {
          host: this.config.samHost,
          portTCP: this.config.samPortTCP,
          timeout: this.config.timeout
        },
        stream: {
          destination
        }
      });

      // Get local destination from the stream
      this._localDestination = this.samStream.getPublicKey();

      // Set up event handlers
      this.samStream.on('data', (data: Buffer) => {
        this.handleData(data);
      });

      this.samStream.on('error', (error: Error) => {
        this.handleError(error);
      });

      this.samStream.on('close', () => {
        this.handleClose();
      });

      this._state = TransportState.CONNECTED;
      this.emit('connect');
      console.log(`[I2PTransport] Connected to ${this._b32Address.substring(0, 16)}...`);

      // Flush pending writes
      this.flushPendingWrites();

    } catch (error: any) {
      this._state = TransportState.ERROR;
      console.error(`[I2PTransport] Connection failed:`, error.message);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Disconnect from the remote peer
   */
  async disconnect(): Promise<void> {
    if (this._state === TransportState.DISCONNECTED) {
      return;
    }

    console.log(`[I2PTransport] Disconnecting from ${this._b32Address.substring(0, 16)}...`);

    if (this.samStream) {
      try {
        this.samStream.close();
      } catch (e) {
        // Ignore close errors
      }
      this.samStream = null;
    }

    this._state = TransportState.DISCONNECTED;
    this._destination = '';
    this._b32Address = '';

    // Clear pending writes with error
    for (const pending of this.pendingWrites) {
      pending.callback(new Error('Transport disconnected'));
    }
    this.pendingWrites = [];

    this.emit('close');
  }

  /**
   * Check if transport is connected
   */
  isConnected(): boolean {
    return this._state === TransportState.CONNECTED && this.samStream !== null;
  }

  /**
   * Handle incoming data from SAM stream
   */
  private handleData(data: Buffer): void {
    // Push data to readable side
    // Note: i2p-sam doesn't support pause, so we rely on Node.js stream internal buffering
    this.push(data);
  }

  /**
   * Handle stream error
   */
  private handleError(error: Error): void {
    console.error(`[I2PTransport] Stream error:`, error.message);
    this._state = TransportState.ERROR;
    this.emit('error', error);
    this.destroy(error);
  }

  /**
   * Handle stream close
   */
  private handleClose(): void {
    console.log(`[I2PTransport] Stream closed`);
    if (this._state !== TransportState.DISCONNECTED) {
      this._state = TransportState.DISCONNECTED;
      this.emit('close');
    }
    this.push(null); // Signal end of readable stream
  }

  /**
   * Flush pending writes after connection
   */
  private flushPendingWrites(): void {
    const pending = this.pendingWrites;
    this.pendingWrites = [];

    for (const { chunk, callback } of pending) {
      this._writeToStream(chunk, callback);
    }
  }

  /**
   * Write data to SAM stream
   */
  private _writeToStream(chunk: Buffer, callback: (error?: Error | null) => void): void {
    if (!this.samStream || !this.isConnected()) {
      callback(new Error('Transport not connected'));
      return;
    }

    try {
      this.samStream.stream(chunk);
      callback();
    } catch (error: any) {
      callback(error);
    }
  }

  // ============================================================================
  // Duplex Stream Implementation
  // ============================================================================

  /**
   * Readable stream _read implementation
   * Data is pushed directly from SAM stream via handleData()
   */
  _read(_size: number): void {
    // No-op: Data is pushed from SAM stream events, not pulled
  }

  /**
   * Writable stream _write implementation
   */
  _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.isConnected()) {
      // Queue write for when connected
      if (this._state === TransportState.CONNECTING) {
        this.pendingWrites.push({ chunk, callback });
        return;
      }
      callback(new Error('Transport not connected'));
      return;
    }

    this._writeToStream(chunk, callback);
  }

  /**
   * Writable stream _final implementation
   */
  _final(callback: (error?: Error | null) => void): void {
    this.disconnect().then(() => callback()).catch(callback);
  }

  /**
   * Destroy stream implementation
   */
  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this.disconnect().then(() => callback(error)).catch(() => callback(error));
  }
}

/**
 * Factory function to create an I2P transport
 */
export function createI2PTransport(config?: Partial<I2PTransportConfig>): I2PTransport {
  return new I2PTransport(config);
}

/**
 * Create and connect an I2P transport in one call
 */
export async function connectI2P(
  destination: string,
  config?: Partial<I2PTransportConfig>
): Promise<I2PTransport> {
  const transport = new I2PTransport(config);
  await transport.connect(destination);
  return transport;
}

/**
 * I2P Transport Pool
 *
 * Manages multiple I2P transport connections with reuse and cleanup.
 */
export class I2PTransportPool extends EventEmitter {
  private config: I2PTransportConfig;
  private transports: Map<string, I2PTransport> = new Map();
  private maxConnections: number;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<I2PTransportConfig> = {}, maxConnections: number = 50) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.maxConnections = maxConnections;

    // Start cleanup timer
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 60000); // Every minute
  }

  /**
   * Get or create a transport for a destination
   */
  async getTransport(destination: string): Promise<I2PTransport> {
    const b32 = toB32(destination);
    let transport = this.transports.get(b32);

    if (transport && transport.isConnected()) {
      return transport;
    }

    // Remove stale transport
    if (transport) {
      await transport.disconnect();
      this.transports.delete(b32);
    }

    // Check connection limit
    if (this.transports.size >= this.maxConnections) {
      // Remove oldest idle connection
      await this.evictOne();
    }

    // Create new transport
    transport = new I2PTransport(this.config);

    transport.on('close', () => {
      this.transports.delete(b32);
      this.emit('transport-closed', destination);
    });

    transport.on('error', (error) => {
      this.emit('transport-error', destination, error);
    });

    await transport.connect(destination);
    this.transports.set(b32, transport);
    this.emit('transport-connected', destination);

    return transport;
  }

  /**
   * Release a transport (may be reused)
   */
  releaseTransport(destination: string): void {
    // Transport stays in pool for reuse
    // Will be cleaned up by cleanup timer if idle
  }

  /**
   * Close a specific transport
   */
  async closeTransport(destination: string): Promise<void> {
    const b32 = toB32(destination);
    const transport = this.transports.get(b32);
    if (transport) {
      await transport.disconnect();
      this.transports.delete(b32);
    }
  }

  /**
   * Get number of active connections
   */
  get connectionCount(): number {
    return this.transports.size;
  }

  /**
   * Get all connected destinations
   */
  getConnectedDestinations(): string[] {
    return Array.from(this.transports.values())
      .filter(t => t.isConnected())
      .map(t => t.destination);
  }

  /**
   * Evict one idle connection
   */
  private async evictOne(): Promise<void> {
    // Find oldest transport (simple FIFO)
    const entry = this.transports.entries().next().value;
    if (entry) {
      const [b32, transport] = entry;
      console.log(`[I2PTransportPool] Evicting transport to ${b32.substring(0, 16)}...`);
      await transport.disconnect();
      this.transports.delete(b32);
    }
  }

  /**
   * Clean up disconnected transports
   */
  private cleanup(): void {
    for (const [b32, transport] of this.transports) {
      if (!transport.isConnected()) {
        this.transports.delete(b32);
      }
    }
  }

  /**
   * Close all connections
   */
  async closeAll(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const closePromises = Array.from(this.transports.values()).map(t => t.disconnect());
    await Promise.all(closePromises);
    this.transports.clear();
  }
}

/**
 * Global transport pool instance
 */
let globalPool: I2PTransportPool | null = null;

/**
 * Get or create the global transport pool
 */
export function getTransportPool(config?: Partial<I2PTransportConfig>): I2PTransportPool {
  if (!globalPool) {
    globalPool = new I2PTransportPool(config);
  }
  return globalPool;
}

/**
 * Close the global transport pool
 */
export async function closeTransportPool(): Promise<void> {
  if (globalPool) {
    await globalPool.closeAll();
    globalPool = null;
  }
}
