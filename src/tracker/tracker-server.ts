import { EventEmitter } from 'events';
import { createRaw, createLocalDestination, toB32 } from '@diva.exchange/i2p-sam';
import fs from 'fs';
import path from 'path';

interface Peer {
  destination: string;
  b32Address: string;
  displayName: string;
  filesCount: number;
  totalSize: number;
  lastSeen: number;
  streamingDestination?: string; // For I2P Streaming file transfers
}

interface TrackerConfig {
  samHost: string;
  samPortTCP: number;
  samPortUDP: number;
  listenPort: number;
  peerTimeout: number;
  cleanupInterval: number;
  dataDir: string; // Directory to store persistent data (keys)
}

interface TrackerMessage {
  type: 'ANNOUNCE' | 'GET_PEERS' | 'PEERS_LIST' | 'PING' | 'PONG';
  payload: any;
  timestamp: number;
}

interface StoredKeys {
  publicKey: string;
  privateKey: string;
  destination: string;
  b32Address: string;
}

export class TrackerServer extends EventEmitter {
  private config: TrackerConfig;
  private sam: any = null;
  private destination: string = '';
  private b32Address: string = '';
  private publicKey: string = '';
  private privateKey: string = '';
  private isRunning: boolean = false;
  private peers: Map<string, Peer> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;

  constructor(config: Partial<TrackerConfig> = {}) {
    super();
    this.config = {
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      samPortUDP: config.samPortUDP || 7655,
      listenPort: config.listenPort || 7670,
      peerTimeout: config.peerTimeout || 5 * 60 * 1000,
      cleanupInterval: config.cleanupInterval || 60 * 1000,
      dataDir: config.dataDir || './tracker-data'
    };
  }

  private getKeysPath(): string {
    return path.join(this.config.dataDir, 'tracker-keys.json');
  }

  private loadKeys(): StoredKeys | null {
    try {
      const keysPath = this.getKeysPath();
      if (fs.existsSync(keysPath)) {
        const data = fs.readFileSync(keysPath, 'utf-8');
        const keys = JSON.parse(data) as StoredKeys;
        console.log('[Tracker] Loaded existing keys from', keysPath);
        return keys;
      }
    } catch (error: any) {
      console.log('[Tracker] Could not load keys:', error.message);
    }
    return null;
  }

  private saveKeys(): void {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(this.config.dataDir)) {
        fs.mkdirSync(this.config.dataDir, { recursive: true });
      }

      const keys: StoredKeys = {
        publicKey: this.publicKey,
        privateKey: this.privateKey,
        destination: this.destination,
        b32Address: this.b32Address
      };

      const keysPath = this.getKeysPath();
      fs.writeFileSync(keysPath, JSON.stringify(keys, null, 2));
      console.log('[Tracker] Saved keys to', keysPath);
    } catch (error: any) {
      console.error('[Tracker] Could not save keys:', error.message);
    }
  }

  async start(): Promise<{ success: boolean; b32Address?: string; error?: string }> {
    console.log('[Tracker] Starting tracker server...');
    console.log('[Tracker] SAM bridge:', `${this.config.samHost}:${this.config.samPortTCP}`);
    console.log('[Tracker] Data directory:', this.config.dataDir);

    try {
      // Try to load existing keys
      const existingKeys = this.loadKeys();

      if (existingKeys) {
        // Use existing keys
        this.publicKey = existingKeys.publicKey;
        this.privateKey = existingKeys.privateKey;
        this.destination = existingKeys.destination;
        this.b32Address = existingKeys.b32Address;
        console.log('[Tracker] Using existing identity');
      } else {
        // Create new I2P destination
        console.log('[Tracker] Creating new I2P destination...');
        const destInfo = await createLocalDestination({
          sam: {
            host: this.config.samHost,
            portTCP: this.config.samPortTCP
          }
        });

        // Note: In i2p-sam library:
        // - destInfo.public = full I2P destination (base64, ~400 chars)
        // - destInfo.address = b32 address (short hash)
        // We need the FULL destination for SAM communication
        this.destination = destInfo.public;
        this.publicKey = destInfo.public;
        this.privateKey = destInfo.private;
        this.b32Address = destInfo.address;

        // Save keys for future use
        this.saveKeys();
      }

      console.log('[Tracker] ════════════════════════════════════════════════════════');
      console.log('[Tracker] TRACKER READY!');
      console.log('[Tracker]');
      console.log('[Tracker] B32 Address (short, for display):');
      console.log('[Tracker]   ' + this.b32Address);
      console.log('[Tracker]');
      console.log('[Tracker] Full Destination (use this in settings):');
      console.log('[Tracker]   ' + this.destination);
      console.log('[Tracker]');
      console.log('[Tracker] ════════════════════════════════════════════════════════');

      // Also save to a file for easy copy
      const destFile = path.join(this.config.dataDir, 'tracker-destination.txt');
      fs.writeFileSync(destFile, this.destination);
      console.log('[Tracker] Destination saved to:', destFile);

      // Create RAW session for datagram communication
      await this.createSamSession();

      this.isRunning = true;

      // Start cleanup timer
      this.cleanupTimer = setInterval(() => {
        this.cleanupInactivePeers();
      }, this.config.cleanupInterval);

      // Start stats interval
      this.statsInterval = setInterval(() => {
        this.logStats();
      }, 30000);

      this.isRunning = true;
      console.log('[Tracker] Server started successfully');
      console.log('[Tracker] Waiting for peers...');

      return {
        success: true,
        b32Address: this.b32Address
      };

    } catch (error: any) {
      console.error('[Tracker] Failed to start:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }

  private async createSamSession(): Promise<void> {
    // Use a random port to avoid conflicts with the main app
    const listenPort = this.config.listenPort + Math.floor(Math.random() * 100);

    console.log('[Tracker] Creating RAW session on port', listenPort);

    this.sam = await createRaw({
      sam: {
        host: this.config.samHost,
        portTCP: this.config.samPortTCP,
        portUDP: this.config.samPortUDP,
        publicKey: this.publicKey,
        privateKey: this.privateKey
      },
      listen: {
        address: '127.0.0.1',
        port: listenPort
      }
    });

    // Set up event handlers
    this.sam.on('data', (data: Buffer) => {
      this.handleIncomingData(data);
    });

    this.sam.on('close', () => {
      console.log('[Tracker] Session closed');
      if (this.isRunning) {
        this.scheduleReconnect();
      }
    });

    this.sam.on('error', (error: Error) => {
      console.error('[Tracker] Session error:', error.message);
    });

    this.reconnectAttempts = 0;
    console.log('[Tracker] RAW session created successfully');
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = Math.min(5000 * this.reconnectAttempts, 30000);

    console.log(`[Tracker] Reconnecting in ${delay/1000}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.createSamSession();
        console.log('[Tracker] Reconnected successfully');
      } catch (error: any) {
        console.error('[Tracker] Reconnect failed:', error.message);
        this.scheduleReconnect();
      }
    }, delay);
  }

  private handleIncomingData(data: Buffer): void {
    try {
      const str = data.toString();
      if (!str.startsWith('{')) return;

      const message = JSON.parse(str) as TrackerMessage & { _from?: string };
      const from = message._from || '';
      delete message._from;

      if (!from) {
        console.log('[Tracker] Received message without sender');
        return;
      }

      this.handleMessage(from, message);
    } catch (e) {
      // Ignore invalid messages
    }
  }

  private handleMessage(from: string, message: TrackerMessage): void {
    switch (message.type) {
      case 'ANNOUNCE':
        this.handleAnnounce(from, message.payload);
        break;
      case 'GET_PEERS':
        this.handleGetPeers(from);
        break;
      case 'PING':
        this.handlePing(from);
        break;
      default:
        console.log('[Tracker] Unknown message type:', message.type);
    }
  }

  private handleAnnounce(from: string, payload: any): void {
    const b32 = toB32(from);
    const isNew = !this.peers.has(from);

    const peer: Peer = {
      destination: from,
      b32Address: b32,
      displayName: payload.displayName || 'Unknown',
      filesCount: payload.filesCount || 0,
      totalSize: payload.totalSize || 0,
      lastSeen: Date.now(),
      streamingDestination: payload.streamingDestination // For I2P Streaming file transfers
    };

    this.peers.set(from, peer);

    if (isNew) {
      console.log(`[Tracker] New peer: ${b32.substring(0, 16)}... (${peer.displayName})`);
      if (peer.streamingDestination) {
        console.log(`[Tracker]   -> Has streaming destination`);
      }
    } else {
      console.log(`[Tracker] Peer update: ${b32.substring(0, 16)}... (${peer.filesCount} files)`);
    }

    // Send back the current peer list
    this.sendPeersList(from);
  }

  private handleGetPeers(from: string): void {
    const b32 = toB32(from);
    console.log(`[Tracker] Peer list requested by ${b32.substring(0, 16)}...`);

    // Auto-register peer if not already known (they may have missed the ANNOUNCE)
    let peer = this.peers.get(from);
    if (!peer) {
      console.log(`[Tracker] Auto-registering unknown peer: ${b32.substring(0, 16)}...`);
      peer = {
        destination: from,
        b32Address: b32,
        displayName: 'Unknown',
        filesCount: 0,
        totalSize: 0,
        lastSeen: Date.now()
      };
      this.peers.set(from, peer);
    } else {
      peer.lastSeen = Date.now();
    }

    this.sendPeersList(from);
  }

  private handlePing(from: string): void {
    // Update last seen
    const peer = this.peers.get(from);
    if (peer) {
      peer.lastSeen = Date.now();
    }

    // Send pong
    this.sendMessage(from, {
      type: 'PONG',
      payload: {},
      timestamp: Date.now()
    });
  }

  private sendPeersList(to: string): void {
    // Get all active peers except the requester
    const peersList = Array.from(this.peers.values())
      .filter(p => p.destination !== to)
      .map(p => ({
        destination: p.destination,
        b32Address: p.b32Address,
        displayName: p.displayName,
        filesCount: p.filesCount,
        totalSize: p.totalSize,
        streamingDestination: p.streamingDestination // For I2P Streaming file transfers
      }));

    this.sendMessage(to, {
      type: 'PEERS_LIST',
      payload: { peers: peersList },
      timestamp: Date.now()
    });

    console.log(`[Tracker] Sent ${peersList.length} peers to ${toB32(to).substring(0, 16)}...`);
  }

  private sendMessage(destination: string, message: TrackerMessage): void {
    if (!this.sam) return;

    try {
      const msgWithSender = {
        ...message,
        _from: this.destination
      };
      const data = Buffer.from(JSON.stringify(msgWithSender));
      this.sam.send(destination, data);
    } catch (error: any) {
      console.error('[Tracker] Failed to send message:', error.message);
    }
  }

  private cleanupInactivePeers(): void {
    const now = Date.now();
    const timeout = this.config.peerTimeout;
    let removed = 0;

    for (const [dest, peer] of this.peers) {
      if (now - peer.lastSeen > timeout) {
        this.peers.delete(dest);
        console.log(`[Tracker] Removed inactive peer: ${peer.b32Address.substring(0, 16)}...`);
        removed++;
      }
    }

    if (removed > 0) {
      console.log(`[Tracker] Cleanup: removed ${removed} inactive peers`);
    }
  }

  private logStats(): void {
    console.log(`[Tracker] Stats: ${this.peers.size} active peers`);
  }

  getStats(): { peersCount: number; peers: Peer[] } {
    return {
      peersCount: this.peers.size,
      peers: Array.from(this.peers.values())
    };
  }

  getAddress(): string {
    return this.b32Address;
  }

  getDestination(): string {
    return this.destination;
  }

  async stop(): Promise<void> {
    console.log('[Tracker] Stopping...');

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.sam) {
      try {
        this.sam.close();
      } catch (e) {
        // Ignore
      }
      this.sam = null;
    }

    this.isRunning = false;
    this.peers.clear();
    console.log('[Tracker] Stopped');
  }
}
