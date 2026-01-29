/**
 * Embedded Tracker
 *
 * Wrapper around TrackerServer that can be enabled/disabled via settings.
 * - Runs a full BitTorrent tracker inside the client
 * - Announces itself to DHT for automatic discovery
 * - Provides peer discovery service to other clients
 */

import { EventEmitter } from 'events';
import path from 'path';

// Get electron from global (set by bootstrap.cjs)
const electron = (globalThis as any).__electron;
const { app } = electron;
import { TrackerServer } from '../../tracker/tracker-server.js';

/**
 * Embedded Tracker Configuration
 */
export interface EmbeddedTrackerConfig {
  /** Enable the embedded tracker */
  enabled: boolean;
  /** SAM host */
  samHost: string;
  /** SAM TCP port */
  samPortTCP: number;
  /** SAM UDP port */
  samPortUDP: number;
  /** Datagram listen port */
  listenPort: number;
  /** HTTP tracker port */
  httpTrackerPort: number;
  /** Data directory for tracker storage */
  dataDir: string;
  /** Peer timeout (ms) */
  peerTimeout: number;
  /** Announce self to DHT for discovery */
  announceToDiscovery: boolean;
  /** DHT key for tracker discovery */
  dhtDiscoveryKey: string;
}

const DEFAULT_CONFIG: EmbeddedTrackerConfig = {
  enabled: true,
  samHost: '127.0.0.1',
  samPortTCP: 7656,
  samPortUDP: 7655,
  listenPort: 7675,
  httpTrackerPort: 7685,
  dataDir: '',
  peerTimeout: 5 * 60 * 1000,
  announceToDiscovery: true,
  dhtDiscoveryKey: 'i2p-share-trackers'
};

/**
 * Embedded Tracker State
 */
export interface EmbeddedTrackerState {
  isRunning: boolean;
  b32Address: string | null;
  btTrackerB32: string | null;
  destination: string | null;
  btTrackerDestination: string | null;
  peersCount: number;
  torrentsCount: number;
  startedAt: number | null;
  error: string | null;
}

/**
 * Embedded Tracker Events
 */
export interface EmbeddedTrackerEvents {
  'started': (state: EmbeddedTrackerState) => void;
  'stopped': () => void;
  'error': (error: Error) => void;
  'peer-connected': (destination: string) => void;
  'peer-disconnected': (destination: string) => void;
  'stats-update': (stats: { peersCount: number; torrentsCount: number }) => void;
}

/**
 * Embedded Tracker
 *
 * Allows any I2P Share client to become a tracker for the network.
 */
export class EmbeddedTracker extends EventEmitter {
  private config: EmbeddedTrackerConfig;
  private tracker: TrackerServer | null = null;
  private state: EmbeddedTrackerState;
  private dhtEngine: any = null;
  private discoveryTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<EmbeddedTrackerConfig> = {}) {
    super();

    // Set default data directory
    const defaultDataDir = app?.getPath('userData')
      ? path.join(app.getPath('userData'), 'embedded-tracker')
      : path.join(process.cwd(), 'embedded-tracker-data');

    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      dataDir: config.dataDir || defaultDataDir
    };

    this.state = {
      isRunning: false,
      b32Address: null,
      btTrackerB32: null,
      destination: null,
      btTrackerDestination: null,
      peersCount: 0,
      torrentsCount: 0,
      startedAt: null,
      error: null
    };
  }

  /**
   * Start the embedded tracker
   */
  async start(): Promise<boolean> {
    if (!this.config.enabled) {
      console.log('[EmbeddedTracker] Tracker is disabled in settings');
      return false;
    }

    if (this.state.isRunning) {
      console.log('[EmbeddedTracker] Already running');
      return true;
    }

    console.log('[EmbeddedTracker] Starting embedded tracker...');

    try {
      // Create tracker server
      this.tracker = new TrackerServer({
        samHost: this.config.samHost,
        samPortTCP: this.config.samPortTCP,
        samPortUDP: this.config.samPortUDP,
        listenPort: this.config.listenPort,
        httpTrackerPort: this.config.httpTrackerPort,
        dataDir: this.config.dataDir,
        peerTimeout: this.config.peerTimeout,
        enableBTTracker: true
      });

      // Forward tracker events to allow main process to handle peer notifications
      this.tracker.on('peer:connected', (peer: any) => {
        console.log(`[EmbeddedTracker] Peer connected: ${peer.b32Address?.substring(0, 16)}...`);
        this.emit('peer:connected', peer);
      });

      this.tracker.on('peer:updated', (peer: any) => {
        this.emit('peer:updated', peer);
      });

      // Start the tracker
      const result = await this.tracker.start();

      if (!result.success) {
        throw new Error(result.error || 'Failed to start tracker');
      }

      // Update state
      this.state = {
        isRunning: true,
        b32Address: result.b32Address || null,
        btTrackerB32: result.btTrackerB32 || null,
        destination: this.tracker.getDestination(),
        btTrackerDestination: this.tracker.getBTTrackerDestination() || null,
        peersCount: 0,
        torrentsCount: 0,
        startedAt: Date.now(),
        error: null
      };

      console.log('[EmbeddedTracker] Started successfully');
      console.log('[EmbeddedTracker] Peer Discovery B32:', this.state.b32Address);
      console.log('[EmbeddedTracker] BT Tracker B32:', this.state.btTrackerB32);

      // Start stats update timer
      this.startStatsTimer();

      // Announce to DHT for discovery
      if (this.config.announceToDiscovery && this.dhtEngine) {
        this.startDiscoveryAnnounce();
      }

      this.emit('started', this.state);
      return true;

    } catch (error: any) {
      console.error('[EmbeddedTracker] Failed to start:', error.message);
      this.state.error = error.message;
      this.emit('error', error);
      return false;
    }
  }

  /**
   * Stop the embedded tracker
   */
  async stop(): Promise<void> {
    if (!this.state.isRunning || !this.tracker) {
      return;
    }

    console.log('[EmbeddedTracker] Stopping...');

    // Stop timers
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }

    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }

    // Stop the tracker
    await this.tracker.stop();
    this.tracker = null;

    // Reset state
    this.state = {
      isRunning: false,
      b32Address: null,
      btTrackerB32: null,
      destination: null,
      btTrackerDestination: null,
      peersCount: 0,
      torrentsCount: 0,
      startedAt: null,
      error: null
    };

    this.emit('stopped');
    console.log('[EmbeddedTracker] Stopped');
  }

  /**
   * Restart the tracker (used when settings change)
   */
  async restart(): Promise<boolean> {
    await this.stop();
    return this.start();
  }

  /**
   * Set enabled state
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.config.enabled = enabled;

    if (enabled && !this.state.isRunning) {
      await this.start();
    } else if (!enabled && this.state.isRunning) {
      await this.stop();
    }
  }

  /**
   * Set DHT engine for discovery announcements
   */
  setDHTEngine(dhtEngine: any): void {
    this.dhtEngine = dhtEngine;

    // Start discovery announce if tracker is already running
    if (this.state.isRunning && this.config.announceToDiscovery) {
      this.startDiscoveryAnnounce();
    }
  }

  /**
   * Start periodic DHT announcements for tracker discovery
   */
  private startDiscoveryAnnounce(): void {
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
    }

    // Announce immediately
    this.announceToDiscovery();

    // Then announce every 10 minutes
    this.discoveryTimer = setInterval(() => {
      this.announceToDiscovery();
    }, 10 * 60 * 1000);
  }

  /**
   * Announce tracker to DHT for discovery
   */
  private async announceToDiscovery(): Promise<void> {
    if (!this.dhtEngine || !this.state.destination) {
      return;
    }

    console.log('[EmbeddedTracker] Announcing to DHT for discovery...');

    try {
      // Hash the discovery key
      const trackerHash = this.dhtEngine.hashQuery(this.config.dhtDiscoveryKey);

      // Announce as a peer for this hash
      // The destination is stored in the DHT for others to discover
      await this.dhtEngine.announcePeer(trackerHash);

      console.log('[EmbeddedTracker] Announced to DHT successfully');
    } catch (error: any) {
      console.log('[EmbeddedTracker] DHT announcement failed:', error.message);
    }
  }

  /**
   * Start stats update timer
   */
  private startStatsTimer(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
    }

    this.statsTimer = setInterval(() => {
      this.updateStats();
    }, 30000); // Every 30 seconds
  }

  /**
   * Update stats from tracker
   */
  private updateStats(): void {
    if (!this.tracker) return;

    const peerStats = this.tracker.getStats();
    const btStats = this.tracker.getBTTrackerStats();

    this.state.peersCount = peerStats.peersCount;
    this.state.torrentsCount = btStats?.torrents || 0;

    this.emit('stats-update', {
      peersCount: this.state.peersCount,
      torrentsCount: this.state.torrentsCount
    });
  }

  /**
   * Get current state
   */
  getState(): EmbeddedTrackerState {
    return { ...this.state };
  }

  /**
   * Get tracker configuration
   */
  getConfig(): EmbeddedTrackerConfig {
    return { ...this.config };
  }

  /**
   * Get tracker destinations (for sharing with others)
   */
  getDestinations(): {
    peerDiscovery: string | null;
    btTracker: string | null;
    peerDiscoveryB32: string | null;
    btTrackerB32: string | null;
  } {
    return {
      peerDiscovery: this.state.destination,
      btTracker: this.state.btTrackerDestination,
      peerDiscoveryB32: this.state.b32Address,
      btTrackerB32: this.state.btTrackerB32
    };
  }

  /**
   * Register the local host as a peer in the tracker
   * This allows other peers to discover the host when they connect to this tracker
   */
  registerLocalPeer(peer: {
    destination: string;
    b32Address: string;
    displayName: string;
    filesCount?: number;
    totalSize?: number;
    streamingDestination?: string;
    nodeId?: string;
  }): void {
    if (this.tracker) {
      this.tracker.registerLocalPeer(peer);
    }
  }

  /**
   * Get all active peers from the tracker
   * Used for synchronizing tracker peers to the main application database
   */
  getActivePeers(): Array<{
    destination: string;
    b32Address: string;
    displayName: string;
    filesCount: number;
    totalSize: number;
    streamingDestination?: string;
    lastSeen: number;
  }> {
    if (this.tracker) {
      return this.tracker.getActivePeers();
    }
    return [];
  }

  /**
   * Check if tracker is running
   */
  isRunning(): boolean {
    return this.state.isRunning;
  }

  /**
   * Check if tracker is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * Get statistics
   */
  getStats(): {
    isRunning: boolean;
    peersCount: number;
    torrentsCount: number;
    uptime: number;
    b32Address: string | null;
  } {
    return {
      isRunning: this.state.isRunning,
      peersCount: this.state.peersCount,
      torrentsCount: this.state.torrentsCount,
      uptime: this.state.startedAt ? Date.now() - this.state.startedAt : 0,
      b32Address: this.state.b32Address
    };
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    await this.stop();
    this.removeAllListeners();
  }
}

// Singleton instance
let embeddedTrackerInstance: EmbeddedTracker | null = null;

/**
 * Get or create the embedded tracker instance
 */
export function getEmbeddedTracker(config?: Partial<EmbeddedTrackerConfig>): EmbeddedTracker {
  if (!embeddedTrackerInstance) {
    embeddedTrackerInstance = new EmbeddedTracker(config);
  }
  return embeddedTrackerInstance;
}

/**
 * Create a new embedded tracker (for testing or multiple instances)
 */
export function createEmbeddedTracker(config?: Partial<EmbeddedTrackerConfig>): EmbeddedTracker {
  return new EmbeddedTracker(config);
}
