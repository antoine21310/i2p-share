/**
 * Standalone I2P-Share Client for Testing
 * This client does not depend on Electron and can run as a pure Node.js process
 */

import { createLocalDestination, createRaw, toB32 } from '@diva.exchange/i2p-sam';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import {
  createSignedMessage,
  generateSigningKeypair,
  SigningKeypair,
  verifySignedMessage
} from '../shared/utils.js';

// ============================================================================
// TYPES
// ============================================================================

interface ClientConfig {
  name: string;
  dataDir: string;
  samHost: string;
  samPortTCP: number;
  samPortUDP: number;
  listenPort: number;
}

interface TrackerPeer {
  destination: string;
  b32Address: string;
  displayName: string;
  filesCount: number;
  totalSize: number;
  streamingDestination?: string;
}

interface SharedFile {
  path: string;
  filename: string;
  hash: string;
  size: number;
  mimeType: string;
}

interface TrackerMessage {
  type: 'ANNOUNCE' | 'GET_PEERS' | 'PEERS_LIST' | 'PING' | 'PONG' | 'DISCONNECT' | 'GET_DHT_NODES' | 'DHT_NODES_LIST' | 'PEER_ONLINE' | 'PEER_OFFLINE' | 'SEARCH' | 'SEARCH_RESULTS' | 'GET_FILES' | 'FILES_LIST';
  payload: any;
  timestamp: number;
  _from?: string;
}

interface PeerMessage {
  type: 'SEARCH' | 'SEARCH_RESULTS' | 'GET_FILES' | 'FILES_LIST' | 'REQUEST_FILE' | 'FILE_DATA' | 'FILE_CHUNK';
  payload: any;
  timestamp: number;
  _from?: string;
}

// ============================================================================
// STANDALONE CLIENT
// ============================================================================

export class StandaloneClient extends EventEmitter {
  private config: ClientConfig;
  private sam: any = null;
  private destination: string = '';
  private b32Address: string = '';
  private publicKey: string = '';
  private privateKey: string = '';
  private signingKeys: SigningKeypair | null = null;
  private isConnected: boolean = false;

  // Tracker connection
  private trackerDestination: string = '';
  private trackerConnected: boolean = false;
  private announceTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // Peer management
  private knownPeers: Map<string, TrackerPeer> = new Map();
  private usedNonces: Set<string> = new Set();

  // File management
  private sharedFiles: Map<string, SharedFile> = new Map();
  private sharedFolders: string[] = [];

  // Search results cache
  private searchResults: Map<string, any[]> = new Map();

  constructor(config: Partial<ClientConfig> = {}) {
    super();
    this.config = {
      name: config.name || 'TestClient',
      dataDir: config.dataDir || './test-data',
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      samPortUDP: config.samPortUDP || 7655,
      listenPort: config.listenPort || 0
    };

    // Ensure data directory exists
    if (!fs.existsSync(this.config.dataDir)) {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
    }
  }

  // ============================================================================
  // CONNECTION
  // ============================================================================

  async connect(): Promise<boolean> {
    console.log(`[${this.config.name}] Connecting to I2P network...`);

    try {
      // Load or create signing keys
      await this.initSigningKeys();

      // Load or create I2P identity
      const keysPath = path.join(this.config.dataDir, 'i2p-keys.json');
      let keysLoaded = false;

      if (fs.existsSync(keysPath)) {
        try {
          const savedKeys = JSON.parse(fs.readFileSync(keysPath, 'utf-8'));
          if (savedKeys.public && savedKeys.private && savedKeys.address) {
            this.publicKey = savedKeys.public;
            this.privateKey = savedKeys.private;
            this.destination = savedKeys.public;
            this.b32Address = savedKeys.address;
            keysLoaded = true;
            console.log(`[${this.config.name}] Loaded saved identity: ${this.b32Address.substring(0, 16)}...`);
          }
        } catch (e) {
          console.error(`[${this.config.name}] Failed to load saved keys:`, e);
        }
      }

      if (!keysLoaded) {
        console.log(`[${this.config.name}] Creating new I2P destination...`);
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

        // Save keys
        fs.writeFileSync(keysPath, JSON.stringify({
          public: this.publicKey,
          private: this.privateKey,
          address: this.b32Address
        }, null, 2));

        console.log(`[${this.config.name}] Created new identity: ${this.b32Address.substring(0, 16)}...`);
      }

      // Create RAW session
      const listenPort = this.config.listenPort || (7700 + Math.floor(Math.random() * 100));

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
        console.log(`[${this.config.name}] Session closed`);
        this.isConnected = false;
        this.emit('disconnected');
      });

      this.sam.on('error', (error: Error) => {
        console.error(`[${this.config.name}] Session error:`, error.message);
      });

      this.isConnected = true;
      console.log(`[${this.config.name}] Connected! Address: ${this.b32Address.substring(0, 20)}...`);
      this.emit('connected', { destination: this.destination, b32Address: this.b32Address });

      return true;

    } catch (error: any) {
      console.error(`[${this.config.name}] Connection failed:`, error.message);
      return false;
    }
  }

  async disconnect(): Promise<void> {
    console.log(`[${this.config.name}] Disconnecting...`);

    // Send DISCONNECT to tracker
    if (this.trackerConnected && this.trackerDestination) {
      await this.sendToTracker({
        type: 'DISCONNECT',
        payload: {},
        timestamp: Date.now()
      });
    }

    // Stop timers
    if (this.announceTimer) {
      clearInterval(this.announceTimer);
      this.announceTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Close SAM session
    if (this.sam) {
      try {
        this.sam.close();
      } catch (e) {
        // Ignore
      }
      this.sam = null;
    }

    this.isConnected = false;
    this.trackerConnected = false;
    this.knownPeers.clear();

    console.log(`[${this.config.name}] Disconnected`);
    this.emit('disconnected');
  }

  private async initSigningKeys(): Promise<void> {
    const keysPath = path.join(this.config.dataDir, 'signing-keys.json');

    if (fs.existsSync(keysPath)) {
      const data = fs.readFileSync(keysPath, 'utf-8');
      this.signingKeys = JSON.parse(data) as SigningKeypair;
      console.log(`[${this.config.name}] Loaded signing keys`);
    } else {
      this.signingKeys = generateSigningKeypair();
      fs.writeFileSync(keysPath, JSON.stringify(this.signingKeys, null, 2));
      console.log(`[${this.config.name}] Generated new signing keys`);
    }
  }

  // ============================================================================
  // TRACKER CONNECTION
  // ============================================================================

  async connectToTracker(trackerDestination: string): Promise<boolean> {
    if (!this.isConnected) {
      console.error(`[${this.config.name}] Not connected to I2P network`);
      return false;
    }

    this.trackerDestination = trackerDestination;
    console.log(`[${this.config.name}] Connecting to tracker: ${toB32(trackerDestination).substring(0, 20)}...`);

    // Send initial announce
    await this.announceToTracker();

    // Wait for response
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Request peer list
    await this.requestPeers();

    // Start periodic tasks
    this.startPeriodicTasks();

    this.trackerConnected = true;
    console.log(`[${this.config.name}] Connected to tracker`);
    this.emit('tracker:connected');

    return true;
  }

  private startPeriodicTasks(): void {
    // Announce every 2 minutes
    this.announceTimer = setInterval(() => {
      this.announceToTracker();
    }, 2 * 60 * 1000);

    // Heartbeat every 60 seconds
    this.heartbeatTimer = setInterval(() => {
      this.sendPing();
    }, 60 * 1000);
  }

  private async announceToTracker(): Promise<void> {
    if (!this.trackerDestination) return;

    const filesCount = this.sharedFiles.size;
    const totalSize = Array.from(this.sharedFiles.values()).reduce((sum, f) => sum + f.size, 0);

    console.log(`[${this.config.name}] Announcing to tracker (${filesCount} files, ${this.formatBytes(totalSize)})`);

    await this.sendToTracker({
      type: 'ANNOUNCE',
      payload: {
        displayName: this.config.name,
        filesCount,
        totalSize
      },
      timestamp: Date.now()
    });
  }

  private async requestPeers(): Promise<void> {
    if (!this.trackerDestination) return;

    await this.sendToTracker({
      type: 'GET_PEERS',
      payload: {},
      timestamp: Date.now()
    });
  }

  private async sendPing(): Promise<void> {
    if (!this.trackerDestination) return;

    await this.sendToTracker({
      type: 'PING',
      payload: {},
      timestamp: Date.now()
    });
  }

  private async sendToTracker(message: TrackerMessage): Promise<boolean> {
    if (!this.sam || !this.trackerDestination) return false;

    try {
      let data: Buffer;

      if (this.signingKeys) {
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
        const msgWithSender = {
          ...message,
          _from: this.destination
        };
        data = Buffer.from(JSON.stringify(msgWithSender));
      }

      this.sam.send(this.trackerDestination, data);
      return true;
    } catch (error: any) {
      console.error(`[${this.config.name}] Failed to send to tracker:`, error.message);
      return false;
    }
  }

  // ============================================================================
  // PEER-TO-PEER COMMUNICATION
  // ============================================================================

  private async sendToPeer(peerDestination: string, message: PeerMessage): Promise<boolean> {
    if (!this.sam) return false;

    try {
      let data: Buffer;

      if (this.signingKeys) {
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
        const msgWithSender = {
          ...message,
          _from: this.destination
        };
        data = Buffer.from(JSON.stringify(msgWithSender));
      }

      this.sam.send(peerDestination, data);
      return true;
    } catch (error: any) {
      console.error(`[${this.config.name}] Failed to send to peer:`, error.message);
      return false;
    }
  }

  // ============================================================================
  // MESSAGE HANDLING
  // ============================================================================

  private handleIncomingData(data: Buffer): void {
    try {
      const str = data.toString();
      if (!str.startsWith('{')) return;

      const parsed = JSON.parse(str);

      // Check if signed message
      if (parsed.signature && parsed.signingKey && parsed.nonce) {
        const from = parsed._from || '';
        if (!from) return;

        const verification = verifySignedMessage({
          data: parsed.data,
          nonce: parsed.nonce,
          timestamp: parsed.timestamp,
          signature: parsed.signature,
          signingKey: parsed.signingKey
        });

        if (!verification.valid) {
          console.log(`[${this.config.name}] Rejected message: ${verification.error}`);
          return;
        }

        // Check nonce
        if (this.usedNonces.has(parsed.nonce)) {
          return;
        }
        this.usedNonces.add(parsed.nonce);

        const message = verification.data as TrackerMessage | PeerMessage;
        this.handleMessage(from, message);
      } else {
        // Legacy unsigned message
        const message = parsed as TrackerMessage & { _from?: string };
        const from = message._from || '';
        delete message._from;

        if (!from) return;
        this.handleMessage(from, message);
      }
    } catch (e) {
      // Ignore invalid messages
    }
  }

  private handleMessage(from: string, message: TrackerMessage | PeerMessage): void {
    // Check if from tracker
    const fromB32 = toB32(from);
    const trackerB32 = this.trackerDestination ? toB32(this.trackerDestination) : '';
    const isFromTracker = this.trackerDestination && (from === this.trackerDestination || fromB32 === trackerB32);

    if (isFromTracker) {
      this.handleTrackerMessage(message as TrackerMessage);
    } else {
      this.handlePeerMessage(from, message as PeerMessage);
    }
  }

  private handleTrackerMessage(message: TrackerMessage): void {
    switch (message.type) {
      case 'PEERS_LIST':
        this.handlePeersList(message.payload);
        break;
      case 'PONG':
        // Heartbeat acknowledged
        break;
      case 'PEER_ONLINE':
        this.handlePeerOnline(message.payload);
        break;
      case 'PEER_OFFLINE':
        this.handlePeerOffline(message.payload);
        break;
      default:
        console.log(`[${this.config.name}] Unknown tracker message: ${message.type}`);
    }
  }

  private handlePeerMessage(from: string, message: PeerMessage): void {
    console.log(`[${this.config.name}] Received peer message: ${message.type} from ${toB32(from).substring(0, 16)}...`);
    switch (message.type) {
      case 'SEARCH':
        this.handleSearchRequest(from, message.payload);
        break;
      case 'SEARCH_RESULTS':
        this.handleSearchResults(from, message.payload);
        break;
      case 'GET_FILES':
        this.handleGetFilesRequest(from);
        break;
      case 'FILES_LIST':
        this.handleFilesList(from, message.payload);
        break;
      case 'REQUEST_FILE':
        this.handleFileRequest(from, message.payload);
        break;
      case 'FILE_DATA':
        this.handleFileData(from, message.payload);
        break;
      default:
        console.log(`[${this.config.name}] Unknown peer message: ${message.type}`);
    }
  }

  private handlePeersList(payload: { peers: TrackerPeer[] }): void {
    const peers = payload.peers || [];
    console.log(`[${this.config.name}] Received ${peers.length} peers from tracker`);

    for (const peer of peers) {
      const key = peer.b32Address || peer.destination;
      this.knownPeers.set(key, peer);
      console.log(`[${this.config.name}]   - ${peer.displayName}: ${peer.b32Address?.substring(0, 16)}... (${peer.filesCount} files)`);
    }

    this.emit('peers:updated', Array.from(this.knownPeers.values()));
  }

  private handlePeerOnline(payload: TrackerPeer): void {
    const key = payload.b32Address || payload.destination;
    this.knownPeers.set(key, payload);
    console.log(`[${this.config.name}] Peer online: ${payload.displayName} (${payload.b32Address?.substring(0, 16)}...)`);
    this.emit('peer:online', payload);
  }

  private handlePeerOffline(payload: { destination: string; b32Address: string }): void {
    const key = payload.b32Address || payload.destination;
    this.knownPeers.delete(key);
    console.log(`[${this.config.name}] Peer offline: ${payload.b32Address?.substring(0, 16)}...`);
    this.emit('peer:offline', payload);
  }

  // ============================================================================
  // SEARCH
  // ============================================================================

  private handleSearchRequest(from: string, payload: { query: string; requestId: string }): void {
    const { query, requestId } = payload;
    console.log(`[${this.config.name}] Search request from ${toB32(from).substring(0, 16)}...: "${query}"`);

    // Search in local files
    const results: SharedFile[] = [];
    const lowerQuery = query.toLowerCase();

    for (const file of this.sharedFiles.values()) {
      if (file.filename.toLowerCase().includes(lowerQuery)) {
        results.push(file);
      }
    }

    // Send results back
    this.sendToPeer(from, {
      type: 'SEARCH_RESULTS',
      payload: {
        requestId,
        query,
        results: results.map(f => ({
          filename: f.filename,
          hash: f.hash,
          size: f.size,
          mimeType: f.mimeType,
          peerId: this.b32Address
        }))
      },
      timestamp: Date.now()
    });

    console.log(`[${this.config.name}] Sent ${results.length} search results`);
  }

  private handleSearchResults(from: string, payload: { requestId: string; query: string; results: any[] }): void {
    const { requestId, results } = payload;
    console.log(`[${this.config.name}] Received ${results.length} search results from ${toB32(from).substring(0, 16)}...`);

    // Store results
    const existing = this.searchResults.get(requestId) || [];
    this.searchResults.set(requestId, [...existing, ...results]);

    this.emit('search:results', { requestId, from, results });
  }

  async search(query: string): Promise<any[]> {
    const requestId = crypto.randomBytes(8).toString('hex');
    console.log(`[${this.config.name}] Searching for: "${query}" (requestId: ${requestId})`);

    this.searchResults.set(requestId, []);

    // Send search to all known peers
    const peerCount = this.knownPeers.size;
    console.log(`[${this.config.name}] Sending search to ${peerCount} peers`);
    for (const peer of this.knownPeers.values()) {
      console.log(`[${this.config.name}] Sending SEARCH to ${peer.displayName} (${toB32(peer.destination).substring(0, 16)}...)`);
      await this.sendToPeer(peer.destination, {
        type: 'SEARCH',
        payload: { query, requestId },
        timestamp: Date.now()
      });
    }

    // Wait for results (I2P has high latency, need longer timeout)
    console.log(`[${this.config.name}] Waiting 10s for search results...`);
    await new Promise(resolve => setTimeout(resolve, 10000));

    const results = this.searchResults.get(requestId) || [];
    this.searchResults.delete(requestId);

    console.log(`[${this.config.name}] Search complete: ${results.length} total results`);
    return results;
  }

  // ============================================================================
  // FILE LISTING
  // ============================================================================

  private handleGetFilesRequest(from: string): void {
    console.log(`[${this.config.name}] File list request from ${toB32(from).substring(0, 16)}...`);

    const files = Array.from(this.sharedFiles.values()).map(f => ({
      filename: f.filename,
      hash: f.hash,
      size: f.size,
      mimeType: f.mimeType
    }));

    this.sendToPeer(from, {
      type: 'FILES_LIST',
      payload: { files },
      timestamp: Date.now()
    });

    console.log(`[${this.config.name}] Sent ${files.length} files in list`);
  }

  private handleFilesList(from: string, payload: { files: any[] }): void {
    const { files } = payload;
    console.log(`[${this.config.name}] Received file list from ${toB32(from).substring(0, 16)}...: ${files.length} files`);
    this.emit('files:list', { from, files });
  }

  async requestFileList(peerDestination: string): Promise<void> {
    console.log(`[${this.config.name}] Requesting file list from ${toB32(peerDestination).substring(0, 16)}...`);

    await this.sendToPeer(peerDestination, {
      type: 'GET_FILES',
      payload: {},
      timestamp: Date.now()
    });
  }

  // ============================================================================
  // FILE TRANSFER
  // ============================================================================

  private handleFileRequest(from: string, payload: { hash: string; filename: string }): void {
    const { hash, filename } = payload;
    console.log(`[${this.config.name}] File request from ${toB32(from).substring(0, 16)}...: ${filename}`);

    const file = this.sharedFiles.get(hash);
    if (!file) {
      console.log(`[${this.config.name}] File not found: ${hash}`);
      return;
    }

    // Read and send file data
    try {
      const data = fs.readFileSync(file.path);
      const base64Data = data.toString('base64');

      this.sendToPeer(from, {
        type: 'FILE_DATA',
        payload: {
          hash,
          filename: file.filename,
          size: file.size,
          data: base64Data
        },
        timestamp: Date.now()
      });

      console.log(`[${this.config.name}] Sent file: ${filename} (${this.formatBytes(file.size)})`);
    } catch (error: any) {
      console.error(`[${this.config.name}] Failed to read file:`, error.message);
    }
  }

  private handleFileData(from: string, payload: { hash: string; filename: string; size: number; data: string }): void {
    const { hash, filename, size, data } = payload;
    console.log(`[${this.config.name}] Received file from ${toB32(from).substring(0, 16)}...: ${filename} (${this.formatBytes(size)})`);

    // Save to downloads folder
    const downloadsDir = path.join(this.config.dataDir, 'downloads');
    if (!fs.existsSync(downloadsDir)) {
      fs.mkdirSync(downloadsDir, { recursive: true });
    }

    const filePath = path.join(downloadsDir, filename);
    const fileData = Buffer.from(data, 'base64');

    fs.writeFileSync(filePath, fileData);
    console.log(`[${this.config.name}] File saved to: ${filePath}`);

    this.emit('file:downloaded', { hash, filename, path: filePath, size });
  }

  async downloadFile(peerDestination: string, hash: string, filename: string): Promise<boolean> {
    console.log(`[${this.config.name}] Requesting download: ${filename} from ${toB32(peerDestination).substring(0, 16)}...`);

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.removeListener('file:downloaded', handler);
        console.log(`[${this.config.name}] Download timeout: ${filename}`);
        resolve(false);
      }, 30000);

      const handler = (event: { hash: string }) => {
        if (event.hash === hash) {
          clearTimeout(timeout);
          this.removeListener('file:downloaded', handler);
          resolve(true);
        }
      };

      this.on('file:downloaded', handler);

      this.sendToPeer(peerDestination, {
        type: 'REQUEST_FILE',
        payload: { hash, filename },
        timestamp: Date.now()
      });
    });
  }

  // ============================================================================
  // FILE SHARING
  // ============================================================================

  async addSharedFolder(folderPath: string): Promise<number> {
    console.log(`[${this.config.name}] Adding shared folder: ${folderPath}`);

    if (!fs.existsSync(folderPath)) {
      console.error(`[${this.config.name}] Folder does not exist: ${folderPath}`);
      return 0;
    }

    this.sharedFolders.push(folderPath);
    const files = await this.scanFolder(folderPath);

    console.log(`[${this.config.name}] Added ${files.length} files from ${folderPath}`);

    // Re-announce to tracker
    if (this.trackerConnected) {
      await this.announceToTracker();
    }

    return files.length;
  }

  private async scanFolder(folderPath: string): Promise<SharedFile[]> {
    const files: SharedFile[] = [];

    const walk = (dir: string) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          // Skip hidden files
          if (entry.name.startsWith('.')) continue;

          if (entry.isDirectory()) {
            walk(fullPath);
          } else if (entry.isFile()) {
            const stats = fs.statSync(fullPath);

            // Skip very small files
            if (stats.size < 1024) continue;

            // Compute hash
            const hash = this.hashFile(fullPath);

            const file: SharedFile = {
              path: fullPath,
              filename: entry.name,
              hash,
              size: stats.size,
              mimeType: this.getMimeType(entry.name)
            };

            files.push(file);
            this.sharedFiles.set(hash, file);
          }
        }
      } catch (error: any) {
        console.error(`[${this.config.name}] Error scanning ${dir}:`, error.message);
      }
    };

    walk(folderPath);
    return files;
  }

  private hashFile(filePath: string): string {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    const mimeTypes: Record<string, string> = {
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.gif': 'image/gif',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.mp3': 'audio/mpeg',
      '.mp4': 'video/mp4'
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  getPeers(): TrackerPeer[] {
    return Array.from(this.knownPeers.values());
  }

  getSharedFiles(): SharedFile[] {
    return Array.from(this.sharedFiles.values());
  }

  getAddress(): string {
    return this.b32Address;
  }

  getDestination(): string {
    return this.destination;
  }

  getName(): string {
    return this.config.name;
  }

  isOnline(): boolean {
    return this.isConnected;
  }

  isTrackerOnline(): boolean {
    return this.trackerConnected;
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
