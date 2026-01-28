import { create } from 'zustand';

interface SearchResult {
  filename: string;
  fileHash: string;
  size: number;
  mimeType: string;
  peerId: string;
  peerDisplayName: string;
  addedAt: number;
  streamingDestination?: string; // For I2P Streaming file transfers
}

interface Download {
  id: number;
  filename: string;
  fileHash: string;
  peerId: string;
  peerName: string;
  totalSize: number;
  downloadedSize: number;
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'failed';
  progress: number;
  speed: number;
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
  streamingDestination?: string; // For I2P Streaming file transfers
}

interface NetworkStatus {
  isConnected: boolean;
  activeTunnels: number;
  peersConnected: number;
  uploadSpeed: number;
  downloadSpeed: number;
  statusText: string;
}

interface AppStore {
  // Search
  searchQuery: string;
  searchResults: SearchResult[];
  isSearching: boolean;
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
  fetchSharedFolders: () => Promise<void>;
  fetchSharedFiles: () => Promise<void>;
  addSharedFolder: () => Promise<void>;
  removeSharedFolder: (path: string) => Promise<void>;

  // Peers
  peers: Peer[];
  fetchPeers: () => Promise<void>;

  // Network
  networkStatus: NetworkStatus;
  fetchNetworkStatus: () => Promise<void>;
}

export const useStore = create<AppStore>((set, get) => ({
  // Search state
  searchQuery: '',
  searchResults: [],
  isSearching: false,

  setSearchQuery: (query) => set({ searchQuery: query }),

  search: async (query) => {
    if (!query.trim()) {
      set({ searchResults: [], isSearching: false });
      return;
    }

    set({ isSearching: true, searchQuery: query });

    try {
      const results = await window.electron.search(query, {});
      set({ searchResults: results, isSearching: false });
    } catch (error) {
      console.error('Search error:', error);
      set({ isSearching: false });
    }
  },

  clearSearch: () => set({ searchQuery: '', searchResults: [], isSearching: false }),

  // Downloads state
  downloads: [],

  fetchDownloads: async () => {
    try {
      const downloads = await window.electron.getDownloads();
      set({ downloads });
    } catch (error) {
      console.error('Failed to fetch downloads:', error);
    }
  },

  startDownload: async (result) => {
    try {
      await window.electron.startDownload(
        result.fileHash,
        result.peerId,
        result.filename,
        result.size,
        result.streamingDestination // For I2P Streaming file transfers
      );
      await get().fetchDownloads();
    } catch (error) {
      console.error('Failed to start download:', error);
    }
  },

  pauseDownload: async (id) => {
    try {
      await window.electron.pauseDownload(id);
      await get().fetchDownloads();
    } catch (error) {
      console.error('Failed to pause download:', error);
    }
  },

  resumeDownload: async (id) => {
    try {
      await window.electron.resumeDownload(id);
      await get().fetchDownloads();
    } catch (error) {
      console.error('Failed to resume download:', error);
    }
  },

  cancelDownload: async (id) => {
    try {
      await window.electron.cancelDownload(id);
      await get().fetchDownloads();
    } catch (error) {
      console.error('Failed to cancel download:', error);
    }
  },

  // Shares state
  sharedFolders: [],
  sharedFiles: [],

  fetchSharedFolders: async () => {
    try {
      const folders = await window.electron.getSharedFolders();
      set({ sharedFolders: folders });
    } catch (error) {
      console.error('Failed to fetch shared folders:', error);
    }
  },

  fetchSharedFiles: async () => {
    try {
      const files = await window.electron.getSharedFiles();
      set({ sharedFiles: files });
    } catch (error) {
      console.error('Failed to fetch shared files:', error);
    }
  },

  addSharedFolder: async () => {
    try {
      const folder = await window.electron.addSharedFolder();
      if (folder) {
        await get().fetchSharedFolders();
        await get().fetchSharedFiles();
      }
    } catch (error) {
      console.error('Failed to add shared folder:', error);
    }
  },

  removeSharedFolder: async (path) => {
    try {
      await window.electron.removeSharedFolder(path);
      await get().fetchSharedFolders();
      await get().fetchSharedFiles();
    } catch (error) {
      console.error('Failed to remove shared folder:', error);
    }
  },

  // Peers state
  peers: [],

  fetchPeers: async () => {
    try {
      const peers = await window.electron.getPeers();
      set({ peers });
    } catch (error) {
      console.error('Failed to fetch peers:', error);
    }
  },

  // Network state
  networkStatus: {
    isConnected: false,
    activeTunnels: 0,
    peersConnected: 0,
    uploadSpeed: 0,
    downloadSpeed: 0,
    statusText: 'Connecting to I2P...'
  },

  fetchNetworkStatus: async () => {
    try {
      const status = await window.electron.getNetworkStatus();
      set({ networkStatus: status });
    } catch (error) {
      console.error('Failed to fetch network status:', error);
    }
  }
}));
