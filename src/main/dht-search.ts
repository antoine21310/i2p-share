import crypto from 'crypto';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import type { DHTMessage, PeerAnnounce, SearchFilters, SearchResult } from '../shared/types.js';
import { DHTCacheOps, FileOps, PeerOps, RoutingOps } from './database.js';

const K = 20; // Kademlia bucket size
const ALPHA = 3; // Parallel lookups
const ID_BITS = 160; // SHA1 produces 160-bit IDs
const PEER_EXPIRATION = 30 * 60 * 1000; // 30 minutes
const TOKEN_SECRET_ROTATION = 5 * 60 * 1000; // 5 minutes

interface DHTNode {
  nodeId: string;
  destination: string;
  lastSeen: number;
}

interface SearchContext {
  id: string;
  query: string;
  filters: SearchFilters;
  results: Map<string, SearchResult>;
  visited: Set<string>;
  pending: Set<string>;
  callback: (results: SearchResult[]) => void;
  timeout: NodeJS.Timeout;
}

// BEP5: Peer info for a torrent
interface TorrentPeer {
  destination: string;
  lastSeen: number;
}

// BEP5: Token for announce_peer authorization
interface TokenInfo {
  secret: string;
  previousSecret: string;
}

export class DHTSearchEngine extends EventEmitter {
  private nodeId: string;
  private destination: string;
  private routingTable: Map<number, DHTNode[]> = new Map();
  private activeSearches: Map<string, SearchContext> = new Map();
  private messageHandler: ((from: string, message: any) => void) | null = null;

  // BEP5: Peers storage by infoHash
  private torrentPeers: Map<string, Map<string, TorrentPeer>> = new Map();
  // BEP5: Token secret for announce authorization
  private tokenInfo: TokenInfo;
  private tokenRotationTimer: NodeJS.Timeout | null = null;
  // Cache for tokens received from other nodes: Map<nodeId, token>
  private tokenCache: Map<string, string> = new Map();

  constructor() {
    super();
    // Generate random node ID (will be replaced with hash of public key)
    this.nodeId = crypto.randomBytes(20).toString('hex');
    this.destination = '';

    // Initialize K-buckets
    for (let i = 0; i < ID_BITS; i++) {
      this.routingTable.set(i, []);
    }

    // BEP5: Initialize token secret
    this.tokenInfo = {
      secret: crypto.randomBytes(16).toString('hex'),
      previousSecret: crypto.randomBytes(16).toString('hex')
    };

    // Rotate token secret periodically
    this.tokenRotationTimer = setInterval(() => {
      this.rotateTokenSecret();
    }, TOKEN_SECRET_ROTATION);
  }

  /**
   * BEP5: Rotate token secret
   */
  private rotateTokenSecret(): void {
    this.tokenInfo.previousSecret = this.tokenInfo.secret;
    this.tokenInfo.secret = crypto.randomBytes(16).toString('hex');
  }

  /**
   * BEP5: Generate token for a requesting node
   */
  private generateToken(nodeDestination: string): string {
    return crypto.createHmac('sha1', this.tokenInfo.secret)
      .update(nodeDestination)
      .digest('hex')
      .substring(0, 16);
  }

  /**
   * BEP5: Verify token from announce_peer
   */
  private verifyToken(nodeDestination: string, token: string): boolean {
    const currentToken = crypto.createHmac('sha1', this.tokenInfo.secret)
      .update(nodeDestination)
      .digest('hex')
      .substring(0, 16);

    const previousToken = crypto.createHmac('sha1', this.tokenInfo.previousSecret)
      .update(nodeDestination)
      .digest('hex')
      .substring(0, 16);

    return token === currentToken || token === previousToken;
  }

  setIdentity(publicKey: string, destination: string): void {
    this.nodeId = crypto.createHash('sha1').update(publicKey).digest('hex');
    this.destination = destination;
    console.log('[DHT] Node ID:', this.nodeId.substring(0, 16) + '...');
  }

  setMessageHandler(handler: (from: string, message: any) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Get this node's DHT ID
   */
  getNodeId(): string {
    return this.nodeId;
  }

  /**
   * Get this node's destination
   */
  getDestination(): string {
    return this.destination;
  }

  // Calculate XOR distance between two node IDs
  private xorDistance(id1: string, id2: string): bigint {
    const hex1 = BigInt('0x' + id1);
    const hex2 = BigInt('0x' + id2);
    return hex1 ^ hex2;
  }

  // Find the bucket index for a given node ID
  private getBucketIndex(nodeId: string): number {
    const distance = this.xorDistance(this.nodeId, nodeId);
    if (distance === 0n) return 0;

    // Count leading zeros to find bucket
    const distHex = distance.toString(16).padStart(40, '0');
    for (let i = 0; i < ID_BITS; i++) {
      const byteIndex = Math.floor(i / 4);
      const bitInByte = i % 4;
      const nibble = parseInt(distHex[byteIndex], 16);
      if ((nibble >> (3 - bitInByte)) & 1) {
        return ID_BITS - 1 - i;
      }
    }
    return 0;
  }

  // Add or update a node in the routing table
  updateNode(nodeId: string, destination: string): void {
    if (nodeId === this.nodeId) return;

    const bucketIndex = this.getBucketIndex(nodeId);
    let bucket = this.routingTable.get(bucketIndex) || [];

    // Check if node already exists
    const existingIndex = bucket.findIndex(n => n.nodeId === nodeId);

    if (existingIndex >= 0) {
      // Move to end (most recently seen)
      const [node] = bucket.splice(existingIndex, 1);
      node.lastSeen = Date.now();
      node.destination = destination;
      bucket.push(node);
    } else if (bucket.length < K) {
      // Add new node
      bucket.push({
        nodeId,
        destination,
        lastSeen: Date.now()
      });
    } else {
      // Bucket full - could implement eviction here
      // For now, just ignore new node
    }

    this.routingTable.set(bucketIndex, bucket);

    // Persist to database
    RoutingOps.upsert(nodeId, destination, bucketIndex);
  }

  // Get the K closest nodes to a target
  getClosestNodes(targetId: string, count: number = K): DHTNode[] {
    const allNodes: DHTNode[] = [];

    this.routingTable.forEach(bucket => {
      allNodes.push(...bucket);
    });

    // Sort by XOR distance to target
    allNodes.sort((a, b) => {
      const distA = this.xorDistance(targetId, a.nodeId);
      const distB = this.xorDistance(targetId, b.nodeId);
      if (distA < distB) return -1;
      if (distA > distB) return 1;
      return 0;
    });

    return allNodes.slice(0, count);
  }

  // Hash a search query to get target ID
  hashQuery(query: string): string {
    return crypto.createHash('sha1').update(query.toLowerCase()).digest('hex');
  }

  // Perform a distributed search
  async search(query: string, filters: SearchFilters = {}, timeout = 10000): Promise<SearchResult[]> {
    return new Promise((resolve) => {
      const searchId = uuidv4();
      const targetId = this.hashQuery(query);

      const context: SearchContext = {
        id: searchId,
        query,
        filters,
        results: new Map(),
        visited: new Set(),
        pending: new Set(),
        callback: resolve,
        timeout: setTimeout(() => {
          this.finalizeSearch(searchId);
        }, timeout)
      };

      this.activeSearches.set(searchId, context);

      // Get initial nodes to query
      const closestNodes = this.getClosestNodes(targetId, ALPHA);

      if (closestNodes.length === 0) {
        // No known nodes, return empty results
        clearTimeout(context.timeout);
        this.activeSearches.delete(searchId);
        resolve([]);
        return;
      }

      // Start parallel lookups
      for (const node of closestNodes) {
        this.sendFindValue(searchId, node, targetId, query, filters);
      }

      // Emit search started event
      this.emit('search:start', { searchId, query });
    });
  }

  private async sendFindValue(
    searchId: string,
    node: DHTNode,
    targetId: string,
    query: string,
    filters: SearchFilters
  ): Promise<void> {
    const context = this.activeSearches.get(searchId);
    if (!context) return;

    if (context.visited.has(node.nodeId)) return;
    context.visited.add(node.nodeId);
    context.pending.add(node.nodeId);

    const message: DHTMessage = {
      type: 'FIND_VALUE',
      nodeId: this.nodeId,
      payload: {
        searchId,
        targetId,
        query,
        filters,
        origin: this.destination
      },
      timestamp: Date.now()
    };

    try {
      if (this.messageHandler) {
        this.messageHandler(node.destination, message);
      }
      // Note: Do NOT delete from pending here - we need to wait for response
      // pending will be cleared in handleSearchResponse or by timeout
    } catch (error) {
      console.error(`[DHT] Error sending to ${node.nodeId}:`, error);
      RoutingOps.incrementFail(node.nodeId);
      // Only remove from pending on error
      context.pending.delete(node.nodeId);
    }
  }

  // Handle incoming DHT messages
  handleMessage(from: string, message: DHTMessage): void {
    this.updateNode(message.nodeId, from);

    // Handle responses
    if (message.payload && message.payload.isResponse) {
      this.handleResponse(from, message);
      return;
    }

    switch (message.type) {
      case 'FIND_VALUE':
        this.handleFindValue(from, message);
        break;
      case 'FIND_NODE':
        this.handleFindNode(from, message);
        break;
      case 'STORE':
        this.handleStore(from, message);
        break;
      case 'PING':
        this.handlePing(from, message);
        break;
      case 'ANNOUNCE':
        this.handleAnnounce(from, message);
        break;
      // BEP5: BitTorrent DHT peer discovery
      case 'GET_PEERS':
        this.handleGetPeers(from, message);
        break;
      case 'ANNOUNCE_PEER':
        this.handleAnnouncePeer(from, message);
        break;
    }
  }

  private handleResponse(from: string, message: DHTMessage): void {
    // Emit response event for anyone waiting (e.g. getPeers, search)
    this.emit('message:response', message);

    // Handle FIND_VALUE responses (search results)
    if (message.type === 'FIND_VALUE' && message.payload.searchId) {
      const { searchId, results, closerNodes } = message.payload;
      console.log(`[DHT] Received search response for ${searchId}: ${results?.length || 0} results from ${message.nodeId?.substring(0, 16)}...`);
      this.handleSearchResponse(searchId, results || [], closerNodes || [], message.nodeId);
    }

    // If it's a GET_PEERS response, cache the token
    if (message.type === 'GET_PEERS' && message.payload.token) {
      // Store token associated with the node's ID
      this.tokenCache.set(message.nodeId, message.payload.token);
      // Also store by destination just in case
      this.tokenCache.set(from, message.payload.token);
    }
  }

  private handleFindValue(from: string, message: DHTMessage): void {
    const { targetId, query, filters, origin, searchId } = message.payload;

    // Search local files
    const localResults = this.searchLocalFiles(query, filters);

    // Get closest nodes we know
    const closerNodes = this.getClosestNodes(targetId, K)
      .filter(n => n.nodeId !== message.nodeId)
      .map(n => ({ nodeId: n.nodeId, destination: n.destination }));

    // Send response
    const response: DHTMessage = {
      type: 'FIND_VALUE',
      nodeId: this.nodeId,
      payload: {
        searchId,
        results: localResults,
        closerNodes,
        isResponse: true
      },
      timestamp: Date.now()
    };

    if (this.messageHandler) {
      this.messageHandler(origin, response);
    }
  }

  private handleFindNode(from: string, message: DHTMessage): void {
    const { targetId } = message.payload;
    const closestNodes = this.getClosestNodes(targetId, K);

    const response: DHTMessage = {
      type: 'FIND_NODE',
      nodeId: this.nodeId,
      payload: {
        nodes: closestNodes.map(n => ({
          nodeId: n.nodeId,
          destination: n.destination
        }))
      },
      timestamp: Date.now()
    };

    if (this.messageHandler) {
      this.messageHandler(from, response);
    }
  }

  private handleStore(from: string, message: DHTMessage): void {
    const { key, value, ttl } = message.payload;
    DHTCacheOps.set(key, JSON.stringify(value), ttl || 3600);
  }

  private handlePing(from: string, message: DHTMessage): void {
    const response: DHTMessage = {
      type: 'PONG',
      nodeId: this.nodeId,
      payload: {},
      timestamp: Date.now()
    };

    if (this.messageHandler) {
      this.messageHandler(from, response);
    }
  }

  private handleAnnounce(from: string, message: DHTMessage): void {
    const announce = message.payload as PeerAnnounce;

    // Update peer info
    PeerOps.upsert({
      peerId: from,
      displayName: announce.displayName,
      filesCount: announce.filesCount,
      totalSize: announce.totalSize
    });

    this.emit('peer:announce', { peerId: from, announce });
  }

  // Handle search response
  handleSearchResponse(searchId: string, results: SearchResult[], closerNodes: any[], responderNodeId?: string): void {
    const context = this.activeSearches.get(searchId);
    if (!context) return;

    // Remove responder from pending
    if (responderNodeId) {
      context.pending.delete(responderNodeId);
    }

    // Add results
    for (const result of results) {
      if (!context.results.has(result.fileHash)) {
        context.results.set(result.fileHash, result);
        this.emit('search:result', { searchId, result });
      }
    }

    // Query closer nodes
    for (const node of closerNodes) {
      if (!context.visited.has(node.nodeId)) {
        this.updateNode(node.nodeId, node.destination);
        this.sendFindValue(
          searchId,
          node,
          this.hashQuery(context.query),
          context.query,
          context.filters
        );
      }
    }

    // Check if search is complete (all pending responded or we have results)
    if (context.pending.size === 0) {
      this.finalizeSearch(searchId);
    }
  }

  private finalizeSearch(searchId: string): void {
    const context = this.activeSearches.get(searchId);
    if (!context) return;

    clearTimeout(context.timeout);
    this.activeSearches.delete(searchId);

    const results = Array.from(context.results.values());

    // Sort by relevance
    results.sort((a, b) => {
      // Simple relevance: exact match > partial match
      const queryLower = context.query.toLowerCase();
      const aMatch = a.filename.toLowerCase().includes(queryLower) ? 1 : 0;
      const bMatch = b.filename.toLowerCase().includes(queryLower) ? 1 : 0;
      return bMatch - aMatch;
    });

    this.emit('search:complete', { searchId, resultsCount: results.length });
    context.callback(results);
  }

  private searchLocalFiles(query: string, filters: SearchFilters): SearchResult[] {
    // const { FileOps } = require('./database'); // Removed
    const files = FileOps.search(query);

    return files
      .filter((file: any) => {
        if (filters.minSize && file.size < filters.minSize) return false;
        if (filters.maxSize && file.size > filters.maxSize) return false;
        if (filters.fileType && filters.fileType !== 'all') {
          const category = this.getFileCategory(file.mimeType);
          if (category !== filters.fileType) return false;
        }
        return true;
      })
      .map((file: any) => {
        // Get full file record to include infoHash for torrent-based downloads
        const fileWithInfoHash = FileOps.getWithInfoHash(file.hash);
        return {
          filename: file.filename,
          fileHash: file.hash,
          infoHash: fileWithInfoHash?.infoHash || null, // Include torrent infoHash if available
          size: file.size,
          mimeType: file.mimeType,
          peerId: this.destination,
          peerDisplayName: 'Me',
          addedAt: file.sharedAt
        };
      });
  }

  private getFileCategory(mimeType: string): string {
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('text/') || mimeType.includes('document') || mimeType.includes('pdf')) return 'document';
    if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return 'archive';
    return 'other';
  }

  // Bootstrap from known nodes
  async bootstrap(bootstrapNodes: { nodeId: string; destination: string }[]): Promise<void> {
    for (const node of bootstrapNodes) {
      this.updateNode(node.nodeId, node.destination);
    }

    // Perform a lookup for our own ID to populate routing table
    if (bootstrapNodes.length > 0) {
      const closestNodes = this.getClosestNodes(this.nodeId, ALPHA);
      for (const node of closestNodes) {
        const message: DHTMessage = {
          type: 'FIND_NODE',
          nodeId: this.nodeId,
          payload: { targetId: this.nodeId },
          timestamp: Date.now()
        };

        if (this.messageHandler) {
          this.messageHandler(node.destination, message);
        }
      }
    }

    this.emit('bootstrap:complete', { nodesCount: bootstrapNodes.length });
  }

  // Announce our files to the network
  async announceFiles(files: any[]): Promise<void> {
    const announce: PeerAnnounce = {
      type: 'peer_announce',
      userId: this.nodeId,
      displayName: 'I2P Share User',
      filesCount: files.length,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      timestamp: Date.now(),
      signature: '' // Would be signed with private key
    };

    // Store in DHT
    const key = `peer:${this.nodeId}`;
    const closestNodes = this.getClosestNodes(this.hashQuery(key), K);

    for (const node of closestNodes) {
      const message: DHTMessage = {
        type: 'STORE',
        nodeId: this.nodeId,
        payload: { key, value: announce, ttl: 3600 },
        timestamp: Date.now()
      };

      if (this.messageHandler) {
        this.messageHandler(node.destination, message);
      }
    }

    this.emit('announce:complete', { filesCount: files.length });
  }

  // Get network stats
  getStats(): { nodesCount: number; bucketsUsed: number } {
    let nodesCount = 0;
    let bucketsUsed = 0;

    this.routingTable.forEach(bucket => {
      if (bucket.length > 0) {
        bucketsUsed++;
        nodesCount += bucket.length;
      }
    });

    return { nodesCount, bucketsUsed };
  }

  // Load routing table from database
  loadFromDatabase(): void {
    const nodes = RoutingOps.getClosest('', 1000);
    for (const node of nodes as any[]) {
      this.updateNode(node.nodeId, node.destination);
    }
    console.log(`[DHT] Loaded ${nodes.length} nodes from database`);
  }

  // ============================================================================
  // BEP5: BitTorrent DHT - get_peers and announce_peer
  // ============================================================================

  /**
   * BEP5: Handle get_peers query
   * Returns peers for the requested infoHash, or closer nodes
   */
  private handleGetPeers(from: string, message: DHTMessage): void {
    const { infoHash, origin } = message.payload;
    const targetId = infoHash; // infoHash IS the target ID

    // Generate token for this requester
    const token = this.generateToken(from);

    // Check if we have peers for this infoHash
    const peers = this.torrentPeers.get(infoHash);
    const activePeers: string[] = [];

    if (peers) {
      const now = Date.now();
      for (const [dest, peer] of peers) {
        if (now - peer.lastSeen < PEER_EXPIRATION) {
          activePeers.push(dest);
        }
      }
    }

    // Get closest nodes we know
    const closerNodes = this.getClosestNodes(targetId, K)
      .filter(n => n.nodeId !== message.nodeId)
      .map(n => ({ nodeId: n.nodeId, destination: n.destination }));

    // Send response
    const response: DHTMessage = {
      type: 'GET_PEERS',
      nodeId: this.nodeId,
      payload: {
        token,
        peers: activePeers.length > 0 ? activePeers : undefined,
        nodes: closerNodes,
        isResponse: true
      },
      timestamp: Date.now()
    };

    if (this.messageHandler) {
      this.messageHandler(origin || from, response);
    }

    console.log(`[DHT] get_peers for ${infoHash.substring(0, 16)}...: ${activePeers.length} peers, ${closerNodes.length} nodes`);
  }

  /**
   * BEP5: Handle announce_peer query
   * Stores peer info for the announced infoHash
   */
  private handleAnnouncePeer(from: string, message: DHTMessage): void {
    const { infoHash, port, token, origin } = message.payload;
    const peerDestination = port || from; // In I2P, 'port' is the destination

    // Verify token
    if (!this.verifyToken(from, token)) {
      console.log(`[DHT] announce_peer: invalid token from ${from.substring(0, 30)}...`);
      return;
    }

    // Store peer
    let peers = this.torrentPeers.get(infoHash);
    if (!peers) {
      peers = new Map();
      this.torrentPeers.set(infoHash, peers);
    }

    peers.set(peerDestination, {
      destination: peerDestination,
      lastSeen: Date.now()
    });

    console.log(`[DHT] announce_peer: ${infoHash.substring(0, 16)}... from ${peerDestination.substring(0, 30)}...`);

    // Send acknowledgment
    const response: DHTMessage = {
      type: 'ANNOUNCE_PEER',
      nodeId: this.nodeId,
      payload: {
        isResponse: true
      },
      timestamp: Date.now()
    };

    if (this.messageHandler) {
      this.messageHandler(origin || from, response);
    }

    // Emit event
    this.emit('peer:announced', { infoHash, destination: peerDestination });
  }

  /**
   * BEP5: Query DHT for peers who have a specific torrent
   */
  async getPeers(infoHash: string, timeout = 30000): Promise<string[]> {
    return new Promise((resolve) => {
      const searchId = uuidv4();
      const foundPeers = new Set<string>();
      const visited = new Set<string>();
      const pending = new Set<string>();

      // Timeout handler
      const timeoutHandle = setTimeout(() => {
        resolve(Array.from(foundPeers));
      }, timeout);

      // Get initial nodes to query
      const closestNodes = this.getClosestNodes(infoHash, ALPHA);

      if (closestNodes.length === 0) {
        clearTimeout(timeoutHandle);
        resolve([]);
        return;
      }

      // Response handler
      const handleResponse = (response: any) => {
        if (response.payload?.isResponse && response.type === 'GET_PEERS') {
          // Add found peers
          if (response.payload.peers) {
            for (const peer of response.payload.peers) {
              if (peer !== this.destination) {
                foundPeers.add(peer);
              }
            }
          }

          // Query closer nodes
          if (response.payload.nodes) {
            for (const node of response.payload.nodes) {
              if (!visited.has(node.nodeId) && pending.size < ALPHA * 2) {
                this.updateNode(node.nodeId, node.destination);
                sendGetPeers(node);
              }
            }
          }

          pending.delete(response.nodeId);

          // Check if we're done
          if (pending.size === 0 || foundPeers.size >= 50) {
            clearTimeout(timeoutHandle);
            this.removeListener('message:response', handleResponse);
            resolve(Array.from(foundPeers));
          }
        }
      };

      // Listen for responses (temporary)
      this.on('message:response', handleResponse);

      // Send get_peers to a node
      const sendGetPeers = (node: DHTNode) => {
        if (visited.has(node.nodeId)) return;
        visited.add(node.nodeId);
        pending.add(node.nodeId);

        const message: DHTMessage = {
          type: 'GET_PEERS',
          nodeId: this.nodeId,
          payload: {
            infoHash,
            origin: this.destination
          },
          timestamp: Date.now()
        };

        if (this.messageHandler) {
          this.messageHandler(node.destination, message);
        }
      };

      // Start querying
      for (const node of closestNodes) {
        sendGetPeers(node);
      }
    });
  }

  /**
   * BEP5: Announce that we have a torrent to the DHT
   */
  async announcePeer(infoHash: string): Promise<void> {
    if (!this.destination) {
      console.log('[DHT] Cannot announce: no destination set');
      return;
    }

    console.log(`[DHT] Announcing peer for ${infoHash.substring(0, 16)}...`);

    // First, do get_peers to get tokens
    const closestNodes = this.getClosestNodes(infoHash, K);
    
    // We need to wait for tokens.
    // Send get_peers to all closest nodes
    for (const node of closestNodes) {
      const message: DHTMessage = {
        type: 'GET_PEERS',
        nodeId: this.nodeId,
        payload: {
          infoHash,
          origin: this.destination
        },
        timestamp: Date.now()
      };

      if (this.messageHandler) {
        this.messageHandler(node.destination, message);
      }
    }

    // Wait for responses to populate tokenCache
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Send announce_peer to nodes we have tokens for
    let announcedCount = 0;
    
    for (const node of closestNodes) {
      // Try to get token by nodeId or destination
      const token = this.tokenCache.get(node.nodeId) || this.tokenCache.get(node.destination);
      
      if (!token) {
        // Skip nodes that didn't give us a token
        continue;
      }

      const message: DHTMessage = {
        type: 'ANNOUNCE_PEER',
        nodeId: this.nodeId,
        payload: {
          infoHash,
          port: this.destination, // In I2P we send destination as 'port'
          token,
          origin: this.destination
        },
        timestamp: Date.now()
      };

      if (this.messageHandler) {
        this.messageHandler(node.destination, message);
        announcedCount++;
      }
    }
    
    console.log(`[DHT] Announced to ${announcedCount} nodes (with valid tokens)`);
    // Also store locally
    let peers = this.torrentPeers.get(infoHash);
    if (!peers) {
      peers = new Map();
      this.torrentPeers.set(infoHash, peers);
    }
    peers.set(this.destination, {
      destination: this.destination,
      lastSeen: Date.now()
    });

    this.emit('announce_peer:complete', { infoHash });
  }

  /**
   * BEP5: Get locally stored peers for an infoHash
   */
  getStoredPeers(infoHash: string): string[] {
    const peers = this.torrentPeers.get(infoHash);
    if (!peers) return [];

    const now = Date.now();
    const activePeers: string[] = [];

    for (const [dest, peer] of peers) {
      if (now - peer.lastSeen < PEER_EXPIRATION) {
        activePeers.push(dest);
      }
    }

    return activePeers;
  }

  /**
   * BEP5: Clean up expired peers
   */
  cleanupExpiredPeers(): void {
    const now = Date.now();

    for (const [infoHash, peers] of this.torrentPeers) {
      for (const [dest, peer] of peers) {
        if (now - peer.lastSeen >= PEER_EXPIRATION) {
          peers.delete(dest);
        }
      }

      if (peers.size === 0) {
        this.torrentPeers.delete(infoHash);
      }
    }
  }

  // ============================================================================
  // Tracker Discovery via DHT
  // ============================================================================

  /** Special DHT key for tracker discovery */
  private static readonly TRACKER_DHT_KEY = 'i2p-share-trackers';

  /**
   * Hash the tracker discovery key to get a consistent infoHash
   */
  getTrackerDiscoveryHash(): string {
    return crypto.createHash('sha1')
      .update(DHTSearchEngine.TRACKER_DHT_KEY)
      .digest('hex');
  }

  /**
   * Announce a tracker to the DHT so others can discover it
   * @param trackerDestination The I2P destination of the tracker
   */
  async announceTracker(trackerDestination: string): Promise<void> {
    const trackerHash = this.getTrackerDiscoveryHash();
    console.log(`[DHT] Announcing tracker ${trackerDestination.substring(0, 30)}... to DHT`);

    // Store the tracker in our local peer storage (with tracker hash as infoHash)
    let trackers = this.torrentPeers.get(trackerHash);
    if (!trackers) {
      trackers = new Map();
      this.torrentPeers.set(trackerHash, trackers);
    }
    trackers.set(trackerDestination, {
      destination: trackerDestination,
      lastSeen: Date.now()
    });

    // Announce to DHT like a regular peer announcement
    // First, get tokens from closest nodes
    const closestNodes = this.getClosestNodes(trackerHash, K);

    for (const node of closestNodes) {
      const message: DHTMessage = {
        type: 'GET_PEERS',
        nodeId: this.nodeId,
        payload: {
          infoHash: trackerHash,
          origin: this.destination
        },
        timestamp: Date.now()
      };

      if (this.messageHandler) {
        this.messageHandler(node.destination, message);
      }
    }

    // Wait for tokens
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Announce with the tracker destination (not our own destination)
    let announcedCount = 0;
    for (const node of closestNodes) {
      const token = this.tokenCache.get(node.nodeId) || this.tokenCache.get(node.destination);
      if (!token) continue;

      const message: DHTMessage = {
        type: 'ANNOUNCE_PEER',
        nodeId: this.nodeId,
        payload: {
          infoHash: trackerHash,
          port: trackerDestination, // The tracker's destination
          token,
          origin: this.destination
        },
        timestamp: Date.now()
      };

      if (this.messageHandler) {
        this.messageHandler(node.destination, message);
        announcedCount++;
      }
    }

    console.log(`[DHT] Tracker announced to ${announcedCount} DHT nodes`);
    this.emit('tracker:announced', { destination: trackerDestination });
  }

  /**
   * Discover trackers from the DHT
   * @param timeout Timeout in ms
   * @returns Array of tracker destinations
   */
  async discoverTrackers(timeout = 15000): Promise<string[]> {
    const trackerHash = this.getTrackerDiscoveryHash();
    console.log(`[DHT] Discovering trackers from DHT...`);

    // Use the existing getPeers mechanism with the tracker hash
    const trackers = await this.getPeers(trackerHash, timeout);

    // Filter out our own destination and duplicates
    const uniqueTrackers = [...new Set(trackers)].filter(t => t !== this.destination);

    console.log(`[DHT] Discovered ${uniqueTrackers.length} trackers from DHT`);

    if (uniqueTrackers.length > 0) {
      this.emit('trackers:discovered', uniqueTrackers);
    }

    return uniqueTrackers;
  }

  /**
   * Get locally known trackers
   */
  getKnownTrackers(): string[] {
    const trackerHash = this.getTrackerDiscoveryHash();
    return this.getStoredPeers(trackerHash);
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    if (this.tokenRotationTimer) {
      clearInterval(this.tokenRotationTimer);
      this.tokenRotationTimer = null;
    }
    this.torrentPeers.clear();
    this.activeSearches.clear();
    this.removeAllListeners();
  }
}

export const dhtSearch = new DHTSearchEngine();
