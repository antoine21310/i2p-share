import { EventEmitter } from 'events';
import { toB32 } from '@diva.exchange/i2p-sam';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import {
  generateSigningKeypair,
  createSignedMessage,
  verifySignedMessage,
  SignedMessage,
  SigningKeypair
} from '../shared/utils';

interface TrackerPeer {
  destination: string;
  b32Address: string;
  displayName: string;
  filesCount: number;
  totalSize: number;
  streamingDestination?: string; // Destination for I2P streaming file transfers
  signingKey?: string; // Public key for message verification
}

interface TrackerMessage {
  type: 'ANNOUNCE' | 'GET_PEERS' | 'PEERS_LIST' | 'PING' | 'PONG' | 'DISCONNECT';
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
  private signingKeys: SigningKeypair | null = null;
  private usedNonces: Set<string> = new Set(); // Replay attack protection

  constructor(config: Partial<TrackerClientConfig> = {}) {
    super();
    this.config = {
      trackerAddresses: config.trackerAddresses || [...DEFAULT_TRACKERS],
      announceInterval: config.announceInterval || 2 * 60 * 1000,
      refreshInterval: config.refreshInterval || 60 * 1000,
      connectionTimeout: config.connectionTimeout || 30 * 1000
    };

    // Load or generate signing keys
    this.initSigningKeys();

    // Cleanup nonces periodically
    setInterval(() => {
      this.usedNonces.clear();
    }, 10 * 60 * 1000); // Every 10 minutes
  }

  private getSigningKeysPath(): string {
    const userDataPath = app?.getPath('userData') || process.cwd();
    return path.join(userDataPath, 'signing-keys.json');
  }

  private initSigningKeys(): void {
    try {
      const keysPath = this.getSigningKeysPath();

      if (fs.existsSync(keysPath)) {
        const data = fs.readFileSync(keysPath, 'utf-8');
        this.signingKeys = JSON.parse(data) as SigningKeypair;
        console.log('[TrackerClient] Loaded signing keys');
      } else {
        // Generate new keys
        console.log('[TrackerClient] Generating new signing keys...');
        this.signingKeys = generateSigningKeypair();

        // Save keys
        const keysDir = path.dirname(keysPath);
        if (!fs.existsSync(keysDir)) {
          fs.mkdirSync(keysDir, { recursive: true });
        }
        fs.writeFileSync(keysPath, JSON.stringify(this.signingKeys, null, 2));
        console.log('[TrackerClient] Signing keys generated and saved');
      }
    } catch (error: any) {
      console.error('[TrackerClient] Failed to initialize signing keys:', error.message);
      // Generate in-memory keys as fallback
      this.signingKeys = generateSigningKeypair();
    }
  }

  getSigningPublicKey(): string | null {
    return this.signingKeys?.publicKey || null;
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

  setDisplayName(name: string): void {
    this.displayName = name || 'I2P Share User';
    console.log(`[TrackerClient] Display name set: ${this.displayName}`);
  }

  getDisplayName(): string {
    return this.displayName;
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

    // Send initial announce with exponential backoff retry
    // Only retry if we don't get a response (tracked by lastResponseTime)
    await this.announce();

    // Wait for I2P network latency (I2P has high latency due to tunnel encryption)
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Request peer list - the response also confirms announce was received
    await this.requestPeers();

    // Start periodic tasks
    this.startPeriodicTasks();

    this.isConnected = true;
    console.log('[TrackerClient] Connected to tracker');

    return true;
  }

  private startPeriodicTasks(): void {
    this.stopPeriodicTasks();

    // Add jitter to prevent thundering herd (±10% of interval)
    const addJitter = (interval: number) => {
      const jitter = interval * 0.1 * (Math.random() - 0.5);
      return Math.round(interval + jitter);
    };

    // Announce periodically with jitter
    // Single announce is sufficient - if tracker doesn't respond,
    // health check will trigger a re-announce or tracker switch
    this.announceTimer = setInterval(async () => {
      await this.announce();
    }, addJitter(this.config.announceInterval));

    // Refresh peer list periodically with jitter
    this.refreshTimer = setInterval(() => {
      this.requestPeers();
      this.checkTrackerHealth();
    }, addJitter(this.config.refreshInterval));
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

    // If no response in 2x refresh interval, try re-announcing first
    if (lastResponse > 0 && timeSinceResponse > this.config.refreshInterval * 2) {
      console.log(`[TrackerClient] Tracker not responding, attempting re-announce...`);
      await this.announce();

      // If still no response after 3x refresh interval, switch trackers
      if (timeSinceResponse > this.config.refreshInterval * 3) {
        console.log(`[TrackerClient] Tracker still not responding, switching...`);
        this.failedTrackers.add(this.activeTrackerIndex);
        await this.switchTracker();
      }
    }
  }

  // Switch to a different tracker
  private async switchTracker(): Promise<void> {
    const oldTracker = this.activeTrackerIndex;
    this.activeTrackerIndex = this.selectRandomTracker();

    if (this.activeTrackerIndex < 0 || this.activeTrackerIndex === oldTracker) {
      console.log('[TrackerClient] No alternative trackers available');
      // Clear failed trackers to allow retry
      if (this.config.trackerAddresses.length > 0) {
        console.log('[TrackerClient] Clearing failed tracker list for retry');
        this.failedTrackers.clear();
        this.activeTrackerIndex = this.selectRandomTracker();
      }
      return;
    }

    const tracker = this.config.trackerAddresses[this.activeTrackerIndex];
    console.log(`[TrackerClient] Switched to tracker ${this.activeTrackerIndex + 1}: ${tracker.substring(0, 20)}...`);

    // Announce to new tracker with small delay for I2P latency
    await this.announce();
    await new Promise(resolve => setTimeout(resolve, 1500));
    await this.requestPeers();
  }

  /**
   * Send a signed message to the tracker
   */
  private async sendSignedMessage(destination: string, message: TrackerMessage): Promise<boolean> {
    if (!this.sendMessage) return false;

    if (this.signingKeys) {
      // Create signed message
      const signedMsg = createSignedMessage(
        message,
        this.signingKeys.privateKey,
        this.signingKeys.publicKey
      );
      return this.sendMessage(destination, signedMsg);
    } else {
      // Fallback to unsigned (legacy)
      return this.sendMessage(destination, message);
    }
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
      await this.sendSignedMessage(tracker, message);
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
      await this.sendSignedMessage(tracker, message);
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

    // Handle signed messages (new format)
    let actualMessage: TrackerMessage;
    let signingKey: string | undefined;

    if (message.signature && message.signingKey && message.nonce) {
      // Verify the signed message
      const verification = verifySignedMessage({
        data: message.data,
        nonce: message.nonce,
        timestamp: message.timestamp,
        signature: message.signature,
        signingKey: message.signingKey
      });

      if (!verification.valid) {
        console.log(`[TrackerClient] Rejected tracker message: ${verification.error}`);
        return true; // Handled (rejected)
      }

      // Check for replay attack
      if (this.usedNonces.has(message.nonce)) {
        console.log('[TrackerClient] Rejected tracker message: Nonce reused');
        return true;
      }
      this.usedNonces.add(message.nonce);

      actualMessage = verification.data as TrackerMessage;
      signingKey = message.signingKey;
      console.log(`[TrackerClient] Received verified message from tracker: ${actualMessage.type}`);
    } else {
      // Legacy unsigned message
      actualMessage = message as TrackerMessage;
      console.log(`[TrackerClient] Received message from tracker: ${actualMessage.type} (unsigned)`);
    }

    // Update last response time
    this.lastResponseTime.set(from, Date.now());

    switch (actualMessage.type) {
      case 'PEERS_LIST':
        this.handlePeersList(actualMessage.payload, signingKey);
        return true;
      case 'PONG':
        console.log('[TrackerClient] Received PONG from tracker');
        return true;
      default:
        return false;
    }
  }

  private handlePeersList(payload: { peers: TrackerPeer[] }, trackerSigningKey?: string): void {
    const peers = payload.peers || [];
    console.log(`[TrackerClient] Received ${peers.length} peers from tracker${trackerSigningKey ? ' (verified)' : ''}`);

    // Track which peers are in the current list
    const currentPeerKeys = new Set<string>();

    for (const peer of peers) {
      // Use b32Address as the key to deduplicate peers across sessions
      // (same peer reconnecting gets a new destination but same b32Address)
      const key = peer.b32Address || peer.destination;
      currentPeerKeys.add(key);

      const existing = this.knownPeers.get(key);
      const isNew = !existing;

      // Update peer info (this also updates destination if peer reconnected)
      this.knownPeers.set(key, {
        ...peer,
        lastSeen: Date.now()
      } as TrackerPeer & { lastSeen: number });

      if (isNew) {
        console.log(`[TrackerClient] New peer discovered: ${peer.b32Address.substring(0, 16)}...`);
        this.emit('peer:discovered', peer);
      }
    }

    // Remove peers that haven't been seen in the last 3 refresh cycles (stale)
    const staleThreshold = this.config.refreshInterval * 3;
    const now = Date.now();
    for (const [key, peer] of this.knownPeers.entries()) {
      const peerWithTime = peer as TrackerPeer & { lastSeen?: number };
      if (peerWithTime.lastSeen && now - peerWithTime.lastSeen > staleThreshold) {
        console.log(`[TrackerClient] Removing stale peer: ${key.substring(0, 16)}...`);
        this.knownPeers.delete(key);
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

  async disconnect(): Promise<void> {
    // Send DISCONNECT message to tracker before disconnecting
    if (this.isConnected && this.sendMessage && this.activeTrackerIndex >= 0) {
      const trackerAddr = this.config.trackerAddresses[this.activeTrackerIndex];
      if (trackerAddr) {
        console.log('[TrackerClient] Sending DISCONNECT to tracker...');
        const message: TrackerMessage = {
          type: 'DISCONNECT',
          payload: {},
          timestamp: Date.now()
        };
        try {
          await this.sendSignedMessage(trackerAddr, message);
        } catch (e) {
          // Ignore errors when disconnecting
        }
      }
    }

    this.stopPeriodicTasks();
    this.isConnected = false;
    this.activeTrackerIndex = -1;
    this.knownPeers.clear();
    this.usedNonces.clear();
    console.log('[TrackerClient] Disconnected from tracker');
  }

  isTrackerConnected(): boolean {
    return this.isConnected;
  }
}

export const trackerClient = new TrackerClient();
