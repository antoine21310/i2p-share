import { EventEmitter } from 'events';
import { createRaw, createLocalDestination, toB32 } from '@diva.exchange/i2p-sam';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import {
  generateSigningKeypair,
  createSignedMessage,
  verifySignedMessage,
  SignedMessage,
  SigningKeypair
} from '../shared/utils';

interface Peer {
  destination: string;
  b32Address: string;
  displayName: string;
  filesCount: number;
  totalSize: number;
  lastSeen: number;
  streamingDestination?: string; // For I2P Streaming file transfers
  signingKey?: string; // Public key for message verification
}

interface TrackerConfig {
  samHost: string;
  samPortTCP: number;
  samPortUDP: number;
  listenPort: number;
  peerTimeout: number;
  cleanupInterval: number;
  dataDir: string; // Directory to store persistent data (keys)
  maxPeersPerResponse: number; // Pagination limit for large networks
}

interface TrackerMessage {
  type: 'ANNOUNCE' | 'GET_PEERS' | 'PEERS_LIST' | 'PING' | 'PONG' | 'DISCONNECT';
  payload: any;
  timestamp: number;
}

interface StoredKeys {
  publicKey: string;
  privateKey: string;
  destination: string;
  b32Address: string;
  signingKeys?: SigningKeypair; // Ed25519 signing keypair
}

export class TrackerServer extends EventEmitter {
  private config: TrackerConfig;
  private sam: any = null;
  private db: Database.Database | null = null;
  private destination: string = '';
  private b32Address: string = '';
  private publicKey: string = '';
  private privateKey: string = '';
  private signingKeys: SigningKeypair | null = null;
  private isRunning: boolean = false;
  private usedNonces: Set<string> = new Set(); // Replay attack protection
  private nonceCleanupTimer: NodeJS.Timeout | null = null;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;

  // Prepared statements for efficient queries
  private stmtUpsertPeer: Database.Statement | null = null;
  private stmtGetPeer: Database.Statement | null = null;
  private stmtDeletePeer: Database.Statement | null = null;
  private stmtGetActivePeers: Database.Statement | null = null;
  private stmtGetPeerCount: Database.Statement | null = null;
  private stmtCleanupPeers: Database.Statement | null = null;
  private stmtUpdateLastSeen: Database.Statement | null = null;

  constructor(config: Partial<TrackerConfig> = {}) {
    super();
    this.config = {
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      samPortUDP: config.samPortUDP || 7655,
      listenPort: config.listenPort || 7670,
      peerTimeout: config.peerTimeout || 5 * 60 * 1000,
      cleanupInterval: config.cleanupInterval || 60 * 1000,
      dataDir: config.dataDir || './tracker-data',
      maxPeersPerResponse: config.maxPeersPerResponse || 100 // Limit per response for large networks
    };
  }

  /**
   * Initialize SQLite database for peer storage
   * Optimized for 100k+ peers with proper indexing
   */
  private initDatabase(): void {
    const dbPath = path.join(this.config.dataDir, 'tracker.db');

    // Ensure directory exists
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);

    // Enable WAL mode for better concurrent performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000'); // 64MB cache

    // Create peers table with proper indexing
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS peers (
        destination TEXT PRIMARY KEY,
        b32Address TEXT NOT NULL,
        displayName TEXT DEFAULT 'Unknown',
        filesCount INTEGER DEFAULT 0,
        totalSize INTEGER DEFAULT 0,
        lastSeen INTEGER NOT NULL,
        streamingDestination TEXT,
        signingKey TEXT
      );

      -- Index for efficient cleanup queries
      CREATE INDEX IF NOT EXISTS idx_peers_lastSeen ON peers(lastSeen);

      -- Index for b32 lookups
      CREATE INDEX IF NOT EXISTS idx_peers_b32 ON peers(b32Address);

      -- Used nonces table for replay protection (with auto-cleanup)
      CREATE TABLE IF NOT EXISTS used_nonces (
        nonce TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_nonces_created ON used_nonces(createdAt);
    `);

    // Prepare statements for efficient repeated queries
    this.stmtUpsertPeer = this.db.prepare(`
      INSERT INTO peers (destination, b32Address, displayName, filesCount, totalSize, lastSeen, streamingDestination, signingKey)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(destination) DO UPDATE SET
        displayName = excluded.displayName,
        filesCount = excluded.filesCount,
        totalSize = excluded.totalSize,
        lastSeen = excluded.lastSeen,
        streamingDestination = excluded.streamingDestination,
        signingKey = COALESCE(peers.signingKey, excluded.signingKey)
    `);

    this.stmtGetPeer = this.db.prepare('SELECT * FROM peers WHERE destination = ?');
    this.stmtDeletePeer = this.db.prepare('DELETE FROM peers WHERE destination = ?');
    this.stmtGetPeerCount = this.db.prepare('SELECT COUNT(*) as count FROM peers WHERE lastSeen > ?');
    this.stmtCleanupPeers = this.db.prepare('DELETE FROM peers WHERE lastSeen < ?');
    this.stmtUpdateLastSeen = this.db.prepare('UPDATE peers SET lastSeen = ? WHERE destination = ?');

    // For paginated peer list (exclude requester, random order for load distribution)
    this.stmtGetActivePeers = this.db.prepare(`
      SELECT destination, b32Address, displayName, filesCount, totalSize, streamingDestination
      FROM peers
      WHERE destination != ? AND lastSeen > ?
      ORDER BY RANDOM()
      LIMIT ?
    `);

    console.log('[Tracker] SQLite database initialized at:', dbPath);
  }

  /**
   * Check if a nonce has been used (replay attack protection)
   */
  private isNonceUsed(nonce: string): boolean {
    if (!this.db) return false;

    const row = this.db.prepare('SELECT 1 FROM used_nonces WHERE nonce = ?').get(nonce);
    return !!row;
  }

  /**
   * Mark a nonce as used
   */
  private markNonceUsed(nonce: string): void {
    if (!this.db) return;

    try {
      this.db.prepare('INSERT OR IGNORE INTO used_nonces (nonce, createdAt) VALUES (?, ?)').run(nonce, Date.now());
    } catch (e) {
      // Ignore duplicate errors
    }
  }

  /**
   * Clean up old nonces from database
   */
  private cleanupNonces(): void {
    if (!this.db) return;

    const cutoff = Date.now() - (10 * 60 * 1000); // 10 minutes
    this.db.prepare('DELETE FROM used_nonces WHERE createdAt < ?').run(cutoff);
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
        b32Address: this.b32Address,
        signingKeys: this.signingKeys || undefined
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
      // Initialize SQLite database first
      this.initDatabase();

      // Try to load existing keys
      const existingKeys = this.loadKeys();

      if (existingKeys) {
        // Use existing keys
        this.publicKey = existingKeys.publicKey;
        this.privateKey = existingKeys.privateKey;
        this.destination = existingKeys.destination;
        this.b32Address = existingKeys.b32Address;
        this.signingKeys = existingKeys.signingKeys || null;
        console.log('[Tracker] Using existing identity');

        // Generate signing keys if missing (migration from old version)
        if (!this.signingKeys) {
          console.log('[Tracker] Generating new signing keys (migration)...');
          this.signingKeys = generateSigningKeypair();
          this.saveKeys();
        }
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

        // Generate Ed25519 signing keypair
        console.log('[Tracker] Generating signing keys...');
        this.signingKeys = generateSigningKeypair();

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

      // Start nonce cleanup timer (every 10 minutes, remove old nonces from DB)
      this.nonceCleanupTimer = setInterval(() => {
        this.cleanupNonces();
        this.usedNonces.clear(); // Also clear in-memory cache
      }, 10 * 60 * 1000);

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

      const parsed = JSON.parse(str);

      // Check if this is a signed message (new format)
      if (parsed.signature && parsed.signingKey && parsed.nonce) {
        const signedMsg = parsed as SignedMessage & { _from?: string };
        const from = signedMsg._from || '';

        if (!from) {
          console.log('[Tracker] Received signed message without sender');
          return;
        }

        // Verify signature
        const verification = verifySignedMessage({
          data: signedMsg.data,
          nonce: signedMsg.nonce,
          timestamp: signedMsg.timestamp,
          signature: signedMsg.signature,
          signingKey: signedMsg.signingKey
        });

        if (!verification.valid) {
          console.log(`[Tracker] Rejected message: ${verification.error}`);
          return;
        }

        // Check for replay attack (nonce reuse) - use both in-memory and DB for speed
        if (this.usedNonces.has(signedMsg.nonce) || this.isNonceUsed(signedMsg.nonce)) {
          console.log('[Tracker] Rejected message: Nonce already used (replay attack?)');
          return;
        }
        this.usedNonces.add(signedMsg.nonce);
        this.markNonceUsed(signedMsg.nonce);

        // Process verified message
        const message = verification.data as TrackerMessage;
        this.handleMessage(from, message, signedMsg.signingKey);
      } else {
        // Legacy unsigned message (for backwards compatibility)
        // TODO: Remove this path once all clients are updated
        const message = parsed as TrackerMessage & { _from?: string };
        const from = message._from || '';
        delete message._from;

        if (!from) {
          console.log('[Tracker] Received message without sender');
          return;
        }

        console.log('[Tracker] Warning: Received unsigned message (legacy client)');
        this.handleMessage(from, message);
      }
    } catch (e) {
      // Ignore invalid messages
    }
  }

  private handleMessage(from: string, message: TrackerMessage, signingKey?: string): void {
    switch (message.type) {
      case 'ANNOUNCE':
        this.handleAnnounce(from, message.payload, signingKey);
        break;
      case 'GET_PEERS':
        this.handleGetPeers(from, signingKey);
        break;
      case 'PING':
        this.handlePing(from, signingKey);
        break;
      case 'DISCONNECT':
        this.handleDisconnect(from);
        break;
      default:
        console.log('[Tracker] Unknown message type:', message.type);
    }
  }

  private handleDisconnect(from: string): void {
    const b32 = toB32(from);
    if (this.stmtDeletePeer) {
      const result = this.stmtDeletePeer.run(from);
      if (result.changes > 0) {
        console.log(`[Tracker] Peer disconnected: ${b32.substring(0, 16)}...`);
      }
    }
  }

  private handleAnnounce(from: string, payload: any, signingKey?: string): void {
    const b32 = toB32(from);

    // Check existing peer
    const existingPeer = this.stmtGetPeer?.get(from) as Peer | undefined;
    const isNew = !existingPeer;

    // Verify signing key consistency (prevent signing key hijacking)
    if (existingPeer?.signingKey && signingKey && existingPeer.signingKey !== signingKey) {
      console.log(`[Tracker] Warning: Peer ${b32.substring(0, 16)}... attempted to change signing key`);
      return;
    }

    // Upsert peer into database
    if (this.stmtUpsertPeer) {
      this.stmtUpsertPeer.run(
        from,
        b32,
        payload.displayName || 'Unknown',
        payload.filesCount || 0,
        payload.totalSize || 0,
        Date.now(),
        payload.streamingDestination || null,
        signingKey || null
      );
    }

    if (isNew) {
      console.log(`[Tracker] New peer: ${b32.substring(0, 16)}... (${payload.displayName || 'Unknown'})`);
      if (payload.streamingDestination) {
        console.log(`[Tracker]   -> Has streaming destination`);
      }
      if (signingKey) {
        console.log(`[Tracker]   -> Has verified signing key`);
      }
    } else {
      console.log(`[Tracker] Peer update: ${b32.substring(0, 16)}... (${payload.filesCount || 0} files)`);
    }

    // Send back the current peer list
    this.sendPeersList(from);
  }

  private handleGetPeers(from: string, signingKey?: string): void {
    const b32 = toB32(from);
    console.log(`[Tracker] Peer list requested by ${b32.substring(0, 16)}...`);

    // Check if peer exists
    const existingPeer = this.stmtGetPeer?.get(from) as Peer | undefined;

    if (!existingPeer) {
      // Auto-register peer
      console.log(`[Tracker] Auto-registering unknown peer: ${b32.substring(0, 16)}...`);
      if (this.stmtUpsertPeer) {
        this.stmtUpsertPeer.run(
          from,
          b32,
          'Unknown',
          0,
          0,
          Date.now(),
          null,
          signingKey || null
        );
      }
    } else {
      // Update last seen
      if (this.stmtUpdateLastSeen) {
        this.stmtUpdateLastSeen.run(Date.now(), from);
      }
    }

    this.sendPeersList(from);
  }

  private handlePing(from: string, signingKey?: string): void {
    // Update last seen
    if (this.stmtUpdateLastSeen) {
      this.stmtUpdateLastSeen.run(Date.now(), from);
    }

    // Send pong
    this.sendMessage(from, {
      type: 'PONG',
      payload: {},
      timestamp: Date.now()
    });
  }

  private sendPeersList(to: string): void {
    if (!this.stmtGetActivePeers) return;

    // Get active peers (exclude requester, limit for large networks)
    const cutoff = Date.now() - this.config.peerTimeout;
    const peersList = this.stmtGetActivePeers.all(to, cutoff, this.config.maxPeersPerResponse) as Peer[];

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
      let data: Buffer;

      if (this.signingKeys) {
        // Sign the message with Ed25519
        const signedMsg = createSignedMessage(
          message,
          this.signingKeys.privateKey,
          this.signingKeys.publicKey
        );
        const msgWithSender = {
          ...signedMsg,
          _from: this.destination
        };
        data = Buffer.from(JSON.stringify(msgWithSender));
      } else {
        // Fallback to unsigned message (should not happen)
        const msgWithSender = {
          ...message,
          _from: this.destination
        };
        data = Buffer.from(JSON.stringify(msgWithSender));
      }

      this.sam.send(destination, data);
    } catch (error: any) {
      console.error('[Tracker] Failed to send message:', error.message);
    }
  }

  private cleanupInactivePeers(): void {
    if (!this.stmtCleanupPeers) return;

    const cutoff = Date.now() - this.config.peerTimeout;
    const result = this.stmtCleanupPeers.run(cutoff);

    if (result.changes > 0) {
      console.log(`[Tracker] Cleanup: removed ${result.changes} inactive peers`);
    }
  }

  private logStats(): void {
    const count = this.getPeerCount();
    console.log(`[Tracker] Stats: ${count} active peers`);
  }

  private getPeerCount(): number {
    if (!this.stmtGetPeerCount) return 0;
    const cutoff = Date.now() - this.config.peerTimeout;
    const row = this.stmtGetPeerCount.get(cutoff) as { count: number };
    return row?.count || 0;
  }

  getStats(): { peersCount: number; peers: Peer[] } {
    if (!this.db) {
      return { peersCount: 0, peers: [] };
    }

    const cutoff = Date.now() - this.config.peerTimeout;
    const count = this.getPeerCount();

    // Only return first 1000 peers in stats to avoid memory issues
    const peers = this.db.prepare(`
      SELECT * FROM peers WHERE lastSeen > ? ORDER BY lastSeen DESC LIMIT 1000
    `).all(cutoff) as Peer[];

    return {
      peersCount: count,
      peers
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

    if (this.nonceCleanupTimer) {
      clearInterval(this.nonceCleanupTimer);
      this.nonceCleanupTimer = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.sam) {
      try {
        this.sam.close();
      } catch (e) {
        // Ignore
      }
      this.sam = null;
    }

    // Close SQLite database
    if (this.db) {
      try {
        this.db.close();
        console.log('[Tracker] Database closed');
      } catch (e) {
        // Ignore
      }
      this.db = null;
    }

    // Clear prepared statements
    this.stmtUpsertPeer = null;
    this.stmtGetPeer = null;
    this.stmtDeletePeer = null;
    this.stmtGetActivePeers = null;
    this.stmtGetPeerCount = null;
    this.stmtCleanupPeers = null;
    this.stmtUpdateLastSeen = null;

    this.isRunning = false;
    this.usedNonces.clear();
    console.log('[Tracker] Stopped');
  }

  /**
   * Get the tracker's signing public key
   */
  getSigningPublicKey(): string | null {
    return this.signingKeys?.publicKey || null;
  }
}
