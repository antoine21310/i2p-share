import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

// Types for exposed API
interface ElectronAPI {
  // Search
  search: (query: string, filters: any) => Promise<any[]>;

  // Downloads
  startDownload: (fileHash: string, peerId: string, filename: string, size: number) => Promise<number>;
  pauseDownload: (downloadId: number) => Promise<void>;
  resumeDownload: (downloadId: number) => Promise<void>;
  cancelDownload: (downloadId: number) => Promise<void>;
  getDownloads: () => Promise<any[]>;

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
  startDownload: (fileHash: string, peerId: string, filename: string, size: number) =>
    ipcRenderer.invoke('download:start', fileHash, peerId, filename, size),
  pauseDownload: (downloadId: number) =>
    ipcRenderer.invoke('download:pause', downloadId),
  resumeDownload: (downloadId: number) =>
    ipcRenderer.invoke('download:resume', downloadId),
  cancelDownload: (downloadId: number) =>
    ipcRenderer.invoke('download:cancel', downloadId),
  getDownloads: () =>
    ipcRenderer.invoke('download:list'),

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
