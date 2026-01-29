import { createForward, createLocalDestination, createRaw, toB32 } from '@diva.exchange/i2p-sam';
import { EventEmitter } from 'events';
import fs from 'fs';
import net from 'net';
import path from 'path';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import {
    createSignedMessage,
    generateSigningKeypair,
    SignedMessage,
    SigningKeypair,
    verifySignedMessage
} from '../shared/utils.js';
import {
    BTAnnounceHandler,
    createErrorHttpResponse,
    parseAnnounceQuery
} from './bt-announce-handler.js';

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
  /** Port for BEP3 HTTP tracker (streaming) */
  httpTrackerPort: number;
  /** Enable BEP3 BitTorrent tracker */
  enableBTTracker: boolean;
}

interface TrackerMessage {
  type: 'ANNOUNCE' | 'GET_PEERS' | 'PEERS_LIST' | 'PING' | 'PONG' | 'DISCONNECT' | 'GET_DHT_NODES' | 'DHT_NODES_LIST' | 'PEER_ONLINE' | 'PEER_OFFLINE';
  payload: any;
  timestamp: number;
}

interface DHTNode {
  nodeId: string;
  destination: string;
  lastSeen: number;
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
  private db: SqlJsDatabase | null = null;
  private dbPath: string = '';
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
  private dbSaveTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private static readonly HEARTBEAT_INTERVAL = 30 * 1000; // Check every 30s
  private static readonly HEARTBEAT_TIMEOUT = 90 * 1000;  // Mark offline after 90s without ping

  // BEP3 BitTorrent HTTP Tracker
  private btAnnounceHandler: BTAnnounceHandler | null = null;
  private httpServer: net.Server | null = null;
  private samForward: any = null;
  private btTrackerDestination: string = '';
  private btTrackerB32: string = '';

  constructor(config: Partial<TrackerConfig> = {}) {
    super();
    this.config = {
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      samPortUDP: config.samPortUDP || 7655,
      listenPort: config.listenPort || 7670,
      peerTimeout: config.peerTimeout || 90 * 1000, // 90 seconds - for real-time presence
      cleanupInterval: config.cleanupInterval || 30 * 1000, // Check every 30 seconds
      dataDir: config.dataDir || './tracker-data',
      maxPeersPerResponse: config.maxPeersPerResponse || 100, // Limit per response for large networks
      httpTrackerPort: config.httpTrackerPort || 7680,
      enableBTTracker: config.enableBTTracker ?? true
    };
  }

  /**
   * Initialize SQLite database for peer storage using sql.js (pure JS)
   * Optimized for 100k+ peers with proper indexing
   */
  private async initDatabase(): Promise<void> {
    this.dbPath = path.join(this.config.dataDir, 'tracker.db');

    // Ensure directory exists
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }

    // Initialize sql.js
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
      console.log('[Tracker] Loaded existing database from:', this.dbPath);
    } else {
      this.db = new SQL.Database();
      console.log('[Tracker] Created new database');
    }

    // Create peers table with proper indexing
    this.db.run(`
      CREATE TABLE IF NOT EXISTS peers (
        destination TEXT PRIMARY KEY,
        b32Address TEXT NOT NULL,
        displayName TEXT DEFAULT 'Unknown',
        filesCount INTEGER DEFAULT 0,
        totalSize INTEGER DEFAULT 0,
        lastSeen INTEGER NOT NULL,
        streamingDestination TEXT,
        signingKey TEXT
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_peers_lastSeen ON peers(lastSeen)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_peers_b32 ON peers(b32Address)`);

    // Used nonces table for replay protection
    this.db.run(`
      CREATE TABLE IF NOT EXISTS used_nonces (
        nonce TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_nonces_created ON used_nonces(createdAt)`);

    // DHT nodes table for bootstrap
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dht_nodes (
        nodeId TEXT PRIMARY KEY,
        destination TEXT NOT NULL,
        lastSeen INTEGER NOT NULL
      )
    `);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_dht_nodes_lastSeen ON dht_nodes(lastSeen)`);

    // Save database periodically (every 30 seconds)
    this.dbSaveTimer = setInterval(() => {
      this.saveDatabase();
    }, 30000);

    console.log('[Tracker] SQLite database initialized at:', this.dbPath);
  }

  /**
   * Save database to disk
   */
  private saveDatabase(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (e: any) {
      console.error('[Tracker] Failed to save database:', e.message);
    }
  }

  /**
   * Execute a query and get results
   */
  private dbQuery(sql: string, params: any[] = []): any[] {
    if (!this.db) return [];
    try {
      const stmt = this.db.prepare(sql);
      stmt.bind(params);
      const results: any[] = [];
      while (stmt.step()) {
        results.push(stmt.getAsObject());
      }
      stmt.free();
      return results;
    } catch (e: any) {
      console.error('[Tracker] Query error:', e.message);
      return [];
    }
  }

  /**
   * Execute a query without expecting results
   */
  private dbRun(sql: string, params: any[] = []): { changes: number } {
    if (!this.db) return { changes: 0 };
    try {
      this.db.run(sql, params);
      return { changes: this.db.getRowsModified() };
    } catch (e: any) {
      console.error('[Tracker] Run error:', e.message);
      return { changes: 0 };
    }
  }

  /**
   * Check if a nonce has been used (replay attack protection)
   */
  private isNonceUsed(nonce: string): boolean {
    const rows = this.dbQuery('SELECT 1 FROM used_nonces WHERE nonce = ?', [nonce]);
    return rows.length > 0;
  }

  /**
   * Mark a nonce as used
   */
  private markNonceUsed(nonce: string): void {
    this.dbRun('INSERT OR IGNORE INTO used_nonces (nonce, createdAt) VALUES (?, ?)', [nonce, Date.now()]);
  }

  /**
   * Clean up old nonces from database
   */
  private cleanupNonces(): void {
    const cutoff = Date.now() - (10 * 60 * 1000); // 10 minutes
    this.dbRun('DELETE FROM used_nonces WHERE createdAt < ?', [cutoff]);
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

  async start(): Promise<{ success: boolean; b32Address?: string; btTrackerDestination?: string; btTrackerB32?: string; error?: string }> {
    console.log('[Tracker] Starting tracker server...');
    console.log('[Tracker] SAM bridge:', `${this.config.samHost}:${this.config.samPortTCP}`);
    console.log('[Tracker] Data directory:', this.config.dataDir);

    try {
      // Initialize SQLite database first (async for sql.js)
      await this.initDatabase();

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

      // Start BEP3 BitTorrent HTTP tracker if enabled
      if (this.config.enableBTTracker) {
        await this.startBTTracker();
      }

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
        b32Address: this.b32Address,
        btTrackerDestination: this.btTrackerDestination || undefined,
        btTrackerB32: this.btTrackerB32 || undefined
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
      case 'GET_DHT_NODES':
        this.handleGetDHTNodes(from);
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
    const result = this.dbRun('DELETE FROM peers WHERE destination = ?', [from]);
    if (result.changes > 0) {
      console.log(`[Tracker] Peer disconnected: ${b32.substring(0, 16)}...`);
      // Broadcast PEER_OFFLINE to all other connected peers
      this.broadcastPeerOffline(from, b32);
    }
  }

  private handleAnnounce(from: string, payload: any, signingKey?: string): void {
    const b32 = toB32(from);

    // Check existing peer
    const existingPeers = this.dbQuery('SELECT * FROM peers WHERE destination = ?', [from]);
    const existingPeer = existingPeers[0] as Peer | undefined;
    const isNew = !existingPeer;

    // Verify signing key consistency (prevent signing key hijacking)
    if (existingPeer?.signingKey && signingKey && existingPeer.signingKey !== signingKey) {
      console.log(`[Tracker] Warning: Peer ${b32.substring(0, 16)}... attempted to change signing key`);
      return;
    }

    // Upsert peer into database
    this.dbRun(`
      INSERT INTO peers (destination, b32Address, displayName, filesCount, totalSize, lastSeen, streamingDestination, signingKey)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(destination) DO UPDATE SET
        displayName = excluded.displayName,
        filesCount = excluded.filesCount,
        totalSize = excluded.totalSize,
        lastSeen = excluded.lastSeen,
        streamingDestination = excluded.streamingDestination,
        signingKey = COALESCE(peers.signingKey, excluded.signingKey)
    `, [
      from,
      b32,
      payload.displayName || 'Unknown',
      payload.filesCount || 0,
      payload.totalSize || 0,
      Date.now(),
      payload.streamingDestination || null,
      signingKey || null
    ]);

    const peerData = {
      destination: from,
      b32Address: b32,
      displayName: payload.displayName || 'Unknown',
      filesCount: payload.filesCount || 0,
      totalSize: payload.totalSize || 0,
      lastSeen: Date.now(),
      streamingDestination: payload.streamingDestination
    };

    if (isNew) {
      console.log(`[Tracker] New peer: ${b32.substring(0, 16)}... (${payload.displayName || 'Unknown'})`);
      if (payload.streamingDestination) {
        console.log(`[Tracker]   -> Has streaming destination`);
      }
      if (signingKey) {
        console.log(`[Tracker]   -> Has verified signing key`);
      }

      // Broadcast PEER_ONLINE to all other connected peers
      this.broadcastPeerOnline(peerData);

      // Emit local event for embedded tracker to notify main process
      this.emit('peer:connected', peerData);
    } else {
      console.log(`[Tracker] Peer update: ${b32.substring(0, 16)}... (${payload.filesCount || 0} files)`);
      // Also emit update event for existing peers
      this.emit('peer:updated', peerData);
    }

    // Store as DHT node if nodeId is provided (for DHT bootstrap)
    if (payload.nodeId) {
      this.dbRun(`
        INSERT INTO dht_nodes (nodeId, destination, lastSeen)
        VALUES (?, ?, ?)
        ON CONFLICT(nodeId) DO UPDATE SET
          destination = excluded.destination,
          lastSeen = excluded.lastSeen
      `, [payload.nodeId, from, Date.now()]);
      console.log(`[Tracker]   -> DHT node registered: ${payload.nodeId.substring(0, 16)}...`);
    }

    // Send back the current peer list AND DHT nodes for bootstrap
    this.sendPeersList(from);
    this.sendDHTNodesList(from);
  }

  private handleGetPeers(from: string, signingKey?: string): void {
    const b32 = toB32(from);
    console.log(`[Tracker] Peer list requested by ${b32.substring(0, 16)}...`);

    // Check if peer exists
    const existingPeers = this.dbQuery('SELECT * FROM peers WHERE destination = ?', [from]);
    const existingPeer = existingPeers[0] as Peer | undefined;

    if (!existingPeer) {
      // Auto-register peer
      console.log(`[Tracker] Auto-registering unknown peer: ${b32.substring(0, 16)}...`);
      this.dbRun(`
        INSERT INTO peers (destination, b32Address, displayName, filesCount, totalSize, lastSeen, streamingDestination, signingKey)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [from, b32, 'Unknown', 0, 0, Date.now(), null, signingKey || null]);
    } else {
      // Update last seen
      this.dbRun('UPDATE peers SET lastSeen = ? WHERE destination = ?', [Date.now(), from]);
    }

    this.sendPeersList(from);
  }

  private handlePing(from: string, signingKey?: string): void {
    // Update last seen
    this.dbRun('UPDATE peers SET lastSeen = ? WHERE destination = ?', [Date.now(), from]);

    // Send pong
    this.sendMessage(from, {
      type: 'PONG',
      payload: {},
      timestamp: Date.now()
    });
  }

  /**
   * Handle GET_DHT_NODES request - returns known DHT nodes for bootstrap
   */
  private handleGetDHTNodes(from: string): void {
    const b32 = toB32(from);
    console.log(`[Tracker] DHT nodes requested by ${b32.substring(0, 16)}...`);
    this.sendDHTNodesList(from);
  }

  /**
   * Send list of known DHT nodes to a peer for bootstrap
   */
  private sendDHTNodesList(to: string): void {
    // Get active DHT nodes (exclude requester, limit for bandwidth)
    const cutoff = Date.now() - this.config.peerTimeout;
    const nodesList = this.dbQuery(`
      SELECT nodeId, destination
      FROM dht_nodes
      WHERE destination != ? AND lastSeen > ?
      ORDER BY lastSeen DESC
      LIMIT 50
    `, [to, cutoff]) as DHTNode[];

    if (nodesList.length === 0) {
      // If no DHT nodes yet, use peers as fallback
      const peersList = this.dbQuery(`
        SELECT destination
        FROM peers
        WHERE destination != ? AND lastSeen > ?
        ORDER BY RANDOM()
        LIMIT 50
      `, [to, cutoff]);

      // Create pseudo DHT nodes from peers (they can be contacted for DHT)
      for (const peer of peersList) {
        nodesList.push({
          nodeId: '', // Will be filled by the peer itself
          destination: peer.destination as string,
          lastSeen: Date.now()
        });
      }
    }

    this.sendMessage(to, {
      type: 'DHT_NODES_LIST',
      payload: { nodes: nodesList },
      timestamp: Date.now()
    });

    console.log(`[Tracker] Sent ${nodesList.length} DHT nodes to ${toB32(to).substring(0, 16)}...`);
  }

  private sendPeersList(to: string): void {
    // Get active peers (exclude requester, random order, limit for large networks)
    const cutoff = Date.now() - this.config.peerTimeout;
    const peersList = this.dbQuery(`
      SELECT destination, b32Address, displayName, filesCount, totalSize, streamingDestination
      FROM peers
      WHERE destination != ? AND lastSeen > ?
      ORDER BY RANDOM()
      LIMIT ?
    `, [to, cutoff, this.config.maxPeersPerResponse]) as Peer[];

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

  /**
   * Broadcast a message to all active peers except one (usually the sender)
   */
  private broadcastToAllPeers(message: TrackerMessage, exceptDestination?: string): void {
    const cutoff = Date.now() - this.config.peerTimeout;
    const activePeers = this.dbQuery(`
      SELECT destination FROM peers WHERE lastSeen > ?
    `, [cutoff]) as { destination: string }[];

    let sentCount = 0;
    for (const peer of activePeers) {
      if (peer.destination !== exceptDestination) {
        this.sendMessage(peer.destination, message);
        sentCount++;
      }
    }

    if (sentCount > 0) {
      console.log(`[Tracker] Broadcast ${message.type} to ${sentCount} peers`);
    }
  }

  /**
   * Notify all peers that a new peer is online
   */
  private broadcastPeerOnline(peer: Peer): void {
    this.broadcastToAllPeers({
      type: 'PEER_ONLINE',
      payload: {
        destination: peer.destination,
        b32Address: peer.b32Address,
        displayName: peer.displayName,
        filesCount: peer.filesCount,
        totalSize: peer.totalSize,
        streamingDestination: peer.streamingDestination
      },
      timestamp: Date.now()
    }, peer.destination);
  }

  /**
   * Notify all peers that a peer went offline
   */
  private broadcastPeerOffline(destination: string, b32Address: string): void {
    this.broadcastToAllPeers({
      type: 'PEER_OFFLINE',
      payload: {
        destination,
        b32Address
      },
      timestamp: Date.now()
    });
  }

  private cleanupInactivePeers(): void {
    const cutoff = Date.now() - this.config.peerTimeout;

    // First, get the peers that will be removed (to broadcast PEER_OFFLINE)
    const stalePeers = this.dbQuery(`
      SELECT destination, b32Address FROM peers WHERE lastSeen < ?
    `, [cutoff]) as { destination: string; b32Address: string }[];

    // Delete inactive peers
    const result = this.dbRun('DELETE FROM peers WHERE lastSeen < ?', [cutoff]);

    if (result.changes > 0) {
      console.log(`[Tracker] Cleanup: removed ${result.changes} inactive peers`);

      // Broadcast PEER_OFFLINE for each removed peer
      for (const stalePeer of stalePeers) {
        this.broadcastPeerOffline(stalePeer.destination, stalePeer.b32Address);
      }
    }

    // Also cleanup inactive DHT nodes
    const dhtResult = this.dbRun('DELETE FROM dht_nodes WHERE lastSeen < ?', [cutoff]);
    if (dhtResult.changes > 0) {
      console.log(`[Tracker] Cleanup: removed ${dhtResult.changes} inactive DHT nodes`);
    }
  }

  private logStats(): void {
    const count = this.getPeerCount();
    console.log(`[Tracker] Stats: ${count} active peers`);
  }

  private getPeerCount(): number {
    const cutoff = Date.now() - this.config.peerTimeout;
    const rows = this.dbQuery('SELECT COUNT(*) as count FROM peers WHERE lastSeen > ?', [cutoff]);
    return rows[0]?.count || 0;
  }

  getStats(): { peersCount: number; peers: Peer[] } {
    const cutoff = Date.now() - this.config.peerTimeout;
    const count = this.getPeerCount();

    // Only return first 1000 peers in stats to avoid memory issues
    const peers = this.dbQuery(`
      SELECT * FROM peers WHERE lastSeen > ? ORDER BY lastSeen DESC LIMIT 1000
    `, [cutoff]) as Peer[];

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

  /**
   * Register the local host as a peer in the tracker (without going through I2P)
   * This allows other peers connecting to this tracker to discover the host
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
    if (!this.db) return;

    console.log(`[Tracker] Registering local host as peer: ${peer.b32Address.substring(0, 16)}...`);

    this.dbRun(`
      INSERT INTO peers (destination, b32Address, displayName, filesCount, totalSize, lastSeen, streamingDestination)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(destination) DO UPDATE SET
        displayName = excluded.displayName,
        filesCount = excluded.filesCount,
        totalSize = excluded.totalSize,
        lastSeen = excluded.lastSeen,
        streamingDestination = excluded.streamingDestination
    `, [
      peer.destination,
      peer.b32Address,
      peer.displayName,
      peer.filesCount || 0,
      peer.totalSize || 0,
      Date.now(),
      peer.streamingDestination || null
    ]);

    // Also register as DHT node if nodeId provided
    if (peer.nodeId) {
      this.dbRun(`
        INSERT INTO dht_nodes (nodeId, destination, lastSeen)
        VALUES (?, ?, ?)
        ON CONFLICT(nodeId) DO UPDATE SET
          destination = excluded.destination,
          lastSeen = excluded.lastSeen
      `, [peer.nodeId, peer.destination, Date.now()]);
    }

    console.log(`[Tracker] Local host registered successfully`);
  }

  async stop(): Promise<void> {
    console.log('[Tracker] Stopping...');
    this.isRunning = false;

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

    if (this.dbSaveTimer) {
      clearInterval(this.dbSaveTimer);
      this.dbSaveTimer = null;
    }

    if (this.sam) {
      try {
        this.sam.close();
      } catch (e) {
        // Ignore
      }
      this.sam = null;
    }

    // Stop BT tracker
    await this.stopBTTracker();

    // Save and close SQLite database
    if (this.db) {
      try {
        // Final save before closing
        this.saveDatabase();
        console.log('[Tracker] Database saved');
        this.db.close();
        console.log('[Tracker] Database closed');
      } catch (e) {
        // Ignore
      }
      this.db = null;
    }

    this.usedNonces.clear();
    console.log('[Tracker] Stopped');
  }

  /**
   * Get the tracker's signing public key
   */
  getSigningPublicKey(): string | null {
    return this.signingKeys?.publicKey || null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BEP3 BitTorrent HTTP Tracker
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Start the BEP3 BitTorrent HTTP tracker
   * Creates a local TCP server and forwards I2P streaming connections to it
   */
  private async startBTTracker(): Promise<void> {
    console.log('[Tracker] Starting BEP3 BitTorrent HTTP tracker...');

    // Initialize BTAnnounceHandler
    this.btAnnounceHandler = new BTAnnounceHandler({
      announceInterval: 1800,       // 30 minutes
      minAnnounceInterval: 60,      // 1 minute
      peerTimeout: this.config.peerTimeout,
      maxPeersPerResponse: this.config.maxPeersPerResponse
    });

    // Create local TCP server for HTTP requests
    const httpPort = this.config.httpTrackerPort + Math.floor(Math.random() * 100);

    this.httpServer = net.createServer((socket) => {
      this.handleBTConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(httpPort, '127.0.0.1', () => {
        console.log(`[Tracker] BT HTTP server listening on 127.0.0.1:${httpPort}`);
        resolve();
      });
      this.httpServer!.on('error', reject);
    });

    // Create I2P streaming forward to the local HTTP server
    try {
      this.samForward = await createForward({
        sam: {
          host: this.config.samHost,
          portTCP: this.config.samPortTCP
        },
        forward: {
          host: '127.0.0.1',
          port: httpPort
        }
      });

      // Get the destination for the BT tracker
      this.btTrackerDestination = this.samForward.getPublicKey();
      this.btTrackerB32 = toB32(this.btTrackerDestination);

      console.log('[Tracker] ════════════════════════════════════════════════════════');
      console.log('[Tracker] BEP3 BITTORRENT TRACKER READY!');
      console.log('[Tracker]');
      console.log('[Tracker] BT Tracker B32 Address:');
      console.log('[Tracker]   ' + this.btTrackerB32);
      console.log('[Tracker]');
      console.log('[Tracker] BT Tracker Destination (for .torrent files):');
      console.log('[Tracker]   ' + this.btTrackerDestination);
      console.log('[Tracker] ════════════════════════════════════════════════════════');

      // Save BT tracker destination to file
      const btDestFile = path.join(this.config.dataDir, 'bt-tracker-destination.txt');
      fs.writeFileSync(btDestFile, this.btTrackerDestination);
      console.log('[Tracker] BT Tracker destination saved to:', btDestFile);

    } catch (error: any) {
      console.error('[Tracker] Failed to create I2P forward for BT tracker:', error.message);
      // Continue without BT tracker - the main tracker still works
      if (this.httpServer) {
        this.httpServer.close();
        this.httpServer = null;
      }
    }
  }

  /**
   * Handle incoming BT tracker HTTP connection
   */
  private handleBTConnection(socket: net.Socket): void {
    let requestBuffer = Buffer.alloc(0);
    const remoteAddress = socket.remoteAddress || 'unknown';

    socket.on('data', (data) => {
      requestBuffer = Buffer.concat([requestBuffer, data]);

      // Check if we have a complete HTTP request
      const requestStr = requestBuffer.toString('utf8');
      const headerEnd = requestStr.indexOf('\r\n\r\n');

      if (headerEnd === -1) {
        // Not complete yet, wait for more data
        if (requestBuffer.length > 65536) {
          // Request too large
          socket.write(createErrorHttpResponse(413, 'Request too large'));
          socket.end();
        }
        return;
      }

      // Parse HTTP request
      const headers = requestStr.substring(0, headerEnd);
      const lines = headers.split('\r\n');
      const requestLine = lines[0];

      const match = requestLine.match(/^(GET|POST) ([^ ]+) HTTP\/\d\.\d$/);
      if (!match) {
        socket.write(createErrorHttpResponse(400, 'Bad Request'));
        socket.end();
        return;
      }

      const method = match[1];
      const fullPath = match[2];

      // Parse URL
      const urlParts = fullPath.split('?');
      const urlPath = urlParts[0];
      const queryString = urlParts[1] || '';

      console.log(`[Tracker] BT HTTP ${method} ${urlPath}`);

      // Route request
      if (urlPath === '/announce' || urlPath === '/announce.php') {
        this.handleBTAnnounce(socket, queryString, remoteAddress);
      } else if (urlPath === '/scrape' || urlPath === '/scrape.php') {
        this.handleBTScrape(socket, queryString);
      } else if (urlPath === '/stats' || urlPath === '/') {
        this.handleBTStats(socket);
      } else {
        socket.write(createErrorHttpResponse(404, 'Not Found'));
        socket.end();
      }
    });

    socket.on('error', (error) => {
      console.error('[Tracker] BT socket error:', error.message);
    });

    // Set timeout
    socket.setTimeout(30000, () => {
      socket.end();
    });
  }

  /**
   * Handle BEP3 announce request
   */
  private handleBTAnnounce(socket: net.Socket, queryString: string, requesterDest?: string): void {
    if (!this.btAnnounceHandler) {
      socket.write(createErrorHttpResponse(500, 'Tracker not initialized'));
      socket.end();
      return;
    }

    const params = parseAnnounceQuery(queryString);
    if (!params) {
      socket.write(createErrorHttpResponse(400, 'Invalid announce parameters'));
      socket.end();
      return;
    }

    try {
      const responseBody = this.btAnnounceHandler.handleAnnounce(params, requesterDest);

      // Build HTTP response
      const headers = [
        'HTTP/1.1 200 OK',
        'Content-Type: text/plain',
        `Content-Length: ${responseBody.length}`,
        'Connection: close',
        '',
        ''
      ].join('\r\n');

      socket.write(headers);
      socket.write(responseBody);
      socket.end();

    } catch (error: any) {
      console.error('[Tracker] BT announce error:', error.message);
      socket.write(createErrorHttpResponse(500, 'Internal error'));
      socket.end();
    }
  }

  /**
   * Handle BEP3 scrape request
   */
  private handleBTScrape(socket: net.Socket, queryString: string): void {
    if (!this.btAnnounceHandler) {
      socket.write(createErrorHttpResponse(500, 'Tracker not initialized'));
      socket.end();
      return;
    }

    try {
      // Parse info_hash parameters
      const params = new URLSearchParams(queryString);
      const infoHashes: string[] = [];

      // Can have multiple info_hash params
      const allParams = queryString.split('&');
      for (const param of allParams) {
        if (param.startsWith('info_hash=')) {
          const encoded = param.substring(10);
          const decoded = decodeURIComponent(encoded);
          if (decoded.length === 20) {
            infoHashes.push(Buffer.from(decoded, 'binary').toString('hex'));
          } else if (decoded.length === 40 && /^[0-9a-fA-F]+$/.test(decoded)) {
            infoHashes.push(decoded.toLowerCase());
          }
        }
      }

      if (infoHashes.length === 0) {
        socket.write(createErrorHttpResponse(400, 'Missing info_hash'));
        socket.end();
        return;
      }

      const responseBody = this.btAnnounceHandler.handleScrape(infoHashes);

      const headers = [
        'HTTP/1.1 200 OK',
        'Content-Type: text/plain',
        `Content-Length: ${responseBody.length}`,
        'Connection: close',
        '',
        ''
      ].join('\r\n');

      socket.write(headers);
      socket.write(responseBody);
      socket.end();

    } catch (error: any) {
      console.error('[Tracker] BT scrape error:', error.message);
      socket.write(createErrorHttpResponse(500, 'Internal error'));
      socket.end();
    }
  }

  /**
   * Handle tracker stats request (simple HTML page)
   */
  private handleBTStats(socket: net.Socket): void {
    const stats = this.btAnnounceHandler?.getStatistics() || {
      torrents: 0,
      totalPeers: 0,
      totalSeeders: 0,
      totalLeechers: 0
    };

    const peerStats = this.getStats();

    const html = `<!DOCTYPE html>
<html>
<head><title>I2P-Share Tracker</title></head>
<body>
<h1>I2P-Share Tracker</h1>
<h2>Peer Discovery (Datagram)</h2>
<p>Active peers: ${peerStats.peersCount}</p>
<h2>BitTorrent Tracker (BEP3)</h2>
<p>Tracked torrents: ${stats.torrents}</p>
<p>Total peers: ${stats.totalPeers}</p>
<p>Seeders: ${stats.totalSeeders}</p>
<p>Leechers: ${stats.totalLeechers}</p>
</body>
</html>`;

    const body = Buffer.from(html, 'utf8');
    const headers = [
      'HTTP/1.1 200 OK',
      'Content-Type: text/html; charset=utf-8',
      `Content-Length: ${body.length}`,
      'Connection: close',
      '',
      ''
    ].join('\r\n');

    socket.write(headers);
    socket.write(body);
    socket.end();
  }

  /**
   * Stop the BT tracker
   */
  private async stopBTTracker(): Promise<void> {
    if (this.btAnnounceHandler) {
      this.btAnnounceHandler.stop();
      this.btAnnounceHandler = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }

    if (this.samForward) {
      try {
        this.samForward.close();
      } catch (e) {
        // Ignore
      }
      this.samForward = null;
    }

    console.log('[Tracker] BT tracker stopped');
  }

  /**
   * Get the BT tracker destination
   */
  getBTTrackerDestination(): string {
    return this.btTrackerDestination;
  }

  /**
   * Get the BT tracker B32 address
   */
  getBTTrackerB32(): string {
    return this.btTrackerB32;
  }

  /**
   * Get BT tracker statistics
   */
  getBTTrackerStats(): { torrents: number; totalPeers: number; totalSeeders: number; totalLeechers: number } | null {
    return this.btAnnounceHandler?.getStatistics() || null;
  }
}
