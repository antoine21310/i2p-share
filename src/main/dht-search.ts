import crypto from 'crypto';
import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { RoutingOps, DHTCacheOps, PeerOps } from './database';
import type { SearchResult, SearchFilters, DHTMessage, PeerAnnounce, FileIndex } from '../shared/types';

const K = 20; // Kademlia bucket size
const ALPHA = 3; // Parallel lookups
const ID_BITS = 160; // SHA1 produces 160-bit IDs

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

export class DHTSearchEngine extends EventEmitter {
  private nodeId: string;
  private destination: string;
  private routingTable: Map<number, DHTNode[]> = new Map();
  private activeSearches: Map<string, SearchContext> = new Map();
  private messageHandler: ((from: string, message: any) => void) | null = null;

  constructor() {
    super();
    // Generate random node ID (will be replaced with hash of public key)
    this.nodeId = crypto.randomBytes(20).toString('hex');
    this.destination = '';

    // Initialize K-buckets
    for (let i = 0; i < ID_BITS; i++) {
      this.routingTable.set(i, []);
    }
  }

  setIdentity(publicKey: string, destination: string): void {
    this.nodeId = crypto.createHash('sha1').update(publicKey).digest('hex');
    this.destination = destination;
    console.log('[DHT] Node ID:', this.nodeId.substring(0, 16) + '...');
  }

  setMessageHandler(handler: (from: string, message: any) => void): void {
    this.messageHandler = handler;
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
    } catch (error) {
      console.error(`[DHT] Error sending to ${node.nodeId}:`, error);
      RoutingOps.incrementFail(node.nodeId);
    } finally {
      context.pending.delete(node.nodeId);
    }
  }

  // Handle incoming DHT messages
  handleMessage(from: string, message: DHTMessage): void {
    this.updateNode(message.nodeId, from);

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
  handleSearchResponse(searchId: string, results: SearchResult[], closerNodes: any[]): void {
    const context = this.activeSearches.get(searchId);
    if (!context) return;

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

    // Check if search is complete
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
    const { FileOps } = require('./database');
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
      .map((file: any) => ({
        filename: file.filename,
        fileHash: file.hash,
        size: file.size,
        mimeType: file.mimeType,
        peerId: this.destination,
        peerDisplayName: 'Me',
        addedAt: file.sharedAt
      }));
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
}

export const dhtSearch = new DHTSearchEngine();
