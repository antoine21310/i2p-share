/**
 * Multi-Tracker Manager
 *
 * Manages multiple BitTorrent trackers for redundancy and resilience.
 * - Announces to ALL configured trackers in parallel
 * - Aggregates and deduplicates peers from all sources
 * - Discovers new trackers via DHT
 * - Provides fallback when trackers go down
 */

import { toB32 } from '@diva.exchange/i2p-sam';
import { EventEmitter } from 'events';
import {
    TrackerPeer
} from '../../shared/torrent-types.js';
import { BTTrackerClient, createBTTrackerClient } from './bt-tracker-client.js';

/**
 * Tracker status
 */
export interface TrackerStatus {
  destination: string;
  b32Address: string;
  isOnline: boolean;
  lastSuccess: number;
  lastError: string | null;
  failCount: number;
  announceInterval: number;
}

/**
 * Aggregated announce result
 */
export interface MultiAnnounceResult {
  success: boolean;
  totalPeers: number;
  peers: TrackerPeer[];
  trackersQueried: number;
  trackersSucceeded: number;
  errors: Array<{ tracker: string; error: string }>;
}

/**
 * Aggregated scrape result
 */
export interface MultiScrapeResult {
  success: boolean;
  complete: number;
  incomplete: number;
  downloaded: number;
  trackersQueried: number;
  trackersSucceeded: number;
}

/**
 * Multi-Tracker Manager Events
 */
export interface MultiTrackerManagerEvents {
  'tracker-added': (destination: string) => void;
  'tracker-removed': (destination: string) => void;
  'tracker-online': (destination: string) => void;
  'tracker-offline': (destination: string, error: string) => void;
  'peers-found': (infoHash: string, peers: TrackerPeer[]) => void;
  'tracker-discovered': (destination: string, source: string) => void;
}

/**
 * Multi-Tracker Manager Configuration
 */
export interface MultiTrackerManagerConfig {
  /** SAM host */
  samHost: string;
  /** SAM TCP port */
  samPortTCP: number;
  /** Request timeout (ms) */
  requestTimeout: number;
  /** Max retries per tracker before marking offline */
  maxRetries: number;
  /** Retry delay (ms) */
  retryDelay: number;
  /** DHT key for tracker discovery */
  dhtTrackerKey: string;
  /** Announce to all trackers in parallel */
  parallelAnnounce: boolean;
}

const DEFAULT_CONFIG: MultiTrackerManagerConfig = {
  samHost: '127.0.0.1',
  samPortTCP: 7656,
  requestTimeout: 60000,
  maxRetries: 3,
  retryDelay: 5000,
  dhtTrackerKey: 'i2p-share-trackers',
  parallelAnnounce: true
};

/**
 * Multi-Tracker Manager
 *
 * Coordinates multiple BitTorrent trackers for maximum peer discovery.
 */
export class MultiTrackerManager extends EventEmitter {
  private config: MultiTrackerManagerConfig;
  private trackers: Map<string, TrackerStatus> = new Map();
  private client: BTTrackerClient;
  private localDestination: string = '';
  private discoveredTrackers: Set<string> = new Set();

  /** Pending announce timers by infoHash */
  private announceTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: Partial<MultiTrackerManagerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Create underlying tracker client
    this.client = createBTTrackerClient({
      samHost: this.config.samHost,
      samPortTCP: this.config.samPortTCP,
      requestTimeout: this.config.requestTimeout
    });

    // Forward events from underlying client
    this.client.on('peers-found', (infoHash, peers) => {
      this.emit('peers-found', infoHash, peers);
    });
  }

  /**
   * Set our I2P destination
   */
  setLocalDestination(destination: string): void {
    this.localDestination = destination;
    this.client.setLocalDestination(destination);
  }

  /**
   * Add a tracker by destination
   */
  addTracker(destination: string): boolean {
    if (this.trackers.has(destination)) {
      return false;
    }

    const status: TrackerStatus = {
      destination,
      b32Address: toB32(destination),
      isOnline: true, // Assume online until proven otherwise
      lastSuccess: 0,
      lastError: null,
      failCount: 0,
      announceInterval: 1800 // Default 30 minutes
    };

    this.trackers.set(destination, status);
    this.emit('tracker-added', destination);

    console.log(`[MultiTracker] Added tracker: ${status.b32Address.substring(0, 16)}...`);
    return true;
  }

  /**
   * Remove a tracker
   */
  removeTracker(destination: string): boolean {
    if (!this.trackers.has(destination)) {
      return false;
    }

    this.trackers.delete(destination);
    this.emit('tracker-removed', destination);

    console.log(`[MultiTracker] Removed tracker: ${destination.substring(0, 30)}...`);
    return true;
  }

  /**
   * Set trackers (replaces all existing trackers)
   */
  setTrackers(destinations: string[]): void {
    this.trackers.clear();
    for (const dest of destinations) {
      if (dest && dest.trim().length > 0) {
        this.addTracker(dest.trim());
      }
    }
  }

  /**
   * Get list of configured trackers
   */
  getTrackers(): TrackerStatus[] {
    return Array.from(this.trackers.values());
  }

  /**
   * Get online trackers only
   */
  getOnlineTrackers(): TrackerStatus[] {
    return Array.from(this.trackers.values()).filter(t => t.isOnline);
  }

  /**
   * Announce to ALL trackers in parallel
   */
  async announceAll(
    infoHash: string,
    event?: 'started' | 'completed' | 'stopped',
    stats?: { uploaded: number; downloaded: number; left: number }
  ): Promise<MultiAnnounceResult> {
    const trackerList = Array.from(this.trackers.values());

    if (trackerList.length === 0) {
      console.log('[MultiTracker] No trackers configured');
      return {
        success: false,
        totalPeers: 0,
        peers: [],
        trackersQueried: 0,
        trackersSucceeded: 0,
        errors: []
      };
    }

    console.log(`[MultiTracker] Announcing ${infoHash.substring(0, 16)}... to ${trackerList.length} trackers`);

    // Announce to all trackers in parallel
    const allPeers = new Map<string, TrackerPeer>();
    const errors: Array<{ tracker: string; error: string }> = [];
    let trackersSucceeded = 0;
    let minInterval = Infinity;

    const announcePromises = trackerList.map(async (tracker) => {
      try {
        // Create a temporary client for this tracker
        this.client.setTrackers([tracker.destination]);

        const response = await this.client.announce(infoHash, event, stats);

        if (response) {
          trackersSucceeded++;
          tracker.isOnline = true;
          tracker.lastSuccess = Date.now();
          tracker.lastError = null;
          tracker.failCount = 0;

          if (response.interval) {
            tracker.announceInterval = response.interval;
            minInterval = Math.min(minInterval, response.interval);
          }

          // Collect peers
          for (const peer of response.peers) {
            if (peer.destination !== this.localDestination) {
              allPeers.set(peer.destination, peer);
            }
          }

          this.emit('tracker-online', tracker.destination);
          console.log(`[MultiTracker] ${tracker.b32Address.substring(0, 16)}...: ${response.peers.length} peers`);
        }
      } catch (error: any) {
        tracker.failCount++;

        if (tracker.failCount >= this.config.maxRetries) {
          tracker.isOnline = false;
          this.emit('tracker-offline', tracker.destination, error.message);
        }

        tracker.lastError = error.message;
        errors.push({ tracker: tracker.b32Address, error: error.message });

        console.log(`[MultiTracker] ${tracker.b32Address.substring(0, 16)}...: FAILED - ${error.message}`);
      }
    });

    await Promise.allSettled(announcePromises);

    // Schedule next announce based on minimum interval
    if (event !== 'stopped' && minInterval !== Infinity) {
      this.scheduleReannounce(infoHash, minInterval, stats);
    }

    const peers = Array.from(allPeers.values());

    if (peers.length > 0) {
      this.emit('peers-found', infoHash, peers);
    }

    return {
      success: trackersSucceeded > 0,
      totalPeers: peers.length,
      peers,
      trackersQueried: trackerList.length,
      trackersSucceeded,
      errors
    };
  }

  /**
   * Scrape all trackers for torrent info
   */
  async scrapeAll(infoHashes: string[]): Promise<Map<string, MultiScrapeResult>> {
    const results = new Map<string, MultiScrapeResult>();
    const trackerList = Array.from(this.trackers.values()).filter(t => t.isOnline);

    if (trackerList.length === 0) {
      console.log('[MultiTracker] No online trackers for scrape');
      return results;
    }

    // Initialize results
    for (const hash of infoHashes) {
      results.set(hash, {
        success: false,
        complete: 0,
        incomplete: 0,
        downloaded: 0,
        trackersQueried: trackerList.length,
        trackersSucceeded: 0
      });
    }

    // Scrape all trackers in parallel
    const scrapePromises = trackerList.map(async (tracker) => {
      try {
        this.client.setTrackers([tracker.destination]);
        const scrapeResult = await this.client.scrape(infoHashes);

        if (scrapeResult) {
          tracker.lastSuccess = Date.now();

          for (const [hash, info] of scrapeResult) {
            const existing = results.get(hash);
            if (existing) {
              existing.success = true;
              existing.complete = Math.max(existing.complete, info.complete);
              existing.incomplete = Math.max(existing.incomplete, info.incomplete);
              existing.downloaded = Math.max(existing.downloaded, info.downloaded);
              existing.trackersSucceeded++;
            }
          }
        }
      } catch (error: any) {
        tracker.failCount++;
        console.log(`[MultiTracker] Scrape failed on ${tracker.b32Address.substring(0, 16)}...: ${error.message}`);
      }
    });

    await Promise.allSettled(scrapePromises);

    return results;
  }

  /**
   * Schedule re-announce for a torrent
   */
  private scheduleReannounce(
    infoHash: string,
    intervalSeconds: number,
    stats?: { uploaded: number; downloaded: number; left: number }
  ): void {
    // Clear existing timer
    const existingTimer = this.announceTimers.get(infoHash);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule new announce
    const timer = setTimeout(() => {
      this.announceAll(infoHash, undefined, stats);
    }, intervalSeconds * 1000);

    this.announceTimers.set(infoHash, timer);

    console.log(`[MultiTracker] Next announce for ${infoHash.substring(0, 16)}... in ${intervalSeconds}s`);
  }

  /**
   * Stop announcing a torrent
   */
  async stopAnnounce(infoHash: string): Promise<void> {
    // Clear timer
    const timer = this.announceTimers.get(infoHash);
    if (timer) {
      clearTimeout(timer);
      this.announceTimers.delete(infoHash);
    }

    // Send stopped event to all trackers
    await this.announceAll(infoHash, 'stopped');
  }

  /**
   * Discover trackers via DHT
   *
   * Uses a special DHT key to find other trackers in the network.
   * This enables automatic tracker discovery without manual configuration.
   */
  async discoverTrackers(dhtEngine: any): Promise<string[]> {
    if (!dhtEngine) {
      console.log('[MultiTracker] No DHT engine available for tracker discovery');
      return [];
    }

    console.log(`[MultiTracker] Discovering trackers via DHT key: ${this.config.dhtTrackerKey}`);

    try {
      // Look up the special tracker discovery key
      const trackerHash = dhtEngine.hashQuery(this.config.dhtTrackerKey);
      const discoveredDests = await dhtEngine.getPeers(trackerHash, 15000);

      const newTrackers: string[] = [];

      for (const dest of discoveredDests) {
        if (!this.trackers.has(dest) && !this.discoveredTrackers.has(dest)) {
          this.discoveredTrackers.add(dest);
          this.addTracker(dest);
          newTrackers.push(dest);
          this.emit('tracker-discovered', dest, 'dht');
        }
      }

      if (newTrackers.length > 0) {
        console.log(`[MultiTracker] Discovered ${newTrackers.length} new trackers via DHT`);
      }

      return newTrackers;
    } catch (error: any) {
      console.log(`[MultiTracker] DHT discovery failed: ${error.message}`);
      return [];
    }
  }

  /**
   * Announce our tracker to DHT for discovery by others
   *
   * Called by EmbeddedTracker to make itself discoverable
   */
  async announceTrackerToDHT(dhtEngine: any, trackerDestination: string): Promise<void> {
    if (!dhtEngine) {
      console.log('[MultiTracker] No DHT engine available for tracker announcement');
      return;
    }

    console.log(`[MultiTracker] Announcing tracker to DHT: ${toB32(trackerDestination).substring(0, 16)}...`);

    try {
      const trackerHash = dhtEngine.hashQuery(this.config.dhtTrackerKey);
      await dhtEngine.announcePeer(trackerHash);

      console.log('[MultiTracker] Tracker announced to DHT successfully');
    } catch (error: any) {
      console.log(`[MultiTracker] Failed to announce tracker to DHT: ${error.message}`);
    }
  }

  /**
   * Get tracker statistics
   */
  getStats(): {
    totalTrackers: number;
    onlineTrackers: number;
    offlineTrackers: number;
    discoveredTrackers: number;
  } {
    const trackers = Array.from(this.trackers.values());

    return {
      totalTrackers: trackers.length,
      onlineTrackers: trackers.filter(t => t.isOnline).length,
      offlineTrackers: trackers.filter(t => !t.isOnline).length,
      discoveredTrackers: this.discoveredTrackers.size
    };
  }

  /**
   * Reset a tracker's fail count (mark as online)
   */
  resetTracker(destination: string): void {
    const tracker = this.trackers.get(destination);
    if (tracker) {
      tracker.isOnline = true;
      tracker.failCount = 0;
      tracker.lastError = null;
      this.emit('tracker-online', destination);
    }
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    // Clear all announce timers
    for (const timer of this.announceTimers.values()) {
      clearTimeout(timer);
    }
    this.announceTimers.clear();

    // Cleanup underlying client
    this.client.cleanup();

    // Clear trackers
    this.trackers.clear();
    this.discoveredTrackers.clear();

    this.removeAllListeners();
  }
}

/**
 * Create a new MultiTrackerManager instance
 */
export function createMultiTrackerManager(
  config?: Partial<MultiTrackerManagerConfig>
): MultiTrackerManager {
  return new MultiTrackerManager(config);
}
