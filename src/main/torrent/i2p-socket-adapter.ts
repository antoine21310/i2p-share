/**
 * I2P Socket Adapter for WebTorrent
 *
 * This adapter makes I2P SAM streams appear as standard net.Socket objects
 * to WebTorrent. It extends Duplex and implements the Socket interface.
 */

import { Duplex } from 'stream';
import { createStream, I2pSamStream, toB32 } from '@diva.exchange/i2p-sam';

/**
 * Configuration for I2P socket adapter
 */
export interface I2PSocketConfig {
  /** SAM bridge host (default: 127.0.0.1) */
  samHost: string;
  /** SAM bridge TCP port (default: 7656) */
  samPortTCP: number;
  /** Connection timeout in seconds (default: 120 for I2P) */
  timeout: number;
}

const DEFAULT_CONFIG: I2PSocketConfig = {
  samHost: '127.0.0.1',
  samPortTCP: 7656,
  timeout: 120
};

/**
 * Socket state enum
 */
export enum SocketState {
  CLOSED = 'closed',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  CLOSING = 'closing'
}

/**
 * I2PSocketAdapter - Makes I2P SAM streams appear as net.Socket to WebTorrent
 *
 * WebTorrent expects connections to have:
 * - .remoteAddress property (returns b32.i2p address)
 * - .remotePort property (returns 0 for I2P)
 * - .connect() method
 * - Standard stream interface (read/write)
 * - Error events
 */
export class I2PSocketAdapter extends Duplex {
  private samStream: I2pSamStream | null = null;
  private config: I2PSocketConfig;
  private _destination: string = '';
  private _b32Address: string = '';
  private _state: SocketState = SocketState.CLOSED;
  private _destroyed: boolean = false;
  private pendingWrites: Array<{ chunk: Buffer; callback: (error?: Error | null) => void }> = [];
  private connectPromise: Promise<void> | null = null;

  constructor(config: Partial<I2PSocketConfig> = {}) {
    super({
      allowHalfOpen: false,
      readableHighWaterMark: 64 * 1024, // 64KB
      writableHighWaterMark: 64 * 1024
    });

    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ============================================================================
  // net.Socket compatible properties (required by WebTorrent)
  // ============================================================================

  /**
   * Remote address - returns b32.i2p address for WebTorrent compatibility
   * WebTorrent uses this for peer identification
   */
  get remoteAddress(): string {
    return this._b32Address || '';
  }

  /**
   * Remote port - I2P doesn't use ports, return 0
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
   * Whether socket is connecting
   */
  get connecting(): boolean {
    return this._state === SocketState.CONNECTING;
  }

  /**
   * Full I2P destination (base64)
   */
  get destination(): string {
    return this._destination;
  }

  /**
   * Short b32.i2p address
   */
  get b32Address(): string {
    return this._b32Address;
  }

  /**
   * Connection state
   */
  get state(): SocketState {
    return this._state;
  }

  // ============================================================================
  // Connection methods
  // ============================================================================

  /**
   * Connect to an I2P destination
   * @param destination - Full I2P destination (base64, ~400 chars)
   */
  async connect(destination: string): Promise<this> {
    if (this._state === SocketState.CONNECTING && this.connectPromise) {
      await this.connectPromise;
      return this;
    }

    if (this._state === SocketState.CONNECTED) {
      if (this._destination === destination) {
        return this;
      }
      await this.close();
    }

    this._destination = destination;
    this._b32Address = toB32(destination);
    this._state = SocketState.CONNECTING;

    this.connectPromise = this._doConnect(destination);

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }

    return this;
  }

  private async _doConnect(destination: string): Promise<void> {
    console.log(`[I2PSocket] Connecting to ${this._b32Address.substring(0, 16)}...`);

    // Create timeout promise
    const timeoutMs = this.config.timeout * 1000;
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Connection timeout after ${this.config.timeout}s`));
      }, timeoutMs);
    });

    try {
      // Race between connection and timeout
      this.samStream = await Promise.race([
        createStream({
          sam: {
            host: this.config.samHost,
            portTCP: this.config.samPortTCP,
            timeout: this.config.timeout
          },
          stream: { destination }
        }),
        timeoutPromise
      ]);

      // Set up event handlers
      this.samStream.on('data', (data: Buffer) => {
        if (!this.push(data)) {
          // Backpressure - SAM stream doesn't support pause
        }
      });

      this.samStream.on('error', (error: Error) => {
        console.error(`[I2PSocket] Stream error:`, error.message);
        this._state = SocketState.CLOSED;
        this.emit('error', error);
        this.destroy(error);
      });

      this.samStream.on('close', () => {
        console.log(`[I2PSocket] Stream closed`);
        if (this._state !== SocketState.CLOSED) {
          this._state = SocketState.CLOSED;
          this.push(null);
          this.emit('close');
        }
      });

      this._state = SocketState.CONNECTED;
      console.log(`[I2PSocket] Connected to ${this._b32Address.substring(0, 16)}...`);

      // Emit connect event for WebTorrent
      this.emit('connect');

      // Flush any pending writes
      this._flushPendingWrites();

    } catch (error: any) {
      this._state = SocketState.CLOSED;
      console.error(`[I2PSocket] Connection failed:`, error.message);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Close the connection gracefully
   */
  async close(): Promise<void> {
    if (this._state === SocketState.CLOSED || this._state === SocketState.CLOSING) {
      return;
    }

    this._state = SocketState.CLOSING;
    console.log(`[I2PSocket] Closing connection to ${this._b32Address.substring(0, 16)}...`);

    // Clear pending writes
    for (const pending of this.pendingWrites) {
      pending.callback(new Error('Socket closing'));
    }
    this.pendingWrites = [];

    // Close SAM stream
    if (this.samStream) {
      try {
        this.samStream.close();
      } catch (e) {
        // Ignore close errors
      }
      this.samStream = null;
    }

    this._state = SocketState.CLOSED;
    this._destination = '';
    this._b32Address = '';

    this.emit('close');
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this._state === SocketState.CONNECTED && this.samStream !== null;
  }

  // ============================================================================
  // Duplex stream implementation
  // ============================================================================

  _read(_size: number): void {
    // Data is pushed when received from SAM stream
  }

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this._destroyed) {
      callback(new Error('Socket destroyed'));
      return;
    }

    if (!this.isConnected()) {
      if (this._state === SocketState.CONNECTING) {
        // Queue write for when connected
        this.pendingWrites.push({ chunk, callback });
        return;
      }
      callback(new Error('Socket not connected'));
      return;
    }

    this._writeToStream(chunk, callback);
  }

  private _writeToStream(chunk: Buffer, callback: (error?: Error | null) => void): void {
    if (!this.samStream) {
      callback(new Error('No SAM stream'));
      return;
    }

    try {
      this.samStream.stream(chunk);
      callback();
    } catch (error: any) {
      callback(error);
    }
  }

  private _flushPendingWrites(): void {
    const pending = this.pendingWrites;
    this.pendingWrites = [];

    for (const { chunk, callback } of pending) {
      this._writeToStream(chunk, callback);
    }
  }

  _final(callback: (error?: Error | null) => void): void {
    this.close().then(() => callback()).catch(callback);
  }

  _destroy(error: Error | null, callback: (error: Error | null) => void): void {
    this._destroyed = true;
    this.close().then(() => callback(error)).catch(() => callback(error));
  }

  // ============================================================================
  // net.Socket compatible methods (may be called by WebTorrent)
  // ============================================================================

  /**
   * Set keep-alive - no-op for I2P (handled at tunnel level)
   */
  setKeepAlive(enable?: boolean, initialDelay?: number): this {
    return this;
  }

  /**
   * Set no-delay - no-op for I2P
   */
  setNoDelay(noDelay?: boolean): this {
    return this;
  }

  /**
   * Set timeout
   */
  setTimeout(timeout: number, callback?: () => void): this {
    if (callback) {
      this.once('timeout', callback);
    }
    return this;
  }

  /**
   * Ref - no-op
   */
  ref(): this {
    return this;
  }

  /**
   * Unref - no-op
   */
  unref(): this {
    return this;
  }

  /**
   * Address - returns mock address info
   */
  address(): { port: number; family: string; address: string } | null {
    if (!this.isConnected()) return null;
    return {
      port: 0,
      family: 'I2P',
      address: this._b32Address
    };
  }

  /**
   * End the writable side
   */
  end(cb?: () => void): this;
  end(chunk: any, cb?: () => void): this;
  end(chunk: any, encoding?: BufferEncoding, cb?: () => void): this;
  end(chunkOrCb?: any, encodingOrCb?: BufferEncoding | (() => void), cb?: () => void): this {
    let callback: (() => void) | undefined;

    if (typeof chunkOrCb === 'function') {
      callback = chunkOrCb;
    } else if (typeof encodingOrCb === 'function') {
      callback = encodingOrCb;
    } else {
      callback = cb;
    }

    super.end(callback);
    return this;
  }
}

/**
 * Create an I2P socket and connect to destination
 * Factory function for use with WebTorrent
 */
export async function createI2PSocket(
  destination: string,
  config?: Partial<I2PSocketConfig>
): Promise<I2PSocketAdapter> {
  const socket = new I2PSocketAdapter(config);
  await socket.connect(destination);
  return socket;
}

/**
 * Create an I2P socket without connecting (for manual connection)
 */
export function createI2PSocketSync(config?: Partial<I2PSocketConfig>): I2PSocketAdapter {
  return new I2PSocketAdapter(config);
}
