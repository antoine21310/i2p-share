// Types for I2P Share Application
// Centralized types - DO NOT duplicate in other files!

// ============================================================================
// CORE ENTITIES
// ============================================================================

export interface FileInfo {
  id: number;
  path: string;
  filename: string;
  hash: string;
  size: number;
  mimeType: string;
  modifiedAt: number;
  sharedAt: number;
  isShared: boolean;
}

export interface SearchResult {
  filename: string;
  fileHash: string;
  size: number;
  mimeType: string;
  peerId: string;
  peerDisplayName: string;
  addedAt: number;
  quality?: string;
  streamingDestination?: string;
}

export interface SearchFilters {
  fileType?: 'all' | 'video' | 'audio' | 'image' | 'document' | 'archive';
  minSize?: number;
  maxSize?: number;
  mimeType?: string;
}

export interface Download {
  id: number;
  filename: string;
  fileHash: string;
  peerId: string;
  peerName: string;
  totalSize: number;
  downloadedSize: number;
  status: DownloadStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  progress: number;
  speed: number;
  error?: string;
  retryCount?: number;
}

export type DownloadStatus = 'pending' | 'connecting' | 'downloading' | 'paused' | 'completed' | 'failed';

export interface Peer {
  id?: number;
  peerId: string;
  destination: string;
  b32Address: string;
  displayName: string;
  avatar?: string;
  bio?: string;
  filesCount: number;
  totalSize: number;
  firstSeen?: number;
  lastSeen: number;
  isOnline: boolean;
  uploadSpeed?: number;
  streamingDestination?: string;
}

export interface TrackerPeer {
  destination: string;
  b32Address: string;
  displayName: string;
  filesCount: number;
  totalSize: number;
  lastSeen?: number;
  streamingDestination?: string;
}

export interface UserProfile {
  publicKey: string;
  privateKey?: string;
  userId: string;
  displayName: string;
  avatar?: string;
  bio?: string;
}

export interface SharedFolder {
  path: string;
  filesCount: number;
  totalSize: number;
  isScanning: boolean;
}

// ============================================================================
// NETWORK & CONNECTION
// ============================================================================

export interface NetworkStats {
  isConnected: boolean;
  activeTunnels: number;
  peersConnected: number;
  uploadSpeed: number;
  downloadSpeed: number;
  totalUploaded: number;
  totalDownloaded: number;
  statusText?: string;
}

export type ConnectionStatus =
  | 'disconnected'
  | 'downloading'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'error';

export interface ConnectionState {
  status: ConnectionStatus;
  error?: string;
  progress?: number;
}

// ============================================================================
// MESSAGES & PROTOCOLS
// ============================================================================

export interface TrackerMessage {
  type: TrackerMessageType;
  payload: any;
  timestamp: number;
  _from?: string;
  signature?: string;
  nonce?: string;
}

export type TrackerMessageType =
  | 'ANNOUNCE'
  | 'GET_PEERS'
  | 'PEERS_LIST'
  | 'PING'
  | 'PONG'
  | 'DISCONNECT'
  | 'ACK';

export interface DHTMessage {
  type: 'PING' | 'PONG' | 'FIND_NODE' | 'FIND_VALUE' | 'STORE' | 'ANNOUNCE';
  nodeId: string;
  payload: any;
  timestamp: number;
  signature?: string;
}

export interface P2PMessage {
  type: P2PMessageType;
  payload: any;
  timestamp: number;
  signature?: string;
}

export type P2PMessageType = 'GET_FILES' | 'FILES_LIST' | 'FILE_REQUEST' | 'FILE_CHUNK' | 'FILE_ERROR';

export interface PeerAnnounce {
  type: 'peer_announce';
  userId: string;
  displayName: string;
  avatar?: string;
  bio?: string;
  filesCount: number;
  totalSize: number;
  timestamp: number;
  signature: string;
}

export interface FileRequest {
  type: 'file_request';
  fileHash: string;
  range: {
    start: number;
    end: number;
  };
}

export interface FileIndex {
  type: 'file_index';
  peerId: string;
  files: Array<{
    hash: string;
    name: string;
    size: number;
    type: string;
    timestamp: number;
  }>;
  signature: string;
  timestamp: number;
}

// ============================================================================
// STREAMING PROTOCOL
// ============================================================================

export const MSG_FILE_REQUEST = 0x01;
export const MSG_FILE_HEADER = 0x02;
export const MSG_FILE_CHUNK = 0x03;
export const MSG_FILE_COMPLETE = 0x04;
export const MSG_FILE_ERROR = 0x05;

export interface StreamDownload {
  id: number;
  filename: string;
  fileHash: string;
  peerId: string;
  peerName: string;
  totalSize: number;
  downloadedSize: number;
  status: DownloadStatus;
  savePath: string;
  speed: number;
  startTime: number;
  lastError?: string;
  retryCount: number;
  chunkMap?: boolean[];
}

export interface UploadSession {
  clientId: string;
  fileHash: string;
  filename: string;
  totalSize: number;
  bytesSent: number;
  speed: number;
  startTime: number;
  isPaused: boolean;
}

// ============================================================================
// CONFIGURATION
// ============================================================================

export interface AppConfig {
  identity: UserProfile;
  network: {
    samHost: string;
    samPort: number;
    i2pDestination?: string;
    maxConnections: number;
  };
  sharing: {
    sharedFolders: string[];
    maxUploadSlots: number;
    maxUploadBandwidth: number;
  };
  search: {
    maxResults: number;
    searchTimeout: number;
    kademliaBucket: number;
  };
  downloads: {
    autoResume: boolean;
    maxRetries: number;
    retryDelayMs: number;
    minFreeSpaceBytes: number;
  };
  ui: {
    theme: 'light' | 'dark' | 'system';
    language: string;
  };
}

// ============================================================================
// CONSTANTS
// ============================================================================

export const CONSTANTS = {
  // Chunk sizes
  STREAMING_CHUNK_SIZE: 64 * 1024,      // 64KB for streaming
  PROGRESS_CHUNK_SIZE: 256 * 1024,      // 256KB for progress updates
  HASH_CHUNK_SIZE: 64 * 1024 * 1024,    // 64MB for file hashing

  // Timeouts (ms)
  CONNECTION_TIMEOUT: 120000,            // 2 minutes for I2P connections
  REQUEST_TIMEOUT: 60000,                // 1 minute for requests
  ANNOUNCE_INTERVAL: 2 * 60 * 1000,      // 2 minutes
  REFRESH_INTERVAL: 60 * 1000,           // 1 minute
  PEER_TIMEOUT: 5 * 60 * 1000,           // 5 minutes

  // Retry settings
  MAX_RETRIES: 5,
  RETRY_BASE_DELAY: 5000,                // 5 seconds
  RETRY_MAX_DELAY: 60000,                // 1 minute max

  // Limits
  MAX_PARALLEL_DOWNLOADS: 3,
  MAX_UPLOAD_SLOTS: 10,
  MAX_PEERS_PER_RESPONSE: 100,
  MIN_FREE_SPACE_BYTES: 100 * 1024 * 1024, // 100MB minimum

  // File limits
  MIN_FILE_SIZE: 1024,                   // 1KB
  MAX_FILE_SIZE: 100 * 1024 * 1024 * 1024, // 100GB
} as const;

// ============================================================================
// UI NOTIFICATIONS
// ============================================================================

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

// ============================================================================
// INDEXING
// ============================================================================

export interface IndexingProgress {
  folder: string;
  current: number;
  total: number;
  currentFile: string;
  status: 'scanning' | 'hashing' | 'complete' | 'error';
  error?: string;
}

// ============================================================================
// IPC CHANNEL TYPES
// ============================================================================

export type IPCChannels = {
  // Search
  'search:query': (query: string, filters: SearchFilters) => Promise<SearchResult[]>;
  'search:cancel': () => Promise<void>;

  // Downloads
  'download:start': (fileHash: string, peerId: string, filename: string, size: number) => Promise<number>;
  'download:pause': (downloadId: number) => Promise<void>;
  'download:resume': (downloadId: number) => Promise<void>;
  'download:cancel': (downloadId: number) => Promise<void>;
  'download:list': () => Promise<Download[]>;

  // Shares
  'shares:add-folder': (path: string) => Promise<SharedFolder>;
  'shares:remove-folder': (path: string) => Promise<void>;
  'shares:list': () => Promise<SharedFolder[]>;
  'shares:scan': (path: string) => Promise<void>;
  'shares:get-files': () => Promise<FileInfo[]>;

  // Network
  'network:status': () => Promise<NetworkStats>;
  'network:connect': () => Promise<void>;
  'network:disconnect': () => Promise<void>;

  // Config
  'config:get': () => Promise<AppConfig>;
  'config:set': (config: Partial<AppConfig>) => Promise<void>;

  // Peers
  'peers:list': () => Promise<Peer[]>;
  'peers:get-files': (peerId: string) => Promise<FileInfo[]>;
};
