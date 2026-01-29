/**
 * BitTorrent Tracker Client (BEP3)
 *
 * HTTP tracker protocol over I2P Streaming.
 * Handles announce and scrape requests.
 */

import { createStream, I2pSamStream, toB32 } from '@diva.exchange/i2p-sam';
import bencode from 'bencode';
import { EventEmitter } from 'events';
import {
    AnnounceRequest,
    AnnounceResponse,
    ScrapeInfo,
    TrackerPeer
} from '../../shared/torrent-types.js';
import { TorrentFileUtils } from './torrent-file.js';

/**
 * Tracker client events
 */
export interface BTTrackerClientEvents {
  'announce-response': (infoHash: string, response: AnnounceResponse) => void;
  'scrape-response': (results: Map<string, ScrapeInfo>) => void;
  'peers-found': (infoHash: string, peers: TrackerPeer[]) => void;
  'error': (error: Error) => void;
}

/**
 * Tracker client configuration
 */
export interface BTTrackerClientConfig {
  /** SAM host */
  samHost: string;
  /** SAM TCP port */
  samPortTCP: number;
  /** Connection timeout (seconds) */
  timeout: number;
  /** Request timeout (ms) */
  requestTimeout: number;
  /** Default number of peers to request */
  numwant: number;
}

const DEFAULT_CONFIG: BTTrackerClientConfig = {
  samHost: '127.0.0.1',
  samPortTCP: 7656,
  timeout: 120,
  requestTimeout: 60000,
  numwant: 50
};

/**
 * Torrent being tracked
 */
interface TrackedTorrent {
  infoHash: string;
  uploaded: number;
  downloaded: number;
  left: number;
  announceTimer: NodeJS.Timeout | null;
  interval: number;
}

/**
 * BitTorrent Tracker Client
 *
 * Implements BEP3 HTTP tracker protocol over I2P streaming connections.
 */
export class BTTrackerClient extends EventEmitter {
  private config: BTTrackerClientConfig;
  private peerId: Buffer;

  /** Our I2P destination */
  private localDestination: string = '';

  /** Tracked torrents by infoHash */
  private torrents: Map<string, TrackedTorrent> = new Map();

  /** Tracker destinations */
  private trackers: string[] = [];

  constructor(config: Partial<BTTrackerClientConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.peerId = TorrentFileUtils.generatePeerId();
  }

  /**
   * Set our I2P destination
   */
  setLocalDestination(destination: string): void {
    this.localDestination = destination;
  }

  /**
   * Set tracker destinations
   */
  setTrackers(trackers: string[]): void {
    this.trackers = trackers.filter(t => t && t.length > 0);
  }

  /**
   * Add a tracker
   */
  addTracker(destination: string): void {
    if (!this.trackers.includes(destination)) {
      this.trackers.push(destination);
    }
  }

  /**
   * Announce to tracker
   */
  async announce(
    infoHash: string,
    event?: 'started' | 'completed' | 'stopped',
    stats?: { uploaded: number; downloaded: number; left: number }
  ): Promise<AnnounceResponse | null> {
    if (this.trackers.length === 0) {
      console.log('[BTTrackerClient] No trackers configured');
      return null;
    }

    if (!this.localDestination) {
      console.log('[BTTrackerClient] Local destination not set');
      return null;
    }

    // Get or create tracked torrent
    let torrent = this.torrents.get(infoHash);
    if (!torrent) {
      torrent = {
        infoHash,
        uploaded: 0,
        downloaded: 0,
        left: stats?.left || 0,
        announceTimer: null,
        interval: 1800 // Default 30 minutes
      };
      this.torrents.set(infoHash, torrent);
    }

    // Update stats
    if (stats) {
      torrent.uploaded = stats.uploaded;
      torrent.downloaded = stats.downloaded;
      torrent.left = stats.left;
    }

    // Build announce request
    const request: AnnounceRequest = {
      info_hash: infoHash,
      peer_id: this.peerId.toString('hex'),
      port: this.localDestination, // In I2P, we use destination instead of port
      uploaded: torrent.uploaded,
      downloaded: torrent.downloaded,
      left: torrent.left,
      event: event || '',
      compact: 0, // We want full destinations
      numwant: this.config.numwant
    };

    // Try each tracker
    for (const tracker of this.trackers) {
      try {
        const response = await this.sendAnnounce(tracker, request);
        if (response) {
          // Schedule next announce
          if (response.interval && event !== 'stopped') {
            torrent.interval = response.interval;
            this.scheduleReannounce(infoHash);
          }

          this.emit('announce-response', infoHash, response);

          if (response.peers.length > 0) {
            this.emit('peers-found', infoHash, response.peers);
          }

          return response;
        }
      } catch (error: any) {
        console.error(`[BTTrackerClient] Announce to ${toB32(tracker).substring(0, 16)}... failed:`, error.message);
      }
    }

    return null;
  }

  /**
   * Send announce request to a tracker
   */
  private async sendAnnounce(
    trackerDest: string,
    request: AnnounceRequest
  ): Promise<AnnounceResponse | null> {
    return new Promise(async (resolve, reject) => {
      let stream: I2pSamStream | null = null;
      let timeout: NodeJS.Timeout | null = null;

      try {
        // Create streaming connection
        stream = await createStream({
          sam: {
            host: this.config.samHost,
            portTCP: this.config.samPortTCP,
            timeout: this.config.timeout
          },
          stream: {
            destination: trackerDest
          }
        });

        // Set request timeout
        timeout = setTimeout(() => {
          if (stream) {
            stream.close();
          }
          reject(new Error('Request timeout'));
        }, this.config.requestTimeout);

        // Build HTTP request
        const queryParams = new URLSearchParams();
        queryParams.append('info_hash', Buffer.from(request.info_hash, 'hex').toString('binary'));
        queryParams.append('peer_id', Buffer.from(request.peer_id, 'hex').toString('binary'));
        queryParams.append('port', request.port);
        queryParams.append('uploaded', request.uploaded.toString());
        queryParams.append('downloaded', request.downloaded.toString());
        queryParams.append('left', request.left.toString());
        if (request.event) {
          queryParams.append('event', request.event);
        }
        queryParams.append('compact', (request.compact || 0).toString());
        queryParams.append('numwant', (request.numwant || 50).toString());

        // Build HTTP request (simple GET)
        const httpRequest = `GET /announce?${queryParams.toString()} HTTP/1.1\r\n` +
          `Host: ${toB32(trackerDest)}\r\n` +
          `User-Agent: I2P-Share/1.0\r\n` +
          `Connection: close\r\n` +
          `\r\n`;

        // Collect response
        let responseBuffer = Buffer.alloc(0);

        stream.on('data', (data: Buffer) => {
          responseBuffer = Buffer.concat([responseBuffer, data]);
        });

        stream.on('error', (error: Error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        });

        stream.on('close', () => {
          if (timeout) clearTimeout(timeout);

          try {
            const response = this.parseHttpResponse(responseBuffer);
            resolve(response);
          } catch (error) {
            reject(error);
          }
        });

        // Send request
        stream.stream(Buffer.from(httpRequest, 'utf8'));

      } catch (error) {
        if (timeout) clearTimeout(timeout);
        if (stream) {
          try { stream.close(); } catch {}
        }
        reject(error);
      }
    });
  }

  /**
   * Parse HTTP response
   */
  private parseHttpResponse(data: Buffer): AnnounceResponse | null {
    const str = data.toString('utf8');

    // Find end of headers
    const headerEnd = str.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      throw new Error('Invalid HTTP response');
    }

    // Parse headers
    const headers = str.substring(0, headerEnd);
    const statusLine = headers.split('\r\n')[0];
    const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)/);

    if (!statusMatch || statusMatch[1] !== '200') {
      throw new Error(`HTTP error: ${statusLine}`);
    }

    // Parse body (bencoded)
    const bodyStart = headerEnd + 4;
    const body = data.slice(bodyStart);

    const decoded = bencode.decode(body) as any;

    // Check for failure
    if (decoded['failure reason']) {
      throw new Error(`Tracker error: ${decoded['failure reason'].toString()}`);
    }

    // Parse response
    const response: AnnounceResponse = {
      interval: decoded.interval || 1800,
      min_interval: decoded.min_interval,
      complete: decoded.complete || 0,
      incomplete: decoded.incomplete || 0,
      peers: [],
      warning_message: decoded['warning message']?.toString()
    };

    // Parse peers
    const peers = decoded.peers;
    if (Buffer.isBuffer(peers)) {
      // Compact format (not used in I2P)
      // Each peer is 6 bytes: 4 for IP, 2 for port
      // For I2P, this would be the full destination
      // We'll handle this case if needed
    } else if (Array.isArray(peers)) {
      // Dictionary format
      for (const peer of peers) {
        const destination = peer.destination?.toString() || peer.ip?.toString();
        if (destination && destination !== this.localDestination) {
          response.peers.push({
            destination,
            b32Address: toB32(destination)
          });
        }
      }
    }

    return response;
  }

  /**
   * Scrape tracker for torrent info
   */
  async scrape(infoHashes: string[]): Promise<Map<string, ScrapeInfo> | null> {
    if (this.trackers.length === 0 || infoHashes.length === 0) {
      return null;
    }

    // Try each tracker
    for (const tracker of this.trackers) {
      try {
        const response = await this.sendScrape(tracker, infoHashes);
        if (response) {
          this.emit('scrape-response', response);
          return response;
        }
      } catch (error: any) {
        console.error(`[BTTrackerClient] Scrape failed:`, error.message);
      }
    }

    return null;
  }

  /**
   * Send scrape request to tracker
   */
  private async sendScrape(
    trackerDest: string,
    infoHashes: string[]
  ): Promise<Map<string, ScrapeInfo> | null> {
    return new Promise(async (resolve, reject) => {
      let stream: I2pSamStream | null = null;
      let timeout: NodeJS.Timeout | null = null;

      try {
        stream = await createStream({
          sam: {
            host: this.config.samHost,
            portTCP: this.config.samPortTCP,
            timeout: this.config.timeout
          },
          stream: {
            destination: trackerDest
          }
        });

        timeout = setTimeout(() => {
          if (stream) stream.close();
          reject(new Error('Request timeout'));
        }, this.config.requestTimeout);

        // Build query string
        const queryParts = infoHashes.map(h =>
          `info_hash=${encodeURIComponent(Buffer.from(h, 'hex').toString('binary'))}`
        );

        const httpRequest = `GET /scrape?${queryParts.join('&')} HTTP/1.1\r\n` +
          `Host: ${toB32(trackerDest)}\r\n` +
          `User-Agent: I2P-Share/1.0\r\n` +
          `Connection: close\r\n` +
          `\r\n`;

        let responseBuffer = Buffer.alloc(0);

        stream.on('data', (data: Buffer) => {
          responseBuffer = Buffer.concat([responseBuffer, data]);
        });

        stream.on('error', (error: Error) => {
          if (timeout) clearTimeout(timeout);
          reject(error);
        });

        stream.on('close', () => {
          if (timeout) clearTimeout(timeout);

          try {
            const response = this.parseScrapeResponse(responseBuffer);
            resolve(response);
          } catch (error) {
            reject(error);
          }
        });

        stream.stream(Buffer.from(httpRequest, 'utf8'));

      } catch (error) {
        if (timeout) clearTimeout(timeout);
        if (stream) {
          try { stream.close(); } catch {}
        }
        reject(error);
      }
    });
  }

  /**
   * Parse scrape response
   */
  private parseScrapeResponse(data: Buffer): Map<string, ScrapeInfo> | null {
    const str = data.toString('utf8');
    const headerEnd = str.indexOf('\r\n\r\n');
    if (headerEnd === -1) {
      throw new Error('Invalid HTTP response');
    }

    const body = data.slice(headerEnd + 4);
    const decoded = bencode.decode(body) as any;

    if (decoded['failure reason']) {
      throw new Error(`Tracker error: ${decoded['failure reason'].toString()}`);
    }

    const results = new Map<string, ScrapeInfo>();

    if (decoded.files) {
      for (const [hash, info] of Object.entries(decoded.files)) {
        const infoHash = Buffer.isBuffer(hash) ? hash.toString('hex') : hash;
        const infoData = info as any;

        results.set(infoHash, {
          complete: infoData.complete || 0,
          downloaded: infoData.downloaded || 0,
          incomplete: infoData.incomplete || 0,
          name: infoData.name?.toString()
        });
      }
    }

    return results;
  }

  /**
   * Start periodic announce for a torrent
   */
  startPeriodicAnnounce(infoHash: string): void {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return;

    // Initial announce
    this.announce(infoHash, 'started');
  }

  /**
   * Stop periodic announce for a torrent
   */
  async stopPeriodicAnnounce(infoHash: string): Promise<void> {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return;

    // Clear timer
    if (torrent.announceTimer) {
      clearTimeout(torrent.announceTimer);
      torrent.announceTimer = null;
    }

    // Send stopped event
    await this.announce(infoHash, 'stopped');

    this.torrents.delete(infoHash);
  }

  /**
   * Schedule next reannounce
   */
  private scheduleReannounce(infoHash: string): void {
    const torrent = this.torrents.get(infoHash);
    if (!torrent) return;

    // Clear existing timer
    if (torrent.announceTimer) {
      clearTimeout(torrent.announceTimer);
    }

    // Schedule next announce
    const interval = Math.max(torrent.interval, 60) * 1000; // Minimum 1 minute
    torrent.announceTimer = setTimeout(() => {
      this.announce(infoHash);
    }, interval);

    console.log(`[BTTrackerClient] Next announce for ${infoHash.substring(0, 16)}... in ${torrent.interval}s`);
  }

  /**
   * Update stats for a torrent
   */
  updateStats(
    infoHash: string,
    uploaded: number,
    downloaded: number,
    left: number
  ): void {
    let torrent = this.torrents.get(infoHash);
    if (!torrent) {
      torrent = {
        infoHash,
        uploaded: 0,
        downloaded: 0,
        left,
        announceTimer: null,
        interval: 1800
      };
      this.torrents.set(infoHash, torrent);
    }

    torrent.uploaded = uploaded;
    torrent.downloaded = downloaded;
    torrent.left = left;
  }

  /**
   * Announce completion
   */
  async announceComplete(infoHash: string): Promise<void> {
    await this.announce(infoHash, 'completed');
  }

  /**
   * Get tracked torrents
   */
  getTrackedTorrents(): string[] {
    return Array.from(this.torrents.keys());
  }

  /**
   * Cleanup
   */
  cleanup(): void {
    // Clear all announce timers
    for (const torrent of this.torrents.values()) {
      if (torrent.announceTimer) {
        clearTimeout(torrent.announceTimer);
      }
    }
    this.torrents.clear();
    this.removeAllListeners();
  }
}

/**
 * Create a new tracker client
 */
export function createBTTrackerClient(config?: Partial<BTTrackerClientConfig>): BTTrackerClient {
  return new BTTrackerClient(config);
}
