import electron from 'electron';
import type { IpcRendererEvent } from 'electron';

const { contextBridge, ipcRenderer } = electron;

// Types for exposed API
interface AddTorrentResult {
  infoHash: string;
  name: string;
}

interface CreateTorrentResult {
  magnetUri: string;
  torrentData: Buffer;
  infoHash: string;
}

interface ElectronAPI {
  // Search
  search: (query: string, filters: any) => Promise<any[]>;

  // Downloads (legacy - delegates to torrent system)
  startDownload: (fileHash: string, peerId: string, filename: string, size: number, peerName: string, streamingDest?: string) => Promise<number>;
  pauseDownload: (downloadId: number) => Promise<void>;
  resumeDownload: (downloadId: number) => Promise<void>;
  cancelDownload: (downloadId: number) => Promise<void>;
  getDownloads: () => Promise<any[]>;
  getActiveUploads: () => Promise<any[]>;

  // Torrents
  addTorrent: (torrentData: ArrayBuffer) => Promise<AddTorrentResult>;
  addMagnet: (magnetUri: string) => Promise<AddTorrentResult>;
  createTorrent: (filePath: string, options?: { name?: string; comment?: string; private?: boolean }) => Promise<CreateTorrentResult>;
  getTorrentStatus: (infoHash: string) => Promise<any>;
  listTorrents: () => Promise<any[]>;
  removeTorrent: (infoHash: string, deleteFiles?: boolean) => Promise<void>;
  pauseTorrent: (infoHash: string) => Promise<void>;
  resumeTorrent: (infoHash: string) => Promise<void>;
  addTorrentPeer: (infoHash: string, destination: string) => Promise<boolean>;
  getTorrentGlobalStats: () => Promise<any>;
  addTorrentFile: () => Promise<AddTorrentResult | null>;

  // Shares
  addSharedFolder: () => Promise<any>;
  removeSharedFolder: (path: string) => Promise<void>;
  getSharedFolders: () => Promise<any[]>;
  getSharedFiles: () => Promise<any[]>;
  scanFolder: (path: string) => Promise<void>;

  // Network
  getNetworkStatus: () => Promise<any>;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;

  // Peers
  getPeers: () => Promise<any[]>;
  getPeerFiles: (peerId: string) => Promise<any[]>;
  requestPeerFiles: (peerId: string) => Promise<{ success: boolean }>;
  getAllRemoteFiles: () => Promise<any[]>;

  // Tracker
  getTrackerAddresses: () => Promise<string[]>;
  setTrackerAddresses: (addresses: string[]) => Promise<{ success: boolean }>;
  getActiveTracker: () => Promise<string | null>;
  getTrackerPeers: () => Promise<any[]>;
  refreshTrackerPeers: () => Promise<{ success: boolean }>;
  // Legacy single address (backwards compat)
  getTrackerAddress: () => Promise<string>;
  setTrackerAddress: (address: string) => Promise<{ success: boolean }>;

  // Profile
  getDisplayName: () => Promise<string>;
  setDisplayName: (name: string) => Promise<{ success: boolean }>;

  // Embedded Tracker
  getEmbeddedTrackerEnabled: () => Promise<boolean>;
  setEmbeddedTrackerEnabled: (enabled: boolean) => Promise<{ success: boolean }>;
  getEmbeddedTrackerStatus: () => Promise<{
    isRunning: boolean;
    b32Address: string | null;
    btTrackerB32: string | null;
    peersCount: number;
    torrentsCount: number;
    uptime: number;
  }>;

  // Window controls
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;

  // Shell
  openPath: (path: string) => Promise<void>;
  showItemInFolder: (path: string) => Promise<void>;

  // Events
  on: (channel: string, callback: (...args: any[]) => void) => () => void;
  off: (channel: string, callback: (...args: any[]) => void) => void;
}

const api: ElectronAPI = {
  // Search
  search: (query: string, filters: any) =>
    ipcRenderer.invoke('search:query', query, filters),

  // Downloads
  startDownload: (fileHash: string, peerId: string, filename: string, size: number, peerName: string, streamingDest?: string) =>
    ipcRenderer.invoke('download:start', fileHash, peerId, filename, size, peerName, streamingDest),
  pauseDownload: (downloadId: number) =>
    ipcRenderer.invoke('download:pause', downloadId),
  resumeDownload: (downloadId: number) =>
    ipcRenderer.invoke('download:resume', downloadId),
  cancelDownload: (downloadId: number) =>
    ipcRenderer.invoke('download:cancel', downloadId),
  getDownloads: () =>
    ipcRenderer.invoke('download:list'),
  getActiveUploads: () =>
    ipcRenderer.invoke('uploads:active'),

  // Torrents
  addTorrent: (torrentData: ArrayBuffer) =>
    ipcRenderer.invoke('torrent:add', Buffer.from(torrentData)),
  addMagnet: (magnetUri: string) =>
    ipcRenderer.invoke('torrent:addMagnet', magnetUri),
  createTorrent: (filePath: string, options?: { name?: string; comment?: string; private?: boolean }) =>
    ipcRenderer.invoke('torrent:create', filePath, options),
  getTorrentStatus: (infoHash: string) =>
    ipcRenderer.invoke('torrent:status', infoHash),
  listTorrents: () =>
    ipcRenderer.invoke('torrent:list'),
  removeTorrent: (infoHash: string, deleteFiles?: boolean) =>
    ipcRenderer.invoke('torrent:remove', infoHash, deleteFiles),
  pauseTorrent: (infoHash: string) =>
    ipcRenderer.invoke('torrent:pause', infoHash),
  resumeTorrent: (infoHash: string) =>
    ipcRenderer.invoke('torrent:resume', infoHash),
  addTorrentPeer: (infoHash: string, destination: string) =>
    ipcRenderer.invoke('torrent:addPeer', infoHash, destination),
  getTorrentGlobalStats: () =>
    ipcRenderer.invoke('torrent:globalStats'),
  addTorrentFile: () =>
    ipcRenderer.invoke('torrent:addFile'),

  // Shares
  addSharedFolder: () =>
    ipcRenderer.invoke('shares:add-folder'),
  removeSharedFolder: (path: string) =>
    ipcRenderer.invoke('shares:remove-folder', path),
  getSharedFolders: () =>
    ipcRenderer.invoke('shares:list'),
  getSharedFiles: () =>
    ipcRenderer.invoke('shares:get-files'),
  scanFolder: (path: string) =>
    ipcRenderer.invoke('shares:scan', path),

  // Network
  getNetworkStatus: () =>
    ipcRenderer.invoke('network:status'),
  connect: () =>
    ipcRenderer.invoke('network:connect'),
  disconnect: () =>
    ipcRenderer.invoke('network:disconnect'),

  // Peers
  getPeers: () =>
    ipcRenderer.invoke('peers:list'),
  getPeerFiles: (peerId: string) =>
    ipcRenderer.invoke('peers:get-files', peerId),
  requestPeerFiles: (peerId: string) =>
    ipcRenderer.invoke('peers:request-files', peerId),
  getAllRemoteFiles: () =>
    ipcRenderer.invoke('remote-files:all'),

  // Tracker
  getTrackerAddresses: () =>
    ipcRenderer.invoke('tracker:get-addresses'),
  setTrackerAddresses: (addresses: string[]) =>
    ipcRenderer.invoke('tracker:set-addresses', addresses),
  getActiveTracker: () =>
    ipcRenderer.invoke('tracker:get-active'),
  getTrackerPeers: () =>
    ipcRenderer.invoke('tracker:get-peers'),
  refreshTrackerPeers: () =>
    ipcRenderer.invoke('tracker:refresh'),
  // Legacy single address (backwards compat)
  getTrackerAddress: () =>
    ipcRenderer.invoke('tracker:get-address'),
  setTrackerAddress: (address: string) =>
    ipcRenderer.invoke('tracker:set-address', address),

  // Profile
  getDisplayName: () =>
    ipcRenderer.invoke('profile:get-display-name'),
  setDisplayName: (name: string) =>
    ipcRenderer.invoke('profile:set-display-name', name),

  // Embedded Tracker
  getEmbeddedTrackerEnabled: () =>
    ipcRenderer.invoke('embedded-tracker:get-enabled'),
  setEmbeddedTrackerEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('embedded-tracker:set-enabled', enabled),
  getEmbeddedTrackerStatus: () =>
    ipcRenderer.invoke('embedded-tracker:get-status'),

  // Window controls
  minimizeWindow: () =>
    ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () =>
    ipcRenderer.invoke('window:maximize'),
  closeWindow: () =>
    ipcRenderer.invoke('window:close'),

  // Shell
  openPath: (path: string) =>
    ipcRenderer.invoke('shell:openPath', path),
  showItemInFolder: (path: string) =>
    ipcRenderer.invoke('shell:showItemInFolder', path),

  // Events
  on: (channel: string, callback: (...args: any[]) => void) => {
    const subscription = (_event: IpcRendererEvent, ...args: any[]) => callback(...args);
    ipcRenderer.on(channel, subscription);
    return () => {
      ipcRenderer.removeListener(channel, subscription);
    };
  },
  off: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, callback);
  }
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electron', api);

// Type declaration for the renderer
declare global {
  interface Window {
    electron: ElectronAPI;
  }
}
