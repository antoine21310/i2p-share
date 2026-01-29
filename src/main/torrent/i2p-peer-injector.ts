/**
 * I2P Peer Injector
 *
 * Bridges I2P peer discovery (trackers, DHT) to WebTorrent.
 * Listens for peer discovery events and injects peers into WebTorrent.
 */

import { EventEmitter } from 'events';
import { WebTorrentI2PClient } from './webtorrent-i2p-client.js';
import { MultiTrackerManager } from './multi-tracker-manager.js';
import type { DHTSearchEngine } from '../dht-search.js';
import type { TrackerPeer } from '../../shared/torrent-types.js';

/**
 * Peer injector configuration
 */
export interface PeerInjectorConfig {
  /** Maximum peers to track per torrent */
  maxPeersPerTorrent: number;
  /** Re-announce interval in milliseconds */
  reannounceInterval: number;
  /** Connection attempt delay between peers (ms) */
  connectionDelay: number;
  /** Maximum tried peers to remember per torrent (memory bound) */
  maxTriedPeersPerTorrent: number;
}

const DEFAULT_CONFIG: PeerInjectorConfig = {
  maxPeersPerTorrent: 100,
  reannounceInterval: 30 * 60 * 1000, // 30 minutes
  connectionDelay: 500, // 500ms between connection attempts
  maxTriedPeersPerTorrent: 500 // Limit memory usage
};

/**
 * Events emitted by PeerInjector
 */
export interface PeerInjectorEvents {
  'peer-discovered': (infoHash: string, destination: string, source: 'tracker' | 'dht') => void;
  'peer-connected': (infoHash: string, destination: string) => void;
  'peer-failed': (infoHash: string, destination: string, error: string) => void;
}

/**
 * I2P Peer Injector
 *
 * Bridges peer discovery systems to WebTorrent:
 * - Listens to MultiTrackerManager for peers from I2P trackers
 * - Listens to DHTSearchEngine for peers from I2P DHT
 * - Injects discovered peers into WebTorrent via addI2PPeer
 */
export class I2PPeerInjector extends EventEmitter {
  private client: WebTorrentI2PClient;
  private multiTracker: MultiTrackerManager;
  private dhtEngine: DHTSearchEngine | null = null;
  private config: PeerInjectorConfig;

  /** Our local I2P destination (to filter out self) */
  private localDestination: string = '';

  /** Track which peers we've tried for each torrent */
  private triedPeers: Map<string, Set<string>> = new Map();

  /** Track active torrents for periodic re-announce */
  private activeTorrents: Set<string> = new Set();

  /** Re-announce interval timer */
  private reannounceTimer: NodeJS.Timeout | null = null;

  /** Connection queue to avoid overwhelming I2P */
  private connectionQueue: Array<{ infoHash: string; destination: string }> = [];
  private isProcessingQueue: boolean = false;

  /** Event handler references for cleanup */
  private trackerPeersHandler: ((infoHash: string, peers: TrackerPeer[]) => void) | null = null;
  private dhtPeerHandler: ((data: { infoHash: string; destination: string }) => void) | null = null;

  constructor(
    client: WebTorrentI2PClient,
    multiTracker: MultiTrackerManager,
    config: Partial<PeerInjectorConfig> = {}
  ) {
    super();
    this.client = client;
    this.multiTracker = multiTracker;
    this.config = { ...DEFAULT_CONFIG, ...config };

    this._setupTrackerEvents();
  }

  /**
   * Set our local I2P destination (used to filter self from peer lists)
   */
  setLocalDestination(destination: string): void {
    this.localDestination = destination;
  }

  /**
   * Set DHT engine for peer discovery
   */
  setDHTEngine(dht: DHTSearchEngine): void {
    this.dhtEngine = dht;
    this._setupDHTEvents();
  }

  /**
   * Set up event listeners for tracker peer discovery
   */
  private _setupTrackerEvents(): void {
    this.trackerPeersHandler = (infoHash: string, peers: TrackerPeer[]) => {
      console.log(`[PeerInjector] Tracker found ${peers.length} peers for ${infoHash.substring(0, 16)}...`);

      for (const peer of peers) {
        this._queuePeer(infoHash, peer.destination, 'tracker');
      }
    };
    this.multiTracker.on('peers-found', this.trackerPeersHandler);
  }

  /**
   * Set up event listeners for DHT peer discovery
   */
  private _setupDHTEvents(): void {
    if (!this.dhtEngine) return;

    this.dhtPeerHandler = ({ infoHash, destination }: { infoHash: string; destination: string }) => {
      console.log(`[PeerInjector] DHT peer announced for ${infoHash.substring(0, 16)}...`);
      this._queuePeer(infoHash, destination, 'dht');
    };
    this.dhtEngine.on('peer:announced', this.dhtPeerHandler);
  }

  /**
   * Start tracking a torrent for peer injection
   */
  async startTorrent(infoHash: string): Promise<void> {
    if (this.activeTorrents.has(infoHash)) {
      return; // Already tracking
    }

    this.activeTorrents.add(infoHash);
    console.log(`[PeerInjector] Started tracking: ${infoHash.substring(0, 16)}...`);

    if (!this.triedPeers.has(infoHash)) {
      this.triedPeers.set(infoHash, new Set());
    }

    // Initial peer discovery
    await this.discoverPeers(infoHash);

    // Start periodic re-announce if not already running
    if (!this.reannounceTimer && this.activeTorrents.size > 0) {
      this._startReannounceTimer();
    }
  }

  /**
   * Stop tracking a torrent
   */
  stopTorrent(infoHash: string): void {
    this.activeTorrents.delete(infoHash);
    this.triedPeers.delete(infoHash);

    // Remove from connection queue
    this.connectionQueue = this.connectionQueue.filter(item => item.infoHash !== infoHash);

    console.log(`[PeerInjector] Stopped tracking: ${infoHash.substring(0, 16)}...`);

    // Stop timer if no more active torrents
    if (this.activeTorrents.size === 0 && this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = null;
    }
  }

  /**
   * Discover peers from all sources for a torrent
   */
  async discoverPeers(infoHash: string): Promise<void> {
    const discoveries: Promise<void>[] = [];

    // Announce to I2P trackers
    if (this.localDestination) {
      discoveries.push(
        this.multiTracker.announceAll(infoHash, 'started', {
          uploaded: 0,
          downloaded: 0,
          left: 0
        }).then(() => {}).catch(err => {
          console.warn(`[PeerInjector] Tracker announce failed: ${err.message}`);
        })
      );
    }

    // Query I2P DHT
    if (this.dhtEngine) {
      discoveries.push(
        this._discoverFromDHT(infoHash).catch(err => {
          console.warn(`[PeerInjector] DHT discovery failed: ${err.message}`);
        })
      );
    }

    await Promise.allSettled(discoveries);
  }

  /**
   * Discover peers from DHT
   */
  private async _discoverFromDHT(infoHash: string): Promise<void> {
    if (!this.dhtEngine) return;

    console.log(`[PeerInjector] Querying DHT for ${infoHash.substring(0, 16)}...`);
    const peers = await this.dhtEngine.getPeers(infoHash, 30000);

    if (peers.length > 0) {
      console.log(`[PeerInjector] DHT found ${peers.length} peers`);
      for (const destination of peers) {
        this._queuePeer(infoHash, destination, 'dht');
      }
    }
  }

  /**
   * Queue a peer for connection
   */
  private _queuePeer(infoHash: string, destination: string, source: 'tracker' | 'dht'): void {
    // Skip self
    if (destination === this.localDestination) return;

    // Skip if not tracking this torrent
    if (!this.activeTorrents.has(infoHash)) return;

    // Skip if already tried
    const tried = this.triedPeers.get(infoHash);
    if (tried?.has(destination)) return;

    // Emit discovery event
    this.emit('peer-discovered', infoHash, destination, source);

    // Add to queue
    this.connectionQueue.push({ infoHash, destination });

    // Process queue
    this._processQueue();
  }

  /**
   * Process connection queue
   */
  private async _processQueue(): Promise<void> {
    if (this.isProcessingQueue) return;
    this.isProcessingQueue = true;

    while (this.connectionQueue.length > 0) {
      const item = this.connectionQueue.shift();
      if (!item) break;

      const { infoHash, destination } = item;

      // Skip if torrent no longer active
      if (!this.activeTorrents.has(infoHash)) continue;

      // Skip if already tried
      const tried = this.triedPeers.get(infoHash);
      if (tried?.has(destination)) continue;

      // Mark as tried (with memory bound)
      if (tried) {
        tried.add(destination);
        // Enforce memory limit - remove oldest entries if over limit
        if (tried.size > this.config.maxTriedPeersPerTorrent) {
          const iterator = tried.values();
          // Remove first (oldest) 10% of entries
          const toRemove = Math.ceil(tried.size * 0.1);
          for (let i = 0; i < toRemove; i++) {
            const oldest = iterator.next().value;
            if (oldest) tried.delete(oldest);
          }
        }
      }

      // Attempt connection
      try {
        const success = await this.client.addI2PPeer(infoHash, destination);

        if (success) {
          this.emit('peer-connected', infoHash, destination);
        } else {
          this.emit('peer-failed', infoHash, destination, 'Connection failed');
        }
      } catch (error: any) {
        this.emit('peer-failed', infoHash, destination, error.message);
      }

      // Small delay between connections to avoid overwhelming I2P
      if (this.connectionQueue.length > 0) {
        await this._delay(this.config.connectionDelay);
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Announce ourselves for a specific torrent
   */
  async announceSelf(infoHash: string): Promise<void> {
    if (!this.localDestination) return;

    console.log(`[PeerInjector] Announcing self for ${infoHash.substring(0, 16)}...`);

    // Announce to trackers
    try {
      await this.multiTracker.announceAll(infoHash, 'started');
    } catch (err: any) {
      console.warn(`[PeerInjector] Tracker self-announce failed: ${err.message}`);
    }

    // Announce to DHT
    if (this.dhtEngine) {
      try {
        await this.dhtEngine.announcePeer(infoHash);
      } catch (err: any) {
        console.warn(`[PeerInjector] DHT self-announce failed: ${err.message}`);
      }
    }
  }

  /**
   * Start periodic re-announce timer
   */
  private _startReannounceTimer(): void {
    this.reannounceTimer = setInterval(() => {
      for (const infoHash of this.activeTorrents) {
        this.discoverPeers(infoHash).catch(() => {});
      }
    }, this.config.reannounceInterval);
  }

  /**
   * Manually add a peer to inject
   */
  async addPeer(infoHash: string, destination: string): Promise<boolean> {
    if (!this.activeTorrents.has(infoHash)) {
      console.warn(`[PeerInjector] Cannot add peer: torrent not active`);
      return false;
    }

    const tried = this.triedPeers.get(infoHash);
    if (tried?.has(destination)) {
      return false; // Already tried
    }

    tried?.add(destination);
    return this.client.addI2PPeer(infoHash, destination);
  }

  /**
   * Get statistics for a torrent
   */
  getStats(infoHash: string): { tried: number; queued: number } {
    const tried = this.triedPeers.get(infoHash);
    const queued = this.connectionQueue.filter(item => item.infoHash === infoHash).length;

    return {
      tried: tried?.size || 0,
      queued
    };
  }

  /**
   * Get all statistics
   */
  getAllStats(): {
    activeTorrents: number;
    totalTried: number;
    queueLength: number;
  } {
    let totalTried = 0;
    for (const tried of this.triedPeers.values()) {
      totalTried += tried.size;
    }

    return {
      activeTorrents: this.activeTorrents.size,
      totalTried,
      queueLength: this.connectionQueue.length
    };
  }

  /**
   * Clear tried peers for a torrent (allows retry)
   */
  clearTriedPeers(infoHash: string): void {
    this.triedPeers.delete(infoHash);
    this.triedPeers.set(infoHash, new Set());
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.reannounceTimer) {
      clearInterval(this.reannounceTimer);
      this.reannounceTimer = null;
    }

    // Remove listeners from external event emitters to prevent memory leaks
    if (this.trackerPeersHandler) {
      this.multiTracker.off('peers-found', this.trackerPeersHandler);
      this.trackerPeersHandler = null;
    }

    if (this.dhtPeerHandler && this.dhtEngine) {
      this.dhtEngine.off('peer:announced', this.dhtPeerHandler);
      this.dhtPeerHandler = null;
    }

    this.activeTorrents.clear();
    this.triedPeers.clear();
    this.connectionQueue = [];
    this.removeAllListeners();

    console.log('[PeerInjector] Cleaned up');
  }

  /**
   * Helper: delay
   */
  private _delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Create a new peer injector instance
 */
export function createPeerInjector(
  client: WebTorrentI2PClient,
  multiTracker: MultiTrackerManager,
  config?: Partial<PeerInjectorConfig>
): I2PPeerInjector {
  return new I2PPeerInjector(client, multiTracker, config);
}
