/**
 * Torrent Manager (WebTorrent Edition)
 *
 * Central orchestrator for all torrent operations using WebTorrent over I2P.
 * Singleton pattern for app-wide torrent management.
 */

import { EventEmitter } from 'events';
import fs from 'fs';

// Get electron from global (set by bootstrap.cjs)
const electron = (globalThis as any).__electron;
const { app } = electron;
import path from 'path';
import type { Torrent } from 'webtorrent';
import {
    AddTorrentResult,
    CreateTorrentResult,
    TorrentFile,
    TorrentInfo,
    TorrentState,
    TorrentStatus
} from '../../shared/torrent-types.js';
import {
    TorrentFileOps,
    TorrentOps,
    TorrentPieceOps
} from '../database.js';
import { MultiTrackerManager, createMultiTrackerManager } from './multi-tracker-manager.js';
import { TorrentFileUtils } from './torrent-file.js';
import { WebTorrentI2PClient } from './webtorrent-i2p-client.js';
import { I2PPeerInjector, createPeerInjector } from './i2p-peer-injector.js';

/**
 * Torrent Manager Events
 */
export interface TorrentManagerEvents {
  'torrent-added': (infoHash: string, name: string) => void;
  'torrent-removed': (infoHash: string) => void;
  'torrent-started': (infoHash: string) => void;
  'torrent-stopped': (infoHash: string) => void;
  'torrent-complete': (infoHash: string) => void;
  'torrent-error': (infoHash: string, error: Error) => void;
  'progress': (infoHash: string, progress: number) => void;
  'stats': (stats: GlobalStats) => void;
}

/**
 * Global statistics
 */
export interface GlobalStats {
  totalDownloadSpeed: number;
  totalUploadSpeed: number;
  activeTorrents: number;
  totalPeers: number;
}

/**
 * Manager configuration
 */
export interface TorrentManagerConfig {
  /** Default download path */
  downloadPath: string;
  /** Maximum concurrent active torrents */
  maxActiveTorrents: number;
  /** Auto-start torrents on load */
  autoStart: boolean;
  /** Tracker addresses (I2P destinations) */
  trackers: string[];
  /** Our I2P destination */
  localDestination: string;
  /** SAM host */
  samHost?: string;
  /** SAM TCP port */
  samPortTCP?: number;
}

const DEFAULT_MANAGER_CONFIG: TorrentManagerConfig = {
  downloadPath: '',
  maxActiveTorrents: 10,
  autoStart: true,
  trackers: [],
  localDestination: '',
  samHost: '127.0.0.1',
  samPortTCP: 7656
};

/**
 * Torrent Manager using WebTorrent over I2P
 */
export class TorrentManager extends EventEmitter {
  private static instance: TorrentManager | null = null;

  private config: TorrentManagerConfig;
  private client: WebTorrentI2PClient | null = null;
  private peerInjector: I2PPeerInjector | null = null;
  private multiTracker: MultiTrackerManager;
  private dhtEngine: any = null;
  private isInitialized: boolean = false;
  private statsTimer: NodeJS.Timeout | null = null;

  /** Map infoHash -> torrentId (database ID) */
  private torrentDbIds: Map<string, number> = new Map();

  /** Track torrent metadata for magnet links */
  private pendingMetadata: Set<string> = new Set();

  private constructor(config: Partial<TorrentManagerConfig> = {}) {
    super();

    const defaultDownloadPath = app?.getPath('downloads') || process.cwd();

    this.config = {
      ...DEFAULT_MANAGER_CONFIG,
      ...config,
      downloadPath: config.downloadPath || defaultDownloadPath
    };

    // Ensure download directory exists
    if (!fs.existsSync(this.config.downloadPath)) {
      fs.mkdirSync(this.config.downloadPath, { recursive: true });
    }

    // Initialize multi-tracker manager
    this.multiTracker = createMultiTrackerManager({
      samHost: this.config.samHost,
      samPortTCP: this.config.samPortTCP
    });
  }

  /**
   * Get singleton instance
   */
  static getInstance(config?: Partial<TorrentManagerConfig>): TorrentManager {
    if (!TorrentManager.instance) {
      TorrentManager.instance = new TorrentManager(config);
    }
    return TorrentManager.instance;
  }

  /**
   * Initialize the manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    console.log('[TorrentManager] Initializing with WebTorrent...');

    // Create WebTorrent I2P client (async factory due to ESM dynamic import)
    this.client = await WebTorrentI2PClient.create({
      downloadPath: this.config.downloadPath,
      samHost: this.config.samHost,
      samPortTCP: this.config.samPortTCP,
      maxConns: 50
    });

    // Create peer injector
    this.peerInjector = createPeerInjector(this.client, this.multiTracker);

    // Set up WebTorrent event forwarding
    this._setupClientEvents();

    // Load existing torrents from database
    await this._loadFromDatabase();

    // Start stats timer
    this.statsTimer = setInterval(() => {
      this._emitGlobalStats();
    }, 1000);

    this.isInitialized = true;
    console.log(`[TorrentManager] Initialized with ${this.torrentDbIds.size} torrents`);
  }

  /**
   * Set up event handlers for WebTorrent client
   */
  private _setupClientEvents(): void {
    if (!this.client) return;

    this.client.on('torrent-ready', (torrent: Torrent) => {
      console.log(`[TorrentManager] Ready: ${torrent.name}`);

      // Start peer injection
      this.peerInjector?.startTorrent(torrent.infoHash);

      // If this was a magnet link, update database with full metadata
      if (this.pendingMetadata.has(torrent.infoHash)) {
        this._updateMetadataFromTorrent(torrent);
        this.pendingMetadata.delete(torrent.infoHash);
      }

      this.emit('torrent-started', torrent.infoHash);
    });

    this.client.on('torrent-done', (torrent: Torrent) => {
      console.log(`[TorrentManager] Complete: ${torrent.name}`);
      TorrentOps.setSeeding(torrent.infoHash, true);
      TorrentOps.setState(torrent.infoHash, TorrentState.SEEDING);
      this.emit('torrent-complete', torrent.infoHash);
    });

    this.client.on('torrent-error', (torrent: Torrent, error: Error) => {
      console.error(`[TorrentManager] Error on ${torrent.name}:`, error.message);
      this.emit('torrent-error', torrent.infoHash, error);
    });
  }

  /**
   * Load torrents from database
   */
  private async _loadFromDatabase(): Promise<void> {
    const rows = TorrentOps.getAll();

    for (const row of rows) {
      try {
        // Store database ID mapping
        this.torrentDbIds.set(row.infoHash, row.id);

        // Skip if we don't have enough metadata
        if (!row.torrentData && !row.magnetUri) {
          console.warn(`[TorrentManager] Skipping ${row.infoHash}: no torrent data or magnet`);
          continue;
        }

        let torrent: Torrent;

        if (row.torrentData) {
          // Add from .torrent data
          torrent = this.client!.add(row.torrentData, {
            path: row.savePath || this.config.downloadPath
          });
        } else if (row.magnetUri) {
          // Add from magnet URI
          torrent = this.client!.add(row.magnetUri, {
            path: row.savePath || this.config.downloadPath
          });

          // Mark as pending metadata if we don't have full info
          if (row.totalSize === 0) {
            this.pendingMetadata.add(row.infoHash);
          }
        } else {
          continue;
        }

        this._setupTorrentEvents(torrent);

        // Auto-start if configured and was seeding
        if (this.config.autoStart && row.isSeeding) {
          this.peerInjector?.startTorrent(row.infoHash);
        }

      } catch (error: any) {
        console.error(`[TorrentManager] Failed to load ${row.infoHash}:`, error.message);
      }
    }
  }

  /**
   * Set up event handlers for a torrent
   */
  private _setupTorrentEvents(torrent: Torrent): void {
    torrent.on('download', (bytes: number) => {
      const progress = Math.round(torrent.progress * 100);
      this.emit('progress', torrent.infoHash, progress);

      // Update database periodically (throttled by WebTorrent events)
      TorrentOps.updateProgress(torrent.infoHash, torrent.downloaded, torrent.uploaded);
    });

    torrent.on('upload', (bytes: number) => {
      // Track upload progress
      TorrentOps.updateProgress(torrent.infoHash, torrent.downloaded, torrent.uploaded);
    });

    torrent.on('metadata', () => {
      console.log(`[TorrentManager] Metadata received for: ${torrent.name}`);
      this._updateMetadataFromTorrent(torrent);
    });

    torrent.on('warning', (warning: Error | string) => {
      const msg = typeof warning === 'string' ? warning : warning.message;
      console.warn(`[TorrentManager] Warning (${torrent.name}):`, msg);
    });
  }

  /**
   * Update database metadata from torrent (for magnet links)
   */
  private _updateMetadataFromTorrent(torrent: Torrent): void {
    const dbId = this.torrentDbIds.get(torrent.infoHash);
    if (!dbId) return;

    try {
      // Update torrent metadata in database
      TorrentOps.updateMetadata(torrent.infoHash, {
        name: torrent.name,
        totalSize: torrent.length,
        pieceLength: torrent.pieceLength,
        pieceCount: torrent.pieces?.length || 0,
        pieces: '' // WebTorrent manages pieces internally
      });

      // Add files
      if (torrent.files && torrent.files.length > 0) {
        const files: TorrentFile[] = torrent.files.map((f: any, index: number) => ({
          path: f.path,
          size: f.length,
          offset: f.offset || 0
        }));
        TorrentFileOps.addFiles(dbId, files);
      }

      console.log(`[TorrentManager] Updated metadata for ${torrent.name}`);
    } catch (error: any) {
      console.error(`[TorrentManager] Failed to update metadata:`, error.message);
    }
  }

  /**
   * Add a torrent from .torrent file data
   */
  async addTorrent(torrentData: Buffer): Promise<AddTorrentResult> {
    if (!this.client) throw new Error('Client not initialized');

    const metadata = TorrentFileUtils.parseBuffer(torrentData);

    // Check if already exists
    if (this.client.has(metadata.infoHash)) {
      const existing = this.client.get(metadata.infoHash)!;
      return { infoHash: existing.infoHash, name: existing.name };
    }

    console.log(`[TorrentManager] Adding torrent: ${metadata.name}`);

    // Save to database
    const torrentId = TorrentOps.create({
      infoHash: metadata.infoHash,
      name: metadata.name,
      totalSize: metadata.totalSize,
      pieceLength: metadata.pieceLength,
      pieceCount: metadata.pieceCount,
      pieces: Buffer.isBuffer(metadata.pieces) ? metadata.pieces.toString('hex') : metadata.pieces,
      magnetUri: metadata.magnetUri,
      torrentData: torrentData,
      savePath: this.config.downloadPath
    });

    this.torrentDbIds.set(metadata.infoHash, torrentId);

    // Add files to database
    if (metadata.files.length > 0) {
      TorrentFileOps.addFiles(torrentId, metadata.files);
    }

    // Initialize pieces tracking
    TorrentPieceOps.initPieces(torrentId, metadata.pieceCount);

    // Add to WebTorrent
    const torrent = this.client.add(torrentData, {
      path: this.config.downloadPath
    });

    this._setupTorrentEvents(torrent);

    this.emit('torrent-added', metadata.infoHash, metadata.name);

    // Start peer discovery
    this.peerInjector?.startTorrent(metadata.infoHash);

    // Announce to trackers and DHT
    if (this.config.localDestination) {
      this._announceToNetwork(metadata.infoHash);
    }

    return { infoHash: metadata.infoHash, name: metadata.name };
  }

  /**
   * Add a torrent from magnet URI
   */
  async addMagnet(magnetUri: string): Promise<AddTorrentResult> {
    if (!this.client) throw new Error('Client not initialized');

    const partialMetadata = TorrentFileUtils.parseMagnet(magnetUri);

    if (!partialMetadata.infoHash) {
      throw new Error('Invalid magnet URI: missing infoHash');
    }

    // Check if already exists
    if (this.client.has(partialMetadata.infoHash)) {
      const existing = this.client.get(partialMetadata.infoHash)!;
      return { infoHash: existing.infoHash, name: existing.name };
    }

    console.log(`[TorrentManager] Adding magnet: ${partialMetadata.name || partialMetadata.infoHash.substring(0, 16)}...`);

    // Save placeholder to database
    const torrentId = TorrentOps.create({
      infoHash: partialMetadata.infoHash,
      name: partialMetadata.name || 'Magnet Link',
      totalSize: 0,
      pieceLength: 0,
      pieceCount: 0,
      pieces: '',
      magnetUri: magnetUri,
      savePath: this.config.downloadPath
    });

    this.torrentDbIds.set(partialMetadata.infoHash, torrentId);
    this.pendingMetadata.add(partialMetadata.infoHash);

    // Add to WebTorrent (will fetch metadata via ut_metadata)
    const torrent = this.client.add(magnetUri, {
      path: this.config.downloadPath
    });

    this._setupTorrentEvents(torrent);

    this.emit('torrent-added', partialMetadata.infoHash, partialMetadata.name || 'Magnet Link');

    // Start peer discovery (important for magnet links to fetch metadata)
    this.peerInjector?.startTorrent(partialMetadata.infoHash);

    // Announce to trackers and DHT
    if (this.config.localDestination) {
      this._announceToNetwork(partialMetadata.infoHash);
    }

    return { infoHash: partialMetadata.infoHash, name: partialMetadata.name || 'Magnet Link' };
  }

  /**
   * Create a torrent from a local file
   */
  async createTorrent(
    filePath: string,
    options?: { name?: string; trackers?: string[] }
  ): Promise<CreateTorrentResult> {
    if (!this.client) throw new Error('Client not initialized');

    console.log(`[TorrentManager] Creating torrent for: ${filePath}`);

    // Seed the file with WebTorrent
    const torrent = this.client.seed(filePath, {
      name: options?.name,
      path: path.dirname(filePath)
    });

    return new Promise((resolve, reject) => {
      torrent.on('ready', () => {
        const magnetUri = torrent.magnetURI;

        // Save to database
        const torrentId = TorrentOps.create({
          infoHash: torrent.infoHash,
          name: torrent.name,
          totalSize: torrent.length,
          pieceLength: torrent.pieceLength,
          pieceCount: torrent.pieces?.length || 0,
          pieces: '',
          magnetUri: magnetUri,
          savePath: path.dirname(filePath),
          isSeeding: true
        });

        this.torrentDbIds.set(torrent.infoHash, torrentId);

        // Add files to database
        if (torrent.files && torrent.files.length > 0) {
          const files: TorrentFile[] = torrent.files.map((f: any) => ({
            path: f.path,
            size: f.length,
            offset: f.offset || 0
          }));
          TorrentFileOps.addFiles(torrentId, files);
        }

        this._setupTorrentEvents(torrent);

        // Start peer injection and announcing
        this.peerInjector?.startTorrent(torrent.infoHash);
        this.peerInjector?.announceSelf(torrent.infoHash);

        this.emit('torrent-added', torrent.infoHash, torrent.name);

        resolve({
          magnetUri,
          torrentData: torrent.torrentFile,
          infoHash: torrent.infoHash
        });
      });

      torrent.on('error', reject);
    });
  }

  /**
   * Remove a torrent
   */
  async removeTorrent(infoHash: string, deleteFiles: boolean = false): Promise<void> {
    if (!this.client) throw new Error('Client not initialized');

    const torrent = this.client.get(infoHash);
    if (!torrent) {
      throw new Error(`Torrent not found: ${infoHash}`);
    }

    console.log(`[TorrentManager] Removing: ${torrent.name}`);

    // Stop peer injection
    this.peerInjector?.stopTorrent(infoHash);

    // Remove from WebTorrent
    await this.client.remove(infoHash, deleteFiles);

    // Remove from tracking
    this.torrentDbIds.delete(infoHash);
    this.pendingMetadata.delete(infoHash);

    // Remove from database
    TorrentOps.delete(infoHash);

    this.emit('torrent-removed', infoHash);
  }

  /**
   * Pause a torrent
   */
  async pauseTorrent(infoHash: string): Promise<void> {
    const torrent = this.client?.get(infoHash);
    if (!torrent) throw new Error(`Torrent not found: ${infoHash}`);

    torrent.pause();
    this.peerInjector?.stopTorrent(infoHash);
    TorrentOps.setState(infoHash, TorrentState.PAUSED);
    this.emit('torrent-stopped', infoHash);
  }

  /**
   * Resume a torrent
   */
  async resumeTorrent(infoHash: string): Promise<void> {
    const torrent = this.client?.get(infoHash);
    if (!torrent) throw new Error(`Torrent not found: ${infoHash}`);

    torrent.resume();
    this.peerInjector?.startTorrent(infoHash);
    TorrentOps.setState(infoHash, TorrentState.DOWNLOADING);
    this.emit('torrent-started', infoHash);
  }

  /**
   * Get torrent status
   */
  getStatus(infoHash: string): TorrentStatus | null {
    const torrent = this.client?.get(infoHash);
    if (!torrent) return null;

    const state = this._getTorrentState(torrent);

    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      state,
      progress: Math.round(torrent.progress * 100),
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      downloadedBytes: torrent.downloaded,
      uploadedBytes: torrent.uploaded,
      ratio: torrent.ratio,
      eta: torrent.timeRemaining ? Math.ceil(torrent.timeRemaining / 1000) : Infinity,
      peersCount: torrent.numPeers,
      seedersCount: 0, // WebTorrent doesn't distinguish
      leechersCount: 0,
      piecesCompleted: this._getCompletedPieces(torrent),
      piecesTotal: torrent.pieces?.length || 0,
      savePath: torrent.path
    };
  }

  /**
   * Get torrent state from WebTorrent torrent
   */
  private _getTorrentState(torrent: Torrent): TorrentState {
    if (torrent.done) {
      return TorrentState.SEEDING;
    }
    if (torrent.paused) {
      return TorrentState.PAUSED;
    }
    if (!torrent.ready) {
      return TorrentState.METADATA;
    }
    return TorrentState.DOWNLOADING;
  }

  /**
   * Get number of completed pieces
   */
  private _getCompletedPieces(torrent: Torrent): number {
    if (!torrent.pieces) return 0;
    // WebTorrent pieces array: true = completed, null/false = incomplete
    return torrent.pieces.filter((p: any) => p === true).length;
  }

  /**
   * List all torrents
   */
  listTorrents(): TorrentInfo[] {
    if (!this.client) return [];

    return this.client.torrents.map(torrent => ({
      infoHash: torrent.infoHash,
      name: torrent.name,
      totalSize: torrent.length,
      progress: Math.round(torrent.progress * 100),
      state: this._getTorrentState(torrent),
      downloadSpeed: torrent.downloadSpeed,
      uploadSpeed: torrent.uploadSpeed,
      peersCount: torrent.numPeers,
      seedersCount: 0,
      leechersCount: 0,
      createdAt: 0
    }));
  }

  /**
   * Add peer to a torrent
   */
  async addPeer(infoHash: string, destination: string): Promise<boolean> {
    return this.client?.addI2PPeer(infoHash, destination) ?? false;
  }

  /**
   * Get global statistics
   */
  getGlobalStats(): GlobalStats {
    if (!this.client) {
      return {
        totalDownloadSpeed: 0,
        totalUploadSpeed: 0,
        activeTorrents: 0,
        totalPeers: 0
      };
    }

    const stats = this.client.getStats();
    let totalPeers = 0;
    let activeTorrents = 0;

    for (const torrent of this.client.torrents) {
      totalPeers += torrent.numPeers;
      if (!torrent.paused && !torrent.done) {
        activeTorrents++;
      }
    }

    return {
      totalDownloadSpeed: stats.downloadSpeed,
      totalUploadSpeed: stats.uploadSpeed,
      activeTorrents,
      totalPeers
    };
  }

  /**
   * Emit global stats
   */
  private _emitGlobalStats(): void {
    this.emit('stats', this.getGlobalStats());
  }

  /**
   * Announce torrent to I2P network (trackers + DHT)
   */
  private _announceToNetwork(infoHash: string): void {
    // Announce to trackers
    this.multiTracker.announceAll(infoHash, 'started').catch(err => {
      console.warn(`[TorrentManager] Tracker announce failed: ${err.message}`);
    });

    // Announce to DHT
    if (this.dhtEngine) {
      this.dhtEngine.announcePeer(infoHash).catch((err: any) => {
        console.warn(`[TorrentManager] DHT announce failed: ${err.message}`);
      });
    }
  }

  /**
   * Set our I2P destination
   */
  setLocalDestination(destination: string): void {
    this.config.localDestination = destination;
    this.multiTracker.setLocalDestination(destination);
    this.peerInjector?.setLocalDestination(destination);
  }

  /**
   * Set DHT engine for peer discovery
   */
  setDHTEngine(dhtEngine: any): void {
    this.dhtEngine = dhtEngine;
    this.peerInjector?.setDHTEngine(dhtEngine);
  }

  /**
   * Set tracker addresses
   */
  setTrackers(trackers: string[]): void {
    this.config.trackers = trackers;
    this.multiTracker.setTrackers(trackers);
  }

  /**
   * Add a tracker
   */
  addTracker(destination: string): void {
    this.multiTracker.addTracker(destination);
  }

  /**
   * Get configured trackers
   */
  getTrackers(): Array<{ destination: string; isOnline: boolean; b32Address: string }> {
    return this.multiTracker.getTrackers().map(t => ({
      destination: t.destination,
      isOnline: t.isOnline,
      b32Address: t.b32Address
    }));
  }

  /**
   * Announce a torrent to all trackers
   */
  async announceToTrackers(
    infoHash: string,
    event?: 'started' | 'completed' | 'stopped'
  ): Promise<void> {
    const torrent = this.client?.get(infoHash);
    if (!torrent) return;

    const stats = {
      uploaded: torrent.uploaded,
      downloaded: torrent.downloaded,
      left: torrent.length - torrent.downloaded
    };

    const result = await this.multiTracker.announceAll(infoHash, event, stats);
    console.log(`[TorrentManager] Announce: ${result.trackersSucceeded}/${result.trackersQueried} trackers, ${result.totalPeers} peers`);
  }

  /**
   * Discover peers from DHT
   */
  async discoverPeersFromDHT(infoHash: string): Promise<string[]> {
    if (!this.dhtEngine) return [];

    console.log(`[TorrentManager] Discovering peers via DHT for ${infoHash.substring(0, 16)}...`);

    try {
      const peers = await this.dhtEngine.getPeers(infoHash, 30000);

      if (peers.length > 0) {
        console.log(`[TorrentManager] DHT found ${peers.length} peers`);

        for (const dest of peers) {
          this.client?.addI2PPeer(infoHash, dest).catch(() => {});
        }
      }

      return peers;
    } catch (error: any) {
      console.log(`[TorrentManager] DHT discovery failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Announce a torrent to DHT
   */
  async announceToDHT(infoHash: string): Promise<void> {
    if (!this.dhtEngine) return;

    console.log(`[TorrentManager] Announcing to DHT: ${infoHash.substring(0, 16)}...`);

    try {
      await this.dhtEngine.announcePeer(infoHash);
    } catch (error: any) {
      console.log(`[TorrentManager] DHT announce failed: ${error.message}`);
    }
  }

  /**
   * Discover new trackers via DHT
   */
  async discoverTrackers(): Promise<string[]> {
    if (!this.dhtEngine) return [];
    return this.multiTracker.discoverTrackers(this.dhtEngine);
  }

  /**
   * Get multi-tracker stats
   */
  getMultiTrackerStats(): {
    totalTrackers: number;
    onlineTrackers: number;
    offlineTrackers: number;
  } {
    return this.multiTracker.getStats();
  }

  /**
   * Shutdown manager
   */
  async shutdown(): Promise<void> {
    console.log('[TorrentManager] Shutting down...');

    // Stop stats timer
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    // Send stopped event to all trackers
    for (const infoHash of this.torrentDbIds.keys()) {
      await this.multiTracker.stopAnnounce(infoHash).catch(() => {});
    }

    // Stop peer injector
    this.peerInjector?.cleanup();

    // Cleanup multi-tracker
    this.multiTracker.cleanup();

    // Destroy WebTorrent client
    await this.client?.destroy();

    this.torrentDbIds.clear();
    this.pendingMetadata.clear();
    this.isInitialized = false;

    console.log('[TorrentManager] Shutdown complete');
  }

  /**
   * Get download path
   */
  getDownloadPath(): string {
    return this.config.downloadPath;
  }

  /**
   * Set download path
   */
  setDownloadPath(downloadPath: string): void {
    this.config.downloadPath = downloadPath;
    if (!fs.existsSync(downloadPath)) {
      fs.mkdirSync(downloadPath, { recursive: true });
    }
  }

  /**
   * Get number of torrents
   */
  get torrentCount(): number {
    return this.client?.torrents.length || 0;
  }

  /**
   * Check if initialized
   */
  get initialized(): boolean {
    return this.isInitialized;
  }
}

/**
 * Get singleton instance
 */
export function getTorrentManager(config?: Partial<TorrentManagerConfig>): TorrentManager {
  return TorrentManager.getInstance(config);
}
