import { create } from 'zustand';
import { notify } from './components/Notifications';
import { formatBytes } from './utils/format';

// ============================================================================
// TYPES (imported from shared, but simplified for UI)
// ============================================================================

interface SearchResult {
  filename: string;
  fileHash: string;
  infoHash?: string | null; // BitTorrent infoHash for torrent-based downloads
  size: number;
  mimeType: string;
  peerId: string;
  peerDisplayName: string;
  addedAt: number;
  streamingDestination?: string;
}

interface Download {
  id: number;
  filename: string;
  fileHash: string;
  peerId: string;
  peerName: string;
  totalSize: number;
  downloadedSize: number;
  status: 'pending' | 'connecting' | 'downloading' | 'paused' | 'completed' | 'failed';
  progress: number;
  speed: number;
  error?: string;
}

interface SharedFolder {
  path: string;
  filesCount: number;
  totalSize: number;
  isScanning: boolean;
}

interface Peer {
  peerId: string;
  displayName: string;
  filesCount: number;
  totalSize: number;
  isOnline: boolean;
  lastSeen: number;
  streamingDestination?: string;
}

interface NetworkStatus {
  isConnected: boolean;
  activeTunnels: number;
  peersConnected: number;   // Online peers (seen recently)
  peersOnline: number;      // Same as peersConnected
  peersOffline: number;     // Offline peers (not seen recently)
  peersTotal: number;       // Total discovered peers
  uploadSpeed: number;
  downloadSpeed: number;
  statusText: string;
}

interface IndexingProgress {
  folder: string;
  current: number;
  total: number;
  currentFile: string;
  status: 'scanning' | 'hashing' | 'complete' | 'error';
}

// ============================================================================
// STORE
// ============================================================================

interface AppStore {
  // Search
  searchQuery: string;
  searchResults: SearchResult[];
  isSearching: boolean;
  searchError: string | null;
  setSearchQuery: (query: string) => void;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;

  // Downloads
  downloads: Download[];
  fetchDownloads: () => Promise<void>;
  startDownload: (result: SearchResult) => Promise<void>;
  pauseDownload: (id: number) => Promise<void>;
  resumeDownload: (id: number) => Promise<void>;
  cancelDownload: (id: number) => Promise<void>;

  // Shares
  sharedFolders: SharedFolder[];
  sharedFiles: any[];
  indexingProgress: IndexingProgress | null;
  fetchSharedFolders: () => Promise<void>;
  fetchSharedFiles: () => Promise<void>;
  addSharedFolder: () => Promise<void>;
  removeSharedFolder: (path: string) => Promise<void>;

  // Peers
  peers: Peer[];
  fetchPeers: () => Promise<void>;

  // Network
  networkStatus: NetworkStatus;
  connectionError: string | null;
  fetchNetworkStatus: () => Promise<void>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;

  // Event handling (call once on app init)
  setupEventListeners: () => () => void;
}

export const useStore = create<AppStore>((set, get) => ({
  // ============================================================================
  // SEARCH
  // ============================================================================
  searchQuery: '',
  searchResults: [],
  isSearching: false,
  searchError: null,

  setSearchQuery: (query) => set({ searchQuery: query }),

  search: async (query) => {
    // Validate query
    const trimmed = query.trim();
    if (!trimmed) {
      set({ searchResults: [], isSearching: false, searchError: null });
      return;
    }

    if (trimmed.length < 2) {
      set({ searchError: 'Query must be at least 2 characters' });
      return;
    }

    if (trimmed.length > 500) {
      set({ searchError: 'Query too long (max 500 characters)' });
      return;
    }

    set({ isSearching: true, searchQuery: query, searchError: null });

    try {
      const results = await window.electron.search(trimmed, {});
      set({ searchResults: results, isSearching: false });

      if (results.length === 0) {
        notify.info('No results', `No files found for "${trimmed}"`);
      }
    } catch (error: any) {
      console.error('Search error:', error);
      const errorMsg = error.message || 'Search failed';
      set({ isSearching: false, searchError: errorMsg });
      notify.error('Search failed', errorMsg);
    }
  },

  clearSearch: () => set({ searchQuery: '', searchResults: [], isSearching: false, searchError: null }),

  // ============================================================================
  // DOWNLOADS
  // ============================================================================
  downloads: [],

  fetchDownloads: async () => {
    try {
      const downloads = await window.electron.getDownloads();
      set({ downloads });
    } catch (error: any) {
      console.error('Failed to fetch downloads:', error);
    }
  },

  startDownload: async (result) => {
    try {
      // Check if already downloading
      const existing = get().downloads.find(d =>
        d.fileHash === result.fileHash && !['completed', 'failed'].includes(d.status)
      );
      if (existing) {
        notify.warning('Already downloading', `${result.filename} is already in your download queue`);
        return;
      }

      await window.electron.startDownload(
        result.fileHash,
        result.peerId,
        result.filename,
        result.size,
        result.peerDisplayName || 'Unknown Peer',
        result.streamingDestination,
        result.infoHash || undefined // Pass infoHash for torrent-based downloads
      );

      notify.success('Download started', result.filename);
      await get().fetchDownloads();
    } catch (error: any) {
      console.error('Failed to start download:', error);
      notify.error('Download failed', error.message || 'Could not start download');
    }
  },

  pauseDownload: async (id) => {
    try {
      await window.electron.pauseDownload(id);
      await get().fetchDownloads();
    } catch (error: any) {
      console.error('Failed to pause download:', error);
      notify.error('Pause failed', error.message);
    }
  },

  resumeDownload: async (id) => {
    try {
      await window.electron.resumeDownload(id);
      notify.info('Download resumed');
      await get().fetchDownloads();
    } catch (error: any) {
      console.error('Failed to resume download:', error);
      notify.error('Resume failed', error.message);
    }
  },

  cancelDownload: async (id) => {
    try {
      await window.electron.cancelDownload(id);
      await get().fetchDownloads();
    } catch (error: any) {
      console.error('Failed to cancel download:', error);
      notify.error('Cancel failed', error.message);
    }
  },

  // ============================================================================
  // SHARES
  // ============================================================================
  sharedFolders: [],
  sharedFiles: [],
  indexingProgress: null,

  fetchSharedFolders: async () => {
    try {
      const folders = await window.electron.getSharedFolders();
      set({ sharedFolders: folders });
    } catch (error: any) {
      console.error('Failed to fetch shared folders:', error);
    }
  },

  fetchSharedFiles: async () => {
    try {
      const files = await window.electron.getSharedFiles();
      set({ sharedFiles: files });
    } catch (error: any) {
      console.error('Failed to fetch shared files:', error);
    }
  },

  addSharedFolder: async () => {
    try {
      const folder = await window.electron.addSharedFolder();
      if (folder) {
        notify.success('Folder added', `Scanning ${folder.path}...`);
        await get().fetchSharedFolders();
        await get().fetchSharedFiles();
      }
    } catch (error: any) {
      console.error('Failed to add shared folder:', error);
      notify.error('Failed to add folder', error.message);
    }
  },

  removeSharedFolder: async (path) => {
    try {
      await window.electron.removeSharedFolder(path);
      notify.success('Folder removed');
      await get().fetchSharedFolders();
      await get().fetchSharedFiles();
    } catch (error: any) {
      console.error('Failed to remove shared folder:', error);
      notify.error('Failed to remove folder', error.message);
    }
  },

  // ============================================================================
  // PEERS
  // ============================================================================
  peers: [],

  fetchPeers: async () => {
    try {
      const peers = await window.electron.getPeers();
      set({ peers });
    } catch (error: any) {
      console.error('Failed to fetch peers:', error);
    }
  },

  // ============================================================================
  // NETWORK
  // ============================================================================
  networkStatus: {
    isConnected: false,
    activeTunnels: 0,
    peersConnected: 0,
    peersOnline: 0,
    peersOffline: 0,
    peersTotal: 0,
    uploadSpeed: 0,
    downloadSpeed: 0,
    statusText: 'Connecting to I2P...'
  },
  connectionError: null,

  fetchNetworkStatus: async () => {
    try {
      const status = await window.electron.getNetworkStatus();
      set({ networkStatus: status, connectionError: null });
    } catch (error: any) {
      console.error('Failed to fetch network status:', error);
    }
  },

  connect: async () => {
    try {
      set({ connectionError: null });
      const result = await window.electron.connect();
      if (!result.success) {
        set({ connectionError: result.message });
        notify.error('Connection failed', result.message);
      } else {
        notify.success('Connected', 'Successfully connected to I2P network');
      }
    } catch (error: any) {
      set({ connectionError: error.message });
      notify.error('Connection error', error.message);
    }
  },

  disconnect: async () => {
    try {
      await window.electron.disconnect();
      notify.info('Disconnected', 'Disconnected from I2P network');
    } catch (error: any) {
      notify.error('Disconnect error', error.message);
    }
  },

  // ============================================================================
  // EVENT LISTENERS
  // ============================================================================
  setupEventListeners: () => {
    const unsubscribers: (() => void)[] = [];

    // Download events - use events instead of polling
    unsubscribers.push(
      window.electron.on('download:added', () => get().fetchDownloads()),
      window.electron.on('download:started', () => get().fetchDownloads()),
      window.electron.on('download:progress', (data: any) => {
        // Update download in place without full refresh
        set(state => ({
          downloads: state.downloads.map(d =>
            d.id === data.id
              ? { ...d, downloadedSize: data.downloadedSize, progress: data.progress, speed: data.speed, status: 'downloading' }
              : d
          )
        }));
      }),
      window.electron.on('download:paused', () => get().fetchDownloads()),
      window.electron.on('download:resumed', () => get().fetchDownloads()),
      window.electron.on('download:completed', (data: any) => {
        get().fetchDownloads();
        notify.success('Download complete', data.filename);
      }),
      window.electron.on('download:failed', (data: any) => {
        get().fetchDownloads();
        notify.error('Download failed', `${data.filename}: ${data.error}`);
      })
    );

    // Scan/indexing events
    unsubscribers.push(
      window.electron.on('scan:start', (data: any) => {
        set({
          indexingProgress: {
            folder: data.path,
            current: 0,
            total: 0,
            currentFile: '',
            status: 'scanning'
          }
        });
      }),
      window.electron.on('scan:progress', (data: any) => {
        set({
          indexingProgress: {
            folder: data.path,
            current: data.current,
            total: data.total,
            currentFile: data.currentFile || '',
            status: data.status || 'scanning'
          }
        });
      }),
      window.electron.on('scan:complete', (data: any) => {
        set({ indexingProgress: null });
        get().fetchSharedFolders();
        get().fetchSharedFiles();
        notify.success('Scan complete', `Found ${data.filesCount} files (${formatBytes(data.totalSize)})`);
      })
    );

    // Network events
    unsubscribers.push(
      window.electron.on('network:connected', () => {
        get().fetchNetworkStatus();
        get().fetchPeers();
      }),
      window.electron.on('network:disconnected', () => {
        get().fetchNetworkStatus();
      }),
      window.electron.on('network:error', (data: any) => {
        set({ connectionError: data.error });
        notify.error('Network error', data.error);
      }),
      window.electron.on('network:status-change', () => {
        get().fetchNetworkStatus();
      })
    );

    // Peer events
    unsubscribers.push(
      window.electron.on('peer:discovered', (data: any) => {
        get().fetchPeers();
        // Don't spam notifications for every peer
      }),
      window.electron.on('peers:updated', () => {
        get().fetchPeers();
      }),
      // Real-time peer presence events
      window.electron.on('peer:online', (data: any) => {
        // Update peer status in-place for instant UI update
        set(state => {
          const existingPeerIndex = state.peers.findIndex(p =>
            p.peerId === data.peerId || p.peerId === data.b32Address
          );

          if (existingPeerIndex >= 0) {
            // Update existing peer to online
            const updatedPeers = [...state.peers];
            updatedPeers[existingPeerIndex] = {
              ...updatedPeers[existingPeerIndex],
              isOnline: true,
              lastSeen: Math.floor(Date.now() / 1000),
              displayName: data.displayName || updatedPeers[existingPeerIndex].displayName,
              filesCount: data.filesCount || updatedPeers[existingPeerIndex].filesCount,
              totalSize: data.totalSize || updatedPeers[existingPeerIndex].totalSize
            };
            return { peers: updatedPeers };
          } else {
            // Add new peer
            const newPeer: Peer = {
              peerId: data.peerId || data.b32Address,
              displayName: data.displayName || 'Unknown',
              filesCount: data.filesCount || 0,
              totalSize: data.totalSize || 0,
              isOnline: true,
              lastSeen: Math.floor(Date.now() / 1000),
              streamingDestination: data.streamingDestination
            };
            return { peers: [...state.peers, newPeer] };
          }
        });

        // Also update network status counts
        get().fetchNetworkStatus();

        // Optional: Show notification for new peer
        notify.info('Peer online', data.displayName || 'A new peer joined the network');
      }),
      window.electron.on('peer:offline', (data: any) => {
        // Update peer status in-place for instant UI update
        set(state => {
          const updatedPeers = state.peers.map(peer => {
            if (peer.peerId === data.peerId || peer.peerId === data.b32Address) {
              return {
                ...peer,
                isOnline: false,
                lastSeen: Math.floor(Date.now() / 1000) - 600 // Mark as offline (10 mins ago)
              };
            }
            return peer;
          });
          return { peers: updatedPeers };
        });

        // Also update network status counts
        get().fetchNetworkStatus();

        // Optional: Show notification
        notify.info('Peer offline', data.displayName || 'A peer left the network');
      })
    );

    // Slower polling for status (every 10 seconds instead of 5)
    const statusInterval = setInterval(() => {
      get().fetchNetworkStatus();
    }, 10000);

    // Even slower polling for peers (every 30 seconds)
    const peersInterval = setInterval(() => {
      get().fetchPeers();
    }, 30000);

    // Downloads polling only as fallback (every 5 seconds)
    const downloadsInterval = setInterval(() => {
      const hasActiveDownloads = get().downloads.some(d =>
        ['pending', 'connecting', 'downloading'].includes(d.status)
      );
      if (hasActiveDownloads) {
        get().fetchDownloads();
      }
    }, 5000);

    // Cleanup function
    return () => {
      unsubscribers.forEach(unsub => unsub());
      clearInterval(statusInterval);
      clearInterval(peersInterval);
      clearInterval(downloadsInterval);
    };
  }
}));
