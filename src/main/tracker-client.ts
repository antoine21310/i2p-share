import { EventEmitter } from 'events';
import { toB32 } from '@diva.exchange/i2p-sam';
import crypto from 'crypto';

interface TrackerPeer {
  destination: string;
  b32Address: string;
  displayName: string;
  filesCount: number;
  totalSize: number;
  streamingDestination?: string; // Destination for I2P streaming file transfers
}

interface TrackerMessage {
  type: 'ANNOUNCE' | 'GET_PEERS' | 'PEERS_LIST' | 'PING' | 'PONG';
  payload: any;
  timestamp: number;
  _from?: string;
}

interface TrackerClientConfig {
  trackerAddresses: string[]; // List of tracker addresses for redundancy
  announceInterval: number;
  refreshInterval: number;
  connectionTimeout: number;
}

// Default community trackers (can be overridden by user)
// Add your tracker addresses here as the community grows
export const DEFAULT_TRACKERS: string[] = [
  // Placeholder - replace with actual community tracker addresses
  // 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.b32.i2p',
];

export class TrackerClient extends EventEmitter {
  private config: TrackerClientConfig;
  private sendMessage: ((dest: string, msg: any) => Promise<boolean>) | null = null;
  private myDestination: string = '';
  private streamingDestination: string = ''; // Destination for streaming file server
  private displayName: string = 'I2P Share User';
  private filesCount: number = 0;
  private totalSize: number = 0;
  private announceTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private knownPeers: Map<string, TrackerPeer> = new Map();
  private isConnected: boolean = false;
  private activeTrackerIndex: number = -1;
  private failedTrackers: Set<number> = new Set();
  private lastResponseTime: Map<string, number> = new Map();

  constructor(config: Partial<TrackerClientConfig> = {}) {
    super();
    this.config = {
      trackerAddresses: config.trackerAddresses || [...DEFAULT_TRACKERS],
      announceInterval: config.announceInterval || 2 * 60 * 1000,
      refreshInterval: config.refreshInterval || 60 * 1000,
      connectionTimeout: config.connectionTimeout || 30 * 1000
    };
  }

  // Set tracker addresses (replaces the list)
  setTrackerAddresses(addresses: string[]): void {
    this.config.trackerAddresses = addresses.filter(a => a && a.trim().length > 0);
    console.log(`[TrackerClient] Set ${this.config.trackerAddresses.length} tracker(s)`);

    // Reset state
    this.activeTrackerIndex = -1;
    this.failedTrackers.clear();
  }

  // Add a single tracker address
  addTrackerAddress(address: string): void {
    if (address && !this.config.trackerAddresses.includes(address)) {
      this.config.trackerAddresses.push(address);
      console.log(`[TrackerClient] Added tracker: ${address.substring(0, 20)}...`);
    }
  }

  // Legacy method for single tracker
  setTrackerAddress(address: string): void {
    if (address && address.trim().length > 0) {
      // Add to list if not already present
      if (!this.config.trackerAddresses.includes(address)) {
        this.config.trackerAddresses.unshift(address); // Add to front (priority)
      }
    }
  }

  getTrackerAddresses(): string[] {
    return [...this.config.trackerAddresses];
  }

  getActiveTracker(): string | null {
    if (this.activeTrackerIndex >= 0 && this.activeTrackerIndex < this.config.trackerAddresses.length) {
      return this.config.trackerAddresses[this.activeTrackerIndex];
    }
    return null;
  }

  setMessageHandler(handler: (dest: string, msg: any) => Promise<boolean>): void {
    this.sendMessage = handler;
  }

  setIdentity(destination: string, displayName: string = 'I2P Share User'): void {
    this.myDestination = destination;
    this.displayName = displayName;
  }

  setStreamingDestination(destination: string): void {
    this.streamingDestination = destination;
    console.log(`[TrackerClient] Streaming destination set: ${destination.substring(0, 30)}...`);
  }

  updateStats(filesCount: number, totalSize: number): void {
    this.filesCount = filesCount;
    this.totalSize = totalSize;
  }

  // Select a random tracker from available ones
  private selectRandomTracker(): number {
    const available = this.config.trackerAddresses
      .map((_, i) => i)
      .filter(i => !this.failedTrackers.has(i));

    if (available.length === 0) {
      // All trackers failed, reset and try again
      console.log('[TrackerClient] All trackers failed, resetting...');
      this.failedTrackers.clear();
      return this.config.trackerAddresses.length > 0
        ? Math.floor(Math.random() * this.config.trackerAddresses.length)
        : -1;
    }

    // Random selection from available
    const randomIndex = Math.floor(Math.random() * available.length);
    return available[randomIndex];
  }

  async connect(): Promise<boolean> {
    if (this.config.trackerAddresses.length === 0) {
      console.log('[TrackerClient] No tracker addresses configured');
      return false;
    }

    if (!this.sendMessage) {
      console.error('[TrackerClient] No message handler set');
      return false;
    }

    if (!this.myDestination) {
      console.error('[TrackerClient] Identity not set');
      return false;
    }

    // Select a random tracker
    this.activeTrackerIndex = this.selectRandomTracker();

    if (this.activeTrackerIndex < 0) {
      console.log('[TrackerClient] No trackers available');
      return false;
    }

    const tracker = this.config.trackerAddresses[this.activeTrackerIndex];
    console.log(`[TrackerClient] Connecting to tracker ${this.activeTrackerIndex + 1}/${this.config.trackerAddresses.length}: ${tracker.substring(0, 20)}...`);

    // Send initial announcements with retry (UDP over I2P can be unreliable)
    // Send 3 announces with 1 second delay between each
    for (let i = 0; i < 3; i++) {
      await this.announce();
      if (i < 2) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    // Wait for announce to propagate through I2P network
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Request peer list (also send multiple times for reliability)
    for (let i = 0; i < 2; i++) {
      await this.requestPeers();
      if (i < 1) {
        await new Promise(resolve => setTimeout(resolve, 1500));
      }
    }

    // Start periodic tasks
    this.startPeriodicTasks();

    this.isConnected = true;
    console.log('[TrackerClient] Connected to tracker');

    return true;
  }

  private startPeriodicTasks(): void {
    this.stopPeriodicTasks();

    // Announce periodically (send twice for UDP reliability)
    this.announceTimer = setInterval(async () => {
      await this.announce();
      // Send again after a short delay for reliability
      setTimeout(() => this.announce(), 500);
    }, this.config.announceInterval);

    // Refresh peer list periodically
    this.refreshTimer = setInterval(() => {
      this.requestPeers();
      this.checkTrackerHealth();
    }, this.config.refreshInterval);
  }

  private stopPeriodicTasks(): void {
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // Check if current tracker is responding
  private async checkTrackerHealth(): Promise<void> {
    const tracker = this.getActiveTracker();
    if (!tracker) return;

    const lastResponse = this.lastResponseTime.get(tracker) || 0;
    const timeSinceResponse = Date.now() - lastResponse;

    // If no response in 3x announce interval, try another tracker
    if (lastResponse > 0 && timeSinceResponse > this.config.announceInterval * 3) {
      console.log(`[TrackerClient] Tracker not responding, switching...`);
      this.failedTrackers.add(this.activeTrackerIndex);
      await this.switchTracker();
    }
  }

  // Switch to a different tracker
  private async switchTracker(): Promise<void> {
    const oldTracker = this.activeTrackerIndex;
    this.activeTrackerIndex = this.selectRandomTracker();

    if (this.activeTrackerIndex < 0 || this.activeTrackerIndex === oldTracker) {
      console.log('[TrackerClient] No alternative trackers available');
      return;
    }

    const tracker = this.config.trackerAddresses[this.activeTrackerIndex];
    console.log(`[TrackerClient] Switched to tracker ${this.activeTrackerIndex + 1}: ${tracker.substring(0, 20)}...`);

    // Announce to new tracker
    await this.announce();
    await this.requestPeers();
  }

  async announce(): Promise<void> {
    const tracker = this.getActiveTracker();
    if (!this.sendMessage || !tracker) return;

    // Use the tracker address directly - it should be a full I2P destination
    // (Full destinations are base64 strings, typically ending in AAAA)
    const payload: any = {
      displayName: this.displayName,
      filesCount: this.filesCount,
      totalSize: this.totalSize
    };

    // Include streaming destination if available (for I2P Streaming file transfers)
    if (this.streamingDestination) {
      payload.streamingDestination = this.streamingDestination;
    }

    const message: TrackerMessage = {
      type: 'ANNOUNCE',
      payload,
      timestamp: Date.now()
    };

    try {
      await this.sendMessage(tracker, message);
      console.log('[TrackerClient] Announced to tracker:', tracker.substring(0, 20) + '...');
    } catch (error: any) {
      console.error('[TrackerClient] Announce failed:', error.message);
    }
  }

  async requestPeers(): Promise<void> {
    const tracker = this.getActiveTracker();
    if (!this.sendMessage || !tracker) return;

    // Use the tracker address directly - it should be a full I2P destination
    const message: TrackerMessage = {
      type: 'GET_PEERS',
      payload: {},
      timestamp: Date.now()
    };

    try {
      await this.sendMessage(tracker, message);
      console.log('[TrackerClient] Requested peer list from tracker');
    } catch (error: any) {
      console.error('[TrackerClient] Request peers failed:', error.message);
    }
  }

  handleMessage(from: string, message: any): boolean {
    // Check if message is from any of our trackers
    // Compare both full destinations and b32 addresses
    const fromB32 = toB32(from);

    const trackerIndex = this.config.trackerAddresses.findIndex(addr => {
      // If configured address is a full destination (long base64 string)
      if (addr.length > 100 && !addr.includes('.b32.i2p')) {
        // Compare full destinations directly, or convert to b32
        const addrB32 = toB32(addr);
        return addr === from || addrB32 === fromB32;
      }
      // If configured address is a b32 address
      const cleanAddr = addr.replace(/\.b32\.i2p$/i, '').toLowerCase();
      const cleanFrom = fromB32.replace(/\.b32\.i2p$/i, '').toLowerCase();
      return cleanAddr === cleanFrom;
    });

    if (trackerIndex < 0) {
      return false; // Not a tracker message
    }

    console.log(`[TrackerClient] Received message from tracker: ${message.type}`);

    // Update last response time
    this.lastResponseTime.set(from, Date.now());

    switch (message.type) {
      case 'PEERS_LIST':
        this.handlePeersList(message.payload);
        return true;
      case 'PONG':
        console.log('[TrackerClient] Received PONG from tracker');
        return true;
      default:
        return false;
    }
  }

  private handlePeersList(payload: { peers: TrackerPeer[] }): void {
    const peers = payload.peers || [];
    console.log(`[TrackerClient] Received ${peers.length} peers from tracker`);

    for (const peer of peers) {
      const isNew = !this.knownPeers.has(peer.destination);
      this.knownPeers.set(peer.destination, peer);

      if (isNew) {
        console.log(`[TrackerClient] New peer discovered: ${peer.b32Address.substring(0, 16)}...`);
        this.emit('peer:discovered', peer);
      }
    }

    this.emit('peers:updated', Array.from(this.knownPeers.values()));
  }

  getPeers(): TrackerPeer[] {
    return Array.from(this.knownPeers.values());
  }

  getPeersCount(): number {
    return this.knownPeers.size;
  }

  disconnect(): void {
    this.stopPeriodicTasks();
    this.isConnected = false;
    this.activeTrackerIndex = -1;
    console.log('[TrackerClient] Disconnected from tracker');
  }

  isTrackerConnected(): boolean {
    return this.isConnected;
  }
}

export const trackerClient = new TrackerClient();
