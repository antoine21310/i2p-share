// Types for I2P Share Application

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
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'failed';
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  progress: number;
  speed: number;
}

export interface Peer {
  id: number;
  peerId: string;
  displayName: string;
  avatar?: string;
  bio?: string;
  filesCount: number;
  totalSize: number;
  firstSeen: number;
  lastSeen: number;
  isOnline: boolean;
  uploadSpeed?: number;
}

export interface UserProfile {
  publicKey: string;
  privateKey?: string;
  userId: string;
  displayName: string;
  avatar?: string;
  bio?: string;
}

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
  ui: {
    theme: 'light' | 'dark' | 'system';
    language: string;
  };
}

export interface SharedFolder {
  path: string;
  filesCount: number;
  totalSize: number;
  isScanning: boolean;
}

export interface NetworkStats {
  isConnected: boolean;
  activeTunnels: number;
  peersConnected: number;
  uploadSpeed: number;
  downloadSpeed: number;
  totalUploaded: number;
  totalDownloaded: number;
}

// IPC Channel types
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

// DHT Message types
export interface DHTMessage {
  type: 'PING' | 'PONG' | 'FIND_NODE' | 'FIND_VALUE' | 'STORE' | 'ANNOUNCE';
  nodeId: string;
  payload: any;
  timestamp: number;
  signature?: string;
}

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
