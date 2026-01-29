/**
 * BitTorrent Types for I2P Share
 * Comprehensive TypeScript interfaces for BitTorrent protocol support
 */

// ============================================================================
// TORRENT METADATA
// ============================================================================

/**
 * Complete torrent metadata including info dictionary
 */
export interface TorrentMetadata {
  /** 20-byte SHA1 hash of the info dictionary (hex encoded) */
  infoHash: string;
  /** Display name of the torrent */
  name: string;
  /** Total size in bytes */
  totalSize: number;
  /** Size of each piece in bytes */
  pieceLength: number;
  /** Total number of pieces */
  pieceCount: number;
  /** Concatenated SHA1 hashes of all pieces (Buffer or hex string) */
  pieces: Buffer | string;
  /** Files in the torrent (single file or multi-file) */
  files: TorrentFile[];
  /** Magnet URI for this torrent */
  magnetUri?: string;
  /** Raw .torrent file data */
  torrentData?: Buffer;
  /** Creation date timestamp */
  createdAt?: number;
  /** Created by application name */
  createdBy?: string;
  /** Comment field */
  comment?: string;
  /** Announce URL for tracker */
  announce?: string;
  /** List of tracker URLs */
  announceList?: string[][];
  /** Whether this is a private torrent */
  isPrivate?: boolean;
}

/**
 * File entry within a torrent
 */
export interface TorrentFile {
  /** File path relative to torrent root (array of path components for multi-file) */
  path: string;
  /** File size in bytes */
  size: number;
  /** Byte offset within the torrent data */
  offset: number;
  /** Original path array for multi-file torrents */
  pathArray?: string[];
}

/**
 * Simplified torrent info for listing
 */
export interface TorrentInfo {
  infoHash: string;
  name: string;
  totalSize: number;
  progress: number;
  state: TorrentState;
  downloadSpeed: number;
  uploadSpeed: number;
  peersCount: number;
  seedersCount: number;
  leechersCount: number;
  createdAt: number;
}

// ============================================================================
// TORRENT STATUS AND STATE
// ============================================================================

/**
 * Torrent lifecycle states
 */
export enum TorrentState {
  /** Checking existing pieces on disk */
  CHECKING = 'checking',
  /** Downloading pieces from peers */
  DOWNLOADING = 'downloading',
  /** Complete and seeding to others */
  SEEDING = 'seeding',
  /** Paused by user */
  PAUSED = 'paused',
  /** Stopped completely */
  STOPPED = 'stopped',
  /** Waiting for metadata (magnet link) */
  METADATA = 'metadata',
  /** Queued for download */
  QUEUED = 'queued',
  /** Error state */
  ERROR = 'error'
}

/**
 * Detailed status of a torrent
 */
export interface TorrentStatus {
  infoHash: string;
  name: string;
  state: TorrentState;
  /** Progress as percentage (0-100) */
  progress: number;
  /** Download speed in bytes/second */
  downloadSpeed: number;
  /** Upload speed in bytes/second */
  uploadSpeed: number;
  /** Total bytes downloaded */
  downloadedBytes: number;
  /** Total bytes uploaded */
  uploadedBytes: number;
  /** Upload/download ratio */
  ratio: number;
  /** Estimated time to completion in seconds */
  eta: number;
  /** Number of connected peers */
  peersCount: number;
  /** Number of seeders */
  seedersCount: number;
  /** Number of leechers */
  leechersCount: number;
  /** Pieces completed */
  piecesCompleted: number;
  /** Total pieces */
  piecesTotal: number;
  /** Error message if in error state */
  error?: string;
  /** Save path for downloaded files */
  savePath?: string;
}

// ============================================================================
// PIECE MANAGEMENT
// ============================================================================

/**
 * Information about a single piece
 */
export interface PieceInfo {
  /** Zero-based piece index */
  index: number;
  /** Expected SHA1 hash (20 bytes hex) */
  hash: string;
  /** Size in bytes (may be smaller for last piece) */
  length: number;
  /** Whether the piece has been verified */
  isComplete: boolean;
  /** Number of peers who have this piece */
  availability?: number;
}

/**
 * Block request within a piece
 */
export interface BlockRequest {
  /** Piece index */
  index: number;
  /** Byte offset within the piece */
  begin: number;
  /** Block length (usually 16KB) */
  length: number;
}

/**
 * Bitfield for tracking piece availability
 */
export class BitField {
  private buffer: Buffer;
  public readonly length: number;

  constructor(lengthOrBuffer: number | Buffer) {
    if (Buffer.isBuffer(lengthOrBuffer)) {
      this.buffer = Buffer.from(lengthOrBuffer);
      this.length = this.buffer.length * 8;
    } else {
      this.length = lengthOrBuffer;
      this.buffer = Buffer.alloc(Math.ceil(lengthOrBuffer / 8));
    }
  }

  get(index: number): boolean {
    if (index < 0 || index >= this.length) return false;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);
    return (this.buffer[byteIndex] & (1 << bitIndex)) !== 0;
  }

  set(index: number, value: boolean = true): void {
    if (index < 0 || index >= this.length) return;
    const byteIndex = Math.floor(index / 8);
    const bitIndex = 7 - (index % 8);
    if (value) {
      this.buffer[byteIndex] |= (1 << bitIndex);
    } else {
      this.buffer[byteIndex] &= ~(1 << bitIndex);
    }
  }

  toBuffer(): Buffer {
    return Buffer.from(this.buffer);
  }

  /** Count number of set bits */
  count(): number {
    let count = 0;
    for (let i = 0; i < this.length; i++) {
      if (this.get(i)) count++;
    }
    return count;
  }

  /** Check if all bits are set */
  isComplete(): boolean {
    return this.count() === this.length;
  }

  /** Get indices of missing pieces */
  getMissing(): number[] {
    const missing: number[] = [];
    for (let i = 0; i < this.length; i++) {
      if (!this.get(i)) missing.push(i);
    }
    return missing;
  }

  /** Get indices of available pieces */
  getAvailable(): number[] {
    const available: number[] = [];
    for (let i = 0; i < this.length; i++) {
      if (this.get(i)) available.push(i);
    }
    return available;
  }
}

// ============================================================================
// PEER MANAGEMENT
// ============================================================================

/**
 * Information about a peer
 */
export interface PeerInfo {
  /** I2P destination (base64) */
  destination: string;
  /** Short B32 address */
  b32Address?: string;
  /** Total bytes downloaded from this peer */
  downloadedFrom: number;
  /** Total bytes uploaded to this peer */
  uploadedTo: number;
  /** Last seen timestamp */
  lastSeen: number;
  /** Peer's bitfield (pieces they have) */
  bitfield?: BitField;
  /** Whether peer is choking us */
  peerChoking: boolean;
  /** Whether peer is interested in us */
  peerInterested: boolean;
  /** Whether we are choking peer */
  amChoking: boolean;
  /** Whether we are interested in peer */
  amInterested: boolean;
  /** Current download rate from this peer (bytes/sec) */
  downloadRate: number;
  /** Current upload rate to this peer (bytes/sec) */
  uploadRate: number;
  /** Client name/version if available */
  client?: string;
}

/**
 * Peer state for wire protocol
 */
export interface PeerState {
  peerChoking: boolean;
  peerInterested: boolean;
  amChoking: boolean;
  amInterested: boolean;
}

// ============================================================================
// WIRE PROTOCOL
// ============================================================================

/**
 * BitTorrent handshake message
 */
export interface Handshake {
  /** Protocol string (should be "BitTorrent protocol") */
  protocol: string;
  /** 8 reserved bytes for extensions */
  reserved: Buffer;
  /** 20-byte infoHash */
  infoHash: Buffer;
  /** 20-byte peerId */
  peerId: Buffer;
}

/**
 * Wire protocol message types
 */
export enum WireMessageType {
  CHOKE = 0,
  UNCHOKE = 1,
  INTERESTED = 2,
  NOT_INTERESTED = 3,
  HAVE = 4,
  BITFIELD = 5,
  REQUEST = 6,
  PIECE = 7,
  CANCEL = 8,
  PORT = 9,
  // Extension protocol (BEP10)
  EXTENDED = 20
}

/**
 * Extended message types (BEP10)
 */
export enum ExtendedMessageType {
  HANDSHAKE = 0,
  UT_METADATA = 1
}

// ============================================================================
// TRACKER PROTOCOL (BEP3)
// ============================================================================

/**
 * Tracker announce request parameters
 */
export interface AnnounceRequest {
  /** 20-byte infoHash (hex encoded) */
  info_hash: string;
  /** 20-byte peerId (hex encoded) */
  peer_id: string;
  /** I2P destination (port not used in I2P) */
  port: string;
  /** Total bytes uploaded */
  uploaded: number;
  /** Total bytes downloaded */
  downloaded: number;
  /** Bytes remaining */
  left: number;
  /** Event type: started, completed, stopped, or empty */
  event?: 'started' | 'completed' | 'stopped' | '';
  /** Request compact response */
  compact?: 0 | 1;
  /** Number of peers wanted */
  numwant?: number;
}

/**
 * Tracker announce response
 */
export interface AnnounceResponse {
  /** Interval in seconds for next announce */
  interval: number;
  /** Minimum interval (optional) */
  min_interval?: number;
  /** Tracker ID for session */
  tracker_id?: string;
  /** Number of seeders */
  complete: number;
  /** Number of leechers */
  incomplete: number;
  /** List of peers */
  peers: TrackerPeer[];
  /** Warning message */
  warning_message?: string;
  /** Failure reason */
  failure_reason?: string;
}

/**
 * Peer info from tracker
 */
export interface TrackerPeer {
  /** I2P destination */
  destination: string;
  /** B32 address (optional) */
  b32Address?: string;
}

/**
 * Scrape response for a single torrent
 */
export interface ScrapeInfo {
  /** Number of peers with complete file (seeders) */
  complete: number;
  /** Number of times downloaded */
  downloaded: number;
  /** Number of peers downloading (leechers) */
  incomplete: number;
  /** Torrent name (optional) */
  name?: string;
}

// ============================================================================
// DHT PROTOCOL (BEP5)
// ============================================================================

/**
 * DHT get_peers request
 */
export interface DHTGetPeersQuery {
  /** Querying node's ID (20 bytes) */
  id: Buffer;
  /** InfoHash to find peers for (20 bytes) */
  info_hash: Buffer;
}

/**
 * DHT get_peers response
 */
export interface DHTGetPeersResponse {
  /** Responding node's ID */
  id: Buffer;
  /** Token for announce_peer */
  token: Buffer;
  /** Compact peer info (if peers found) */
  values?: Buffer[];
  /** Closer nodes (if no peers found) */
  nodes?: Buffer;
}

/**
 * DHT announce_peer request
 */
export interface DHTAnnouncePeerQuery {
  /** Querying node's ID (20 bytes) */
  id: Buffer;
  /** InfoHash announcing for (20 bytes) */
  info_hash: Buffer;
  /** I2P destination */
  port: string;
  /** Token from get_peers response */
  token: Buffer;
  /** Implied port flag */
  implied_port?: 0 | 1;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

/**
 * Adaptive piece size based on total file size
 */
export function calculatePieceLength(totalSize: number): number {
  if (totalSize < 16 * 1024 * 1024) {
    // < 16 MB
    return 16 * 1024; // 16 KB
  } else if (totalSize < 128 * 1024 * 1024) {
    // 16-128 MB
    return 64 * 1024; // 64 KB
  } else if (totalSize < 512 * 1024 * 1024) {
    // 128-512 MB
    return 128 * 1024; // 128 KB
  } else if (totalSize < 2 * 1024 * 1024 * 1024) {
    // 512 MB - 2 GB
    return 256 * 1024; // 256 KB
  } else if (totalSize < 8 * 1024 * 1024 * 1024) {
    // 2-8 GB
    return 512 * 1024; // 512 KB
  } else {
    // > 8 GB
    return 1024 * 1024; // 1 MB
  }
}

/**
 * Torrent engine configuration
 */
export interface TorrentConfig {
  /** Maximum number of peers per torrent */
  maxPeers: number;
  /** Maximum number of concurrent uploads */
  maxUploadSlots: number;
  /** Download speed limit (bytes/sec, 0 = unlimited) */
  downloadSpeedLimit: number;
  /** Upload speed limit (bytes/sec, 0 = unlimited) */
  uploadSpeedLimit: number;
  /** Directory for saving downloads */
  downloadPath: string;
  /** Interval for choking algorithm (ms) */
  chokingInterval: number;
  /** Interval for optimistic unchoke (ms) */
  optimisticUnchokeInterval: number;
  /** Number of peers to unchoke */
  unchokeSlots: number;
  /** Request timeout (ms) */
  requestTimeout: number;
  /** Connection timeout for I2P streams (ms) */
  connectionTimeout: number;
  /** Announce interval (ms) */
  announceInterval: number;
}

/**
 * Default torrent configuration
 */
export const DEFAULT_TORRENT_CONFIG: TorrentConfig = {
  maxPeers: 50,
  maxUploadSlots: 10,
  downloadSpeedLimit: 0,
  uploadSpeedLimit: 0,
  downloadPath: '',
  chokingInterval: 10000, // 10 seconds
  optimisticUnchokeInterval: 30000, // 30 seconds
  unchokeSlots: 4,
  requestTimeout: 30000, // 30 seconds
  connectionTimeout: 120000, // 2 minutes for I2P
  announceInterval: 1800000 // 30 minutes
};

// ============================================================================
// CONSTANTS
// ============================================================================

export const TORRENT_CONSTANTS = {
  /** Block size for piece requests (16 KB standard) */
  BLOCK_SIZE: 16 * 1024,
  /** Protocol identifier for handshake */
  PROTOCOL_ID: 'BitTorrent protocol',
  /** Max outstanding requests per peer */
  MAX_REQUESTS_PER_PEER: 5,
  /** Piece hash length (SHA1 = 20 bytes) */
  PIECE_HASH_LENGTH: 20,
  /** InfoHash length (SHA1 = 20 bytes) */
  INFO_HASH_LENGTH: 20,
  /** PeerId length */
  PEER_ID_LENGTH: 20,
  /** Handshake reserved bytes */
  RESERVED_BYTES: 8,
  /** Keep-alive interval (ms) */
  KEEP_ALIVE_INTERVAL: 120000
} as const;

// ============================================================================
// IPC API TYPES
// ============================================================================

/**
 * Result of adding a torrent
 */
export interface AddTorrentResult {
  infoHash: string;
  name: string;
}

/**
 * Result of creating a torrent
 */
export interface CreateTorrentResult {
  magnetUri: string;
  torrentData: Buffer;
  infoHash: string;
}

/**
 * IPC API for torrent operations
 */
export interface TorrentIPC {
  'torrent:add': (torrentData: Buffer) => Promise<AddTorrentResult>;
  'torrent:addMagnet': (magnetUri: string) => Promise<AddTorrentResult>;
  'torrent:create': (filePath: string) => Promise<CreateTorrentResult>;
  'torrent:status': (infoHash: string) => Promise<TorrentStatus>;
  'torrent:list': () => Promise<TorrentInfo[]>;
  'torrent:remove': (infoHash: string, deleteFiles: boolean) => Promise<void>;
  'torrent:pause': (infoHash: string) => Promise<void>;
  'torrent:resume': (infoHash: string) => Promise<void>;
}

