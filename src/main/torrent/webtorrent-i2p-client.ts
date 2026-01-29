/**
 * WebTorrent I2P Client
 *
 * Wrapper around WebTorrent with strict anonymity configuration.
 * All network activity is routed through I2P only.
 */

import type { Torrent, TorrentOptions, Instance as WebTorrentInstance, Options as WebTorrentOptions } from 'webtorrent';
import { EventEmitter } from 'events';
import { I2PSocketAdapter, createI2PSocketSync } from './i2p-socket-adapter.js';

// Dynamically loaded WebTorrent module
let WebTorrent: typeof import('webtorrent').default | null = null;

/**
 * Load WebTorrent module dynamically (ESM)
 */
async function loadWebTorrent(): Promise<typeof import('webtorrent').default> {
  if (!WebTorrent) {
    const module = await import('webtorrent');
    WebTorrent = module.default;
  }
  return WebTorrent;
}

/**
 * Strict anonymity configuration
 * Disables all clearnet features that could leak IP
 */
const I2P_STRICT_CONFIG: Partial<WebTorrentOptions> = {
  dht: false,           // Disable standard DHT (uses clearnet UDP)
  tracker: false,       // Disable tracker announcements (uses clearnet)
  lsd: false,           // Disable local service discovery (mDNS)
  webSeeds: false,      // Disable HTTP web seeds
  utp: false,           // Disable uTP (UDP, not supported over I2P)
};

/**
 * Client configuration
 */
export interface I2PClientConfig {
  /** SAM bridge host */
  samHost?: string;
  /** SAM bridge TCP port */
  samPortTCP?: number;
  /** Connection timeout in seconds */
  timeout?: number;
  /** Download path for torrents */
  downloadPath: string;
  /** Maximum peer connections per torrent */
  maxConns?: number;
}

/**
 * Torrent add options
 */
export interface I2PTorrentOptions {
  /** Save path for this torrent */
  path?: string;
  /** Announce URLs (I2P trackers only) */
  announce?: string[];
  /** Skip hash check */
  skipVerify?: boolean;
}

/**
 * Client events
 */
export interface WebTorrentI2PClientEvents {
  'error': (error: Error) => void;
  'torrent': (torrent: Torrent) => void;
  'torrent-ready': (torrent: Torrent) => void;
  'torrent-done': (torrent: Torrent) => void;
  'torrent-error': (torrent: Torrent, error: Error) => void;
  'wire': (torrent: Torrent, wire: any) => void;
}

/**
 * WebTorrent client configured for I2P anonymity
 */
export class WebTorrentI2PClient extends EventEmitter {
  private client!: WebTorrentInstance;
  private config: Required<I2PClientConfig>;
  private sockets: Map<string, I2PSocketAdapter> = new Map();
  private _destroyed: boolean = false;
  private _initialized: boolean = false;

  private constructor(config: I2PClientConfig) {
    super();

    this.config = {
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      timeout: config.timeout || 120,
      downloadPath: config.downloadPath,
      maxConns: config.maxConns || 50
    };
  }

  /**
   * Initialize the WebTorrent client (async due to dynamic import)
   */
  private async _initialize(): Promise<void> {
    if (this._initialized) return;

    const WT = await loadWebTorrent();

    // Create WebTorrent with strict anonymity settings
    this.client = new WT({
      ...I2P_STRICT_CONFIG,
      maxConns: this.config.maxConns,
      downloadLimit: -1,
      uploadLimit: -1,
    } as WebTorrentOptions);

    this._setupClientEvents();
    this._initialized = true;

    console.log('[WebTorrent-I2P] Client initialized with strict anonymity config');
  }

  /**
   * Factory method to create and initialize a WebTorrentI2PClient
   */
  static async create(config: I2PClientConfig): Promise<WebTorrentI2PClient> {
    const instance = new WebTorrentI2PClient(config);
    await instance._initialize();
    return instance;
  }

  private _setupClientEvents(): void {
    this.client.on('error', (err: Error) => {
      console.error('[WebTorrent-I2P] Client error:', err.message);
      this.emit('error', err);
    });

    this.client.on('torrent', (torrent: Torrent) => {
      console.log(`[WebTorrent-I2P] Torrent added: ${torrent.infoHash.substring(0, 16)}...`);
      this.emit('torrent', torrent);
    });
  }

  /**
   * Set up events for a torrent
   */
  private _setupTorrentEvents(torrent: Torrent): void {
    torrent.on('ready', () => {
      console.log(`[WebTorrent-I2P] Torrent ready: ${torrent.name}`);
      this.emit('torrent-ready', torrent);
    });

    torrent.on('done', () => {
      console.log(`[WebTorrent-I2P] Torrent complete: ${torrent.name}`);
      this.emit('torrent-done', torrent);
    });

    torrent.on('error', (err: Error) => {
      console.error(`[WebTorrent-I2P] Torrent error (${torrent.name}):`, err.message);
      this.emit('torrent-error', torrent, err);
    });

    torrent.on('wire', (wire: any) => {
      this.emit('wire', torrent, wire);
    });

    torrent.on('warning', (warning: Error | string) => {
      const msg = typeof warning === 'string' ? warning : warning.message;
      console.warn(`[WebTorrent-I2P] Torrent warning (${torrent.name}):`, msg);
    });
  }

  /**
   * Add a torrent from .torrent file, magnet URI, or infoHash
   */
  add(
    torrentId: string | Buffer,
    options?: I2PTorrentOptions
  ): Torrent {
    const torrent = this.client.add(torrentId, {
      path: options?.path || this.config.downloadPath,
      announce: [], // We inject peers manually
      skipVerify: options?.skipVerify || false,
    } as TorrentOptions);

    this._setupTorrentEvents(torrent);
    return torrent;
  }

  /**
   * Seed a file or directory
   */
  seed(
    input: string | string[] | Buffer | Buffer[],
    options?: { name?: string; path?: string }
  ): Torrent {
    const torrent = this.client.seed(input, {
      name: options?.name,
      path: options?.path || this.config.downloadPath,
      announce: [],
    } as any);

    this._setupTorrentEvents(torrent);
    return torrent;
  }

  /**
   * Add an I2P peer to a torrent
   * This is the primary way to connect to peers over I2P
   *
   * @param infoHash - Torrent infohash
   * @param destination - Full I2P destination (base64)
   * @returns true if peer was added successfully
   */
  async addI2PPeer(infoHash: string, destination: string): Promise<boolean> {
    const torrent = this.client.get(infoHash);
    if (!torrent) {
      console.warn(`[WebTorrent-I2P] Torrent not found: ${infoHash.substring(0, 16)}...`);
      return false;
    }

    // Create unique key for this socket
    const socketKey = `${infoHash}:${destination.substring(0, 32)}`;

    // Check if already connected
    if (this.sockets.has(socketKey)) {
      const existing = this.sockets.get(socketKey)!;
      if (existing.isConnected()) {
        return true; // Already connected
      }
      // Remove stale socket
      this.sockets.delete(socketKey);
    }

    try {
      // Create I2P socket with our config
      const socket = createI2PSocketSync({
        samHost: this.config.samHost,
        samPortTCP: this.config.samPortTCP,
        timeout: this.config.timeout
      });

      // Connect to I2P destination
      await socket.connect(destination);

      if (!socket.isConnected()) {
        console.warn(`[WebTorrent-I2P] Failed to connect to peer`);
        return false;
      }

      // Track socket
      this.sockets.set(socketKey, socket);

      // Handle socket close
      socket.on('close', () => {
        this.sockets.delete(socketKey);
      });

      socket.on('error', (err: Error) => {
        console.error(`[WebTorrent-I2P] Peer socket error:`, err.message);
        this.sockets.delete(socketKey);
      });

      // Add socket to WebTorrent torrent
      // WebTorrent's addPeer can accept a socket-like object
      torrent.addPeer(socket as any);

      console.log(`[WebTorrent-I2P] Added I2P peer: ${socket.b32Address.substring(0, 16)}...`);
      return true;

    } catch (error: any) {
      console.error(`[WebTorrent-I2P] Failed to add peer:`, error.message);
      return false;
    }
  }

  /**
   * Get a torrent by infoHash
   */
  get(infoHash: string): Torrent | null {
    return this.client.get(infoHash) || null;
  }

  /**
   * Check if a torrent exists
   */
  has(infoHash: string): boolean {
    return this.client.get(infoHash) !== null;
  }

  /**
   * Remove a torrent
   */
  async remove(infoHash: string, removeData: boolean = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const torrent = this.client.get(infoHash);
      if (!torrent) {
        resolve();
        return;
      }

      // Close all sockets for this torrent
      for (const [key, socket] of this.sockets) {
        if (key.startsWith(infoHash)) {
          socket.close().catch(() => {});
          this.sockets.delete(key);
        }
      }

      this.client.remove(infoHash, { destroyStore: removeData }, (err?: Error) => {
        if (err) {
          reject(err);
        } else {
          console.log(`[WebTorrent-I2P] Removed torrent: ${infoHash.substring(0, 16)}...`);
          resolve();
        }
      });
    });
  }

  /**
   * Get all torrents
   */
  get torrents(): Torrent[] {
    return this.client.torrents;
  }

  /**
   * Get client statistics
   */
  getStats(): { downloadSpeed: number; uploadSpeed: number; ratio: number } {
    return {
      downloadSpeed: this.client.downloadSpeed,
      uploadSpeed: this.client.uploadSpeed,
      ratio: this.client.ratio
    };
  }

  /**
   * Get download speed in bytes/sec
   */
  get downloadSpeed(): number {
    return this.client.downloadSpeed;
  }

  /**
   * Get upload speed in bytes/sec
   */
  get uploadSpeed(): number {
    return this.client.uploadSpeed;
  }

  /**
   * Get overall ratio
   */
  get ratio(): number {
    return this.client.ratio;
  }

  /**
   * Get number of active socket connections
   */
  get connectionCount(): number {
    let count = 0;
    for (const socket of this.sockets.values()) {
      if (socket.isConnected()) count++;
    }
    return count;
  }

  /**
   * Check if client is destroyed
   */
  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   * Destroy the client and close all connections
   */
  async destroy(): Promise<void> {
    if (this._destroyed) return;

    console.log('[WebTorrent-I2P] Destroying client...');
    this._destroyed = true;

    // Close all sockets
    const closePromises = Array.from(this.sockets.values()).map(s =>
      s.close().catch(() => {})
    );
    await Promise.all(closePromises);
    this.sockets.clear();

    // Destroy WebTorrent client
    return new Promise((resolve, reject) => {
      this.client.destroy((err?: Error) => {
        if (err) {
          console.error('[WebTorrent-I2P] Destroy error:', err.message);
          reject(err);
        } else {
          console.log('[WebTorrent-I2P] Client destroyed');
          resolve();
        }
      });
    });
  }
}
