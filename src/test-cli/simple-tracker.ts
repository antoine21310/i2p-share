/**
 * Simplified Tracker Server for Testing
 * This version doesn't include the BEP3 BitTorrent tracker to avoid bencode dependency issues
 */

import { createLocalDestination, createRaw, toB32 } from '@diva.exchange/i2p-sam';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import {
  createSignedMessage,
  generateSigningKeypair,
  SignedMessage,
  SigningKeypair,
  verifySignedMessage
} from '../shared/utils.js';

interface Peer {
  destination: string;
  b32Address: string;
  displayName: string;
  filesCount: number;
  totalSize: number;
  lastSeen: number;
  streamingDestination?: string;
  signingKey?: string;
}

interface TrackerConfig {
  samHost: string;
  samPortTCP: number;
  samPortUDP: number;
  listenPort: number;
  peerTimeout: number;
  cleanupInterval: number;
  dataDir: string;
  maxPeersPerResponse: number;
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
  signingKeys?: SigningKeypair;
}

export class SimpleTracker extends EventEmitter {
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
  private usedNonces: Set<string> = new Set();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private dbSaveTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<TrackerConfig> = {}) {
    super();
    this.config = {
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      samPortUDP: config.samPortUDP || 7655,
      listenPort: config.listenPort || 7670,
      peerTimeout: config.peerTimeout || 90 * 1000,
      cleanupInterval: config.cleanupInterval || 30 * 1000,
      dataDir: config.dataDir || './tracker-data',
      maxPeersPerResponse: config.maxPeersPerResponse || 100
    };
  }

  private async initDatabase(): Promise<void> {
    this.dbPath = path.join(this.config.dataDir, 'tracker.db');

    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }

    const SQL = await initSqlJs();

    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
      console.log('[SimpleTracker] Loaded existing database');
    } else {
      this.db = new SQL.Database();
      console.log('[SimpleTracker] Created new database');
    }

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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS used_nonces (
        nonce TEXT PRIMARY KEY,
        createdAt INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS dht_nodes (
        nodeId TEXT PRIMARY KEY,
        destination TEXT NOT NULL,
        lastSeen INTEGER NOT NULL
      )
    `);

    this.dbSaveTimer = setInterval(() => {
      this.saveDatabase();
    }, 30000);

    console.log('[SimpleTracker] Database initialized');
  }

  private saveDatabase(): void {
    if (!this.db) return;
    try {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    } catch (e: any) {
      console.error('[SimpleTracker] Failed to save database:', e.message);
    }
  }

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
      console.error('[SimpleTracker] Query error:', e.message);
      return [];
    }
  }

  private dbRun(sql: string, params: any[] = []): { changes: number } {
    if (!this.db) return { changes: 0 };
    try {
      this.db.run(sql, params);
      return { changes: this.db.getRowsModified() };
    } catch (e: any) {
      console.error('[SimpleTracker] Run error:', e.message);
      return { changes: 0 };
    }
  }

  private getKeysPath(): string {
    return path.join(this.config.dataDir, 'tracker-keys.json');
  }

  private loadKeys(): StoredKeys | null {
    try {
      const keysPath = this.getKeysPath();
      if (fs.existsSync(keysPath)) {
        const data = fs.readFileSync(keysPath, 'utf-8');
        return JSON.parse(data) as StoredKeys;
      }
    } catch (error: any) {
      console.log('[SimpleTracker] Could not load keys:', error.message);
    }
    return null;
  }

  private saveKeys(): void {
    try {
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

      fs.writeFileSync(this.getKeysPath(), JSON.stringify(keys, null, 2));
    } catch (error: any) {
      console.error('[SimpleTracker] Could not save keys:', error.message);
    }
  }

  async start(): Promise<{ success: boolean; b32Address?: string; error?: string }> {
    console.log('[SimpleTracker] Starting...');

    try {
      await this.initDatabase();

      const existingKeys = this.loadKeys();

      if (existingKeys) {
        this.publicKey = existingKeys.publicKey;
        this.privateKey = existingKeys.privateKey;
        this.destination = existingKeys.destination;
        this.b32Address = existingKeys.b32Address;
        this.signingKeys = existingKeys.signingKeys || null;

        if (!this.signingKeys) {
          this.signingKeys = generateSigningKeypair();
          this.saveKeys();
        }
      } else {
        console.log('[SimpleTracker] Creating new I2P destination...');
        const destInfo = await createLocalDestination({
          sam: {
            host: this.config.samHost,
            portTCP: this.config.samPortTCP
          }
        });

        this.destination = destInfo.public;
        this.publicKey = destInfo.public;
        this.privateKey = destInfo.private;
        this.b32Address = destInfo.address;
        this.signingKeys = generateSigningKeypair();
        this.saveKeys();
      }

      console.log('[SimpleTracker] ═══════════════════════════════════════════════════════');
      console.log('[SimpleTracker] TRACKER READY!');
      console.log('[SimpleTracker] B32:', this.b32Address);
      console.log('[SimpleTracker] ═══════════════════════════════════════════════════════');

      await this.createSamSession();

      this.isRunning = true;

      this.cleanupTimer = setInterval(() => {
        this.cleanupInactivePeers();
      }, this.config.cleanupInterval);

      this.statsInterval = setInterval(() => {
        this.logStats();
      }, 30000);

      return { success: true, b32Address: this.b32Address };

    } catch (error: any) {
      console.error('[SimpleTracker] Failed to start:', error.message);
      return { success: false, error: error.message };
    }
  }

  private async createSamSession(): Promise<void> {
    const listenPort = this.config.listenPort + Math.floor(Math.random() * 100);

    console.log('[SimpleTracker] Creating RAW session on port', listenPort);

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

    this.sam.on('data', (data: Buffer) => {
      this.handleIncomingData(data);
    });

    this.sam.on('close', () => {
      console.log('[SimpleTracker] Session closed');
    });

    this.sam.on('error', (error: Error) => {
      console.error('[SimpleTracker] Session error:', error.message);
    });

    console.log('[SimpleTracker] RAW session created');
  }

  private handleIncomingData(data: Buffer): void {
    try {
      const str = data.toString();
      if (!str.startsWith('{')) return;

      const parsed = JSON.parse(str);

      if (parsed.signature && parsed.signingKey && parsed.nonce) {
        const signedMsg = parsed as SignedMessage & { _from?: string };
        const from = signedMsg._from || '';
        if (!from) return;

        const verification = verifySignedMessage({
          data: signedMsg.data,
          nonce: signedMsg.nonce,
          timestamp: signedMsg.timestamp,
          signature: signedMsg.signature,
          signingKey: signedMsg.signingKey
        });

        if (!verification.valid) {
          console.log(`[SimpleTracker] Rejected message: ${verification.error}`);
          return;
        }

        if (this.usedNonces.has(signedMsg.nonce)) {
          return;
        }
        this.usedNonces.add(signedMsg.nonce);

        const message = verification.data as TrackerMessage;
        this.handleMessage(from, message, signedMsg.signingKey);
      } else {
        const message = parsed as TrackerMessage & { _from?: string };
        const from = message._from || '';
        delete message._from;
        if (!from) return;

        this.handleMessage(from, message);
      }
    } catch (e) {
      // Ignore
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
        this.handlePing(from);
        break;
      case 'DISCONNECT':
        this.handleDisconnect(from);
        break;
    }
  }

  private handleAnnounce(from: string, payload: any, signingKey?: string): void {
    const b32 = toB32(from);

    const existingPeers = this.dbQuery('SELECT * FROM peers WHERE destination = ?', [from]);
    const isNew = existingPeers.length === 0;

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
      lastSeen: Date.now()
    };

    if (isNew) {
      console.log(`[SimpleTracker] New peer: ${b32.substring(0, 16)}... (${payload.displayName || 'Unknown'})`);
      this.broadcastPeerOnline(peerData);
    } else {
      console.log(`[SimpleTracker] Peer update: ${b32.substring(0, 16)}... (${payload.filesCount || 0} files)`);
    }

    this.sendPeersList(from);
  }

  private handleGetPeers(from: string, signingKey?: string): void {
    const b32 = toB32(from);
    console.log(`[SimpleTracker] Peer list requested by ${b32.substring(0, 16)}...`);

    const existingPeers = this.dbQuery('SELECT * FROM peers WHERE destination = ?', [from]);

    if (existingPeers.length === 0) {
      this.dbRun(`
        INSERT INTO peers (destination, b32Address, displayName, filesCount, totalSize, lastSeen, signingKey)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [from, b32, 'Unknown', 0, 0, Date.now(), signingKey || null]);
    } else {
      this.dbRun('UPDATE peers SET lastSeen = ? WHERE destination = ?', [Date.now(), from]);
    }

    this.sendPeersList(from);
  }

  private handlePing(from: string): void {
    this.dbRun('UPDATE peers SET lastSeen = ? WHERE destination = ?', [Date.now(), from]);

    this.sendMessage(from, {
      type: 'PONG',
      payload: {},
      timestamp: Date.now()
    });
  }

  private handleDisconnect(from: string): void {
    const b32 = toB32(from);
    const result = this.dbRun('DELETE FROM peers WHERE destination = ?', [from]);
    if (result.changes > 0) {
      console.log(`[SimpleTracker] Peer disconnected: ${b32.substring(0, 16)}...`);
      this.broadcastPeerOffline(from, b32);
    }
  }

  private handleGetDHTNodes(from: string): void {
    const b32 = toB32(from);
    console.log(`[SimpleTracker] DHT nodes requested by ${b32.substring(0, 16)}...`);

    const cutoff = Date.now() - this.config.peerTimeout;
    const nodesList = this.dbQuery(`
      SELECT destination FROM peers
      WHERE destination != ? AND lastSeen > ?
      ORDER BY RANDOM() LIMIT 50
    `, [from, cutoff]);

    this.sendMessage(from, {
      type: 'DHT_NODES_LIST',
      payload: { nodes: nodesList.map(n => ({ nodeId: '', destination: n.destination })) },
      timestamp: Date.now()
    });
  }

  private sendPeersList(to: string): void {
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

    console.log(`[SimpleTracker] Sent ${peersList.length} peers to ${toB32(to).substring(0, 16)}...`);
  }

  private sendMessage(destination: string, message: TrackerMessage): void {
    if (!this.sam) return;

    try {
      let data: Buffer;

      if (this.signingKeys) {
        const signedMsg = createSignedMessage(
          message,
          this.signingKeys.privateKey,
          this.signingKeys.publicKey
        );
        const msgWithSender = { ...signedMsg, _from: this.destination };
        data = Buffer.from(JSON.stringify(msgWithSender));
      } else {
        const msgWithSender = { ...message, _from: this.destination };
        data = Buffer.from(JSON.stringify(msgWithSender));
      }

      this.sam.send(destination, data);
    } catch (error: any) {
      console.error('[SimpleTracker] Failed to send:', error.message);
    }
  }

  private broadcastToAllPeers(message: TrackerMessage, exceptDestination?: string): void {
    const cutoff = Date.now() - this.config.peerTimeout;
    const activePeers = this.dbQuery(`
      SELECT destination FROM peers WHERE lastSeen > ?
    `, [cutoff]) as { destination: string }[];

    for (const peer of activePeers) {
      if (peer.destination !== exceptDestination) {
        this.sendMessage(peer.destination, message);
      }
    }
  }

  private broadcastPeerOnline(peer: Peer): void {
    this.broadcastToAllPeers({
      type: 'PEER_ONLINE',
      payload: {
        destination: peer.destination,
        b32Address: peer.b32Address,
        displayName: peer.displayName,
        filesCount: peer.filesCount,
        totalSize: peer.totalSize
      },
      timestamp: Date.now()
    }, peer.destination);
  }

  private broadcastPeerOffline(destination: string, b32Address: string): void {
    this.broadcastToAllPeers({
      type: 'PEER_OFFLINE',
      payload: { destination, b32Address },
      timestamp: Date.now()
    });
  }

  private cleanupInactivePeers(): void {
    const cutoff = Date.now() - this.config.peerTimeout;

    const stalePeers = this.dbQuery(`
      SELECT destination, b32Address FROM peers WHERE lastSeen < ?
    `, [cutoff]) as { destination: string; b32Address: string }[];

    const result = this.dbRun('DELETE FROM peers WHERE lastSeen < ?', [cutoff]);

    if (result.changes > 0) {
      console.log(`[SimpleTracker] Cleanup: removed ${result.changes} inactive peers`);
      for (const stalePeer of stalePeers) {
        this.broadcastPeerOffline(stalePeer.destination, stalePeer.b32Address);
      }
    }
  }

  private logStats(): void {
    const count = this.getPeerCount();
    console.log(`[SimpleTracker] Stats: ${count} active peers`);
  }

  private getPeerCount(): number {
    const cutoff = Date.now() - this.config.peerTimeout;
    const rows = this.dbQuery('SELECT COUNT(*) as count FROM peers WHERE lastSeen > ?', [cutoff]);
    return rows[0]?.count || 0;
  }

  getAddress(): string {
    return this.b32Address;
  }

  getDestination(): string {
    return this.destination;
  }

  async stop(): Promise<void> {
    console.log('[SimpleTracker] Stopping...');
    this.isRunning = false;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
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

    if (this.db) {
      try {
        this.saveDatabase();
        this.db.close();
      } catch (e) {
        // Ignore
      }
      this.db = null;
    }

    this.usedNonces.clear();
    console.log('[SimpleTracker] Stopped');
  }
}
