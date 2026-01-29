/**
 * BitTorrent Announce Handler (BEP3)
 *
 * Handles BEP3 announce requests for the tracker server.
 */

import bencode from 'bencode';

/**
 * Peer info stored for each torrent
 */
interface StoredPeer {
  destination: string;
  lastSeen: number;
  isSeeder: boolean;
  uploaded: number;
  downloaded: number;
}

/**
 * Torrent statistics
 */
interface TorrentStats {
  complete: number;   // Seeders
  incomplete: number; // Leechers
  downloaded: number; // Times completed
}

/**
 * Announce request parameters
 */
export interface AnnounceParams {
  info_hash: Buffer | string;
  peer_id: Buffer | string;
  port: string;  // I2P destination
  uploaded: number;
  downloaded: number;
  left: number;
  event?: 'started' | 'completed' | 'stopped' | '';
  compact?: number;
  numwant?: number;
}

/**
 * BitTorrent Announce Handler Configuration
 */
export interface BTAnnounceConfig {
  /** Announce interval in seconds */
  announceInterval: number;
  /** Minimum announce interval */
  minAnnounceInterval: number;
  /** Peer timeout in milliseconds */
  peerTimeout: number;
  /** Maximum peers to return */
  maxPeersPerResponse: number;
}

const DEFAULT_CONFIG: BTAnnounceConfig = {
  announceInterval: 1800,     // 30 minutes
  minAnnounceInterval: 60,    // 1 minute
  peerTimeout: 3600000,       // 1 hour
  maxPeersPerResponse: 50
};

/**
 * BitTorrent Announce Handler
 *
 * Stores and retrieves peer information for BitTorrent swarms.
 */
export class BTAnnounceHandler {
  private config: BTAnnounceConfig;
  /** Peers by infoHash -> destination -> peer info */
  private peers: Map<string, Map<string, StoredPeer>> = new Map();
  /** Torrent stats */
  private stats: Map<string, TorrentStats> = new Map();
  /** Cleanup timer */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<BTAnnounceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Start cleanup timer
    this.cleanupTimer = setInterval(() => {
      this.cleanupStalePeers();
    }, 60000); // Every minute
  }

  /**
   * Handle announce request
   */
  handleAnnounce(params: AnnounceParams, requesterDest?: string): Buffer {
    // Parse info_hash
    const infoHash = this.normalizeInfoHash(params.info_hash);
    if (!infoHash) {
      return this.encodeFailure('Invalid info_hash');
    }

    // Get peer destination (use port field or requester destination)
    const peerDest = params.port || requesterDest;
    if (!peerDest) {
      return this.encodeFailure('Missing peer destination');
    }

    // Get or create torrent peer map
    let torrentPeers = this.peers.get(infoHash);
    if (!torrentPeers) {
      torrentPeers = new Map();
      this.peers.set(infoHash, torrentPeers);
    }

    // Get or create torrent stats
    let torrentStats = this.stats.get(infoHash);
    if (!torrentStats) {
      torrentStats = { complete: 0, incomplete: 0, downloaded: 0 };
      this.stats.set(infoHash, torrentStats);
    }

    // Handle event
    const event = params.event || '';
    const isSeeder = params.left === 0;

    switch (event) {
      case 'started':
        // Add peer
        this.addPeer(torrentPeers, peerDest, isSeeder, params);
        this.updateStats(torrentStats, torrentPeers);
        break;

      case 'stopped':
        // Remove peer
        this.removePeer(torrentPeers, peerDest);
        this.updateStats(torrentStats, torrentPeers);
        break;

      case 'completed':
        // Peer completed download (became seeder)
        this.addPeer(torrentPeers, peerDest, true, params);
        torrentStats.downloaded++;
        this.updateStats(torrentStats, torrentPeers);
        break;

      default:
        // Regular announce - update peer
        this.addPeer(torrentPeers, peerDest, isSeeder, params);
        this.updateStats(torrentStats, torrentPeers);
    }

    // Get peers to return (exclude requester)
    const numwant = Math.min(params.numwant || 50, this.config.maxPeersPerResponse);
    const peerList = this.getPeerList(torrentPeers, peerDest, numwant);

    // Build response
    return this.encodeResponse(torrentStats, peerList);
  }

  /**
   * Handle scrape request
   */
  handleScrape(infoHashes: string[]): Buffer {
    const files: Record<string, any> = {};

    for (const infoHash of infoHashes) {
      const stats = this.stats.get(infoHash);
      if (stats) {
        files[infoHash] = {
          complete: stats.complete,
          downloaded: stats.downloaded,
          incomplete: stats.incomplete
        };
      } else {
        files[infoHash] = {
          complete: 0,
          downloaded: 0,
          incomplete: 0
        };
      }
    }

    return bencode.encode({ files });
  }

  /**
   * Normalize info_hash to hex string
   */
  private normalizeInfoHash(infoHash: Buffer | string): string | null {
    try {
      if (Buffer.isBuffer(infoHash)) {
        return infoHash.toString('hex');
      }
      if (typeof infoHash === 'string') {
        // Could be hex, binary, or URL-encoded
        if (infoHash.length === 40 && /^[0-9a-fA-F]+$/.test(infoHash)) {
          return infoHash.toLowerCase();
        }
        if (infoHash.length === 20) {
          return Buffer.from(infoHash, 'binary').toString('hex');
        }
        // Try URL decode
        const decoded = decodeURIComponent(infoHash);
        if (decoded.length === 20) {
          return Buffer.from(decoded, 'binary').toString('hex');
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Add or update peer
   */
  private addPeer(
    torrentPeers: Map<string, StoredPeer>,
    destination: string,
    isSeeder: boolean,
    params: AnnounceParams
  ): void {
    torrentPeers.set(destination, {
      destination,
      lastSeen: Date.now(),
      isSeeder,
      uploaded: params.uploaded,
      downloaded: params.downloaded
    });
  }

  /**
   * Remove peer
   */
  private removePeer(torrentPeers: Map<string, StoredPeer>, destination: string): void {
    torrentPeers.delete(destination);
  }

  /**
   * Update torrent statistics
   */
  private updateStats(stats: TorrentStats, peers: Map<string, StoredPeer>): void {
    let complete = 0;
    let incomplete = 0;

    for (const peer of peers.values()) {
      if (peer.isSeeder) {
        complete++;
      } else {
        incomplete++;
      }
    }

    stats.complete = complete;
    stats.incomplete = incomplete;
  }

  /**
   * Get peer list for response
   */
  private getPeerList(
    torrentPeers: Map<string, StoredPeer>,
    excludeDest: string,
    limit: number
  ): StoredPeer[] {
    const now = Date.now();
    const activePeers: StoredPeer[] = [];

    for (const peer of torrentPeers.values()) {
      if (peer.destination === excludeDest) continue;
      if (now - peer.lastSeen > this.config.peerTimeout) continue;
      activePeers.push(peer);
    }

    // Shuffle and limit
    this.shuffle(activePeers);
    return activePeers.slice(0, limit);
  }

  /**
   * Shuffle array in place
   */
  private shuffle<T>(array: T[]): void {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
  }

  /**
   * Encode success response
   */
  private encodeResponse(stats: TorrentStats, peers: StoredPeer[]): Buffer {
    const response: any = {
      interval: this.config.announceInterval,
      'min interval': this.config.minAnnounceInterval,
      complete: stats.complete,
      incomplete: stats.incomplete,
      peers: peers.map(p => ({
        destination: p.destination
      }))
    };

    return bencode.encode(response);
  }

  /**
   * Encode failure response
   */
  private encodeFailure(reason: string): Buffer {
    return bencode.encode({ 'failure reason': reason });
  }

  /**
   * Clean up stale peers
   */
  private cleanupStalePeers(): void {
    const now = Date.now();
    let removed = 0;

    for (const [infoHash, torrentPeers] of this.peers) {
      for (const [dest, peer] of torrentPeers) {
        if (now - peer.lastSeen > this.config.peerTimeout) {
          torrentPeers.delete(dest);
          removed++;
        }
      }

      if (torrentPeers.size === 0) {
        this.peers.delete(infoHash);
        this.stats.delete(infoHash);
      } else {
        // Update stats
        const stats = this.stats.get(infoHash);
        if (stats) {
          this.updateStats(stats, torrentPeers);
        }
      }
    }

    if (removed > 0) {
      console.log(`[BTAnnounceHandler] Cleaned up ${removed} stale peers`);
    }
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    torrents: number;
    totalPeers: number;
    totalSeeders: number;
    totalLeechers: number;
  } {
    let totalPeers = 0;
    let totalSeeders = 0;
    let totalLeechers = 0;

    for (const stats of this.stats.values()) {
      totalSeeders += stats.complete;
      totalLeechers += stats.incomplete;
      totalPeers += stats.complete + stats.incomplete;
    }

    return {
      torrents: this.peers.size,
      totalPeers,
      totalSeeders,
      totalLeechers
    };
  }

  /**
   * Get torrent list
   */
  getTorrentList(): Array<{ infoHash: string; stats: TorrentStats }> {
    const list: Array<{ infoHash: string; stats: TorrentStats }> = [];

    for (const [infoHash, stats] of this.stats) {
      list.push({ infoHash, stats: { ...stats } });
    }

    return list;
  }

  /**
   * Stop the handler
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.peers.clear();
    this.stats.clear();
  }
}

/**
 * Parse HTTP query string for announce
 */
export function parseAnnounceQuery(queryString: string): AnnounceParams | null {
  try {
    const params = new URLSearchParams(queryString);

    const infoHashRaw = params.get('info_hash');
    const peerIdRaw = params.get('peer_id');
    const port = params.get('port');

    if (!infoHashRaw || !peerIdRaw || !port) {
      return null;
    }

    return {
      info_hash: decodeURIComponent(infoHashRaw),
      peer_id: decodeURIComponent(peerIdRaw),
      port,
      uploaded: parseInt(params.get('uploaded') || '0', 10),
      downloaded: parseInt(params.get('downloaded') || '0', 10),
      left: parseInt(params.get('left') || '0', 10),
      event: (params.get('event') || '') as any,
      compact: parseInt(params.get('compact') || '0', 10),
      numwant: parseInt(params.get('numwant') || '50', 10)
    };
  } catch {
    return null;
  }
}

/**
 * Create HTTP response for announce
 */
export function createAnnounceHttpResponse(body: Buffer): string {
  const headers = [
    'HTTP/1.1 200 OK',
    'Content-Type: text/plain',
    `Content-Length: ${body.length}`,
    'Connection: close',
    '',
    ''
  ].join('\r\n');

  return headers;
}

/**
 * Create HTTP error response
 */
export function createErrorHttpResponse(statusCode: number, reason: string): string {
  const body = bencode.encode({ 'failure reason': reason });
  const headers = [
    `HTTP/1.1 ${statusCode} ${reason}`,
    'Content-Type: text/plain',
    `Content-Length: ${body.length}`,
    'Connection: close',
    '',
    ''
  ].join('\r\n');

  return headers + body.toString();
}
