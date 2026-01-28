import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import { initDatabase, closeDatabase, FileOps, SharedFolderOps, PeerOps } from './database';
import { fileIndexer } from './file-indexer';
import { dhtSearch } from './dht-search';
import { fileServer } from './file-server';
import { downloadClient } from './download-client';
import { i2pConnection } from './i2p-connection';
import { i2pdManager } from './i2pd-manager';
import type { SearchFilters, NetworkStats, SearchResult } from '../shared/types';

let mainWindow: BrowserWindow | null = null;
let connectionStatus: 'disconnected' | 'downloading' | 'starting' | 'connecting' | 'connected' | 'error' = 'disconnected';
let connectionError: string = '';
let downloadProgress: number = 0;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0f172a',
    titleBarStyle: 'hiddenInset',
    frame: process.platform === 'darwin' ? true : false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Load the built files
  mainWindow.loadFile(path.join(__dirname, '../../renderer/index.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function setupIPC(): void {
  // Search - uses DHT for distributed search
  ipcMain.handle('search:query', async (_event, query: string, filters: SearchFilters) => {
    console.log('[IPC] Search:', query, filters);

    // First search local files
    const localResults = fileIndexer.searchFiles(query).map((f: any) => ({
      filename: f.filename,
      fileHash: f.hash,
      size: f.size,
      mimeType: f.mimeType,
      peerId: 'local',
      peerDisplayName: 'Me (Local)',
      addedAt: f.sharedAt
    }));

    // DHT search for remote peers (only if connected to I2P)
    let dhtResults: SearchResult[] = [];
    if (i2pConnection.isReady()) {
      try {
        dhtResults = await dhtSearch.search(query, filters, 10000);
      } catch (e) {
        console.log('[IPC] DHT search error:', e);
      }
    } else {
      console.log('[IPC] Skipping DHT search - not connected to I2P');
    }

    return [...localResults, ...dhtResults];
  });

  // Downloads
  ipcMain.handle('download:start', async (_event, fileHash: string, peerId: string, filename: string, size: number) => {
    if (!i2pConnection.isReady()) {
      throw new Error('Not connected to I2P network');
    }
    return downloadClient.addDownload(filename, fileHash, peerId, 'Unknown Peer', size);
  });

  ipcMain.handle('download:pause', async (_event, downloadId: number) => {
    downloadClient.pauseDownload(downloadId);
  });

  ipcMain.handle('download:resume', async (_event, downloadId: number) => {
    downloadClient.resumeDownload(downloadId);
  });

  ipcMain.handle('download:cancel', async (_event, downloadId: number) => {
    downloadClient.cancelDownload(downloadId);
  });

  ipcMain.handle('download:list', async () => {
    return downloadClient.getDownloads();
  });

  // Shares
  ipcMain.handle('shares:add-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openDirectory']
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const folderPath = result.filePaths[0];
      await fileIndexer.addFolder(folderPath);
      return {
        path: folderPath,
        filesCount: 0,
        totalSize: 0,
        isScanning: true
      };
    }
    return null;
  });

  ipcMain.handle('shares:remove-folder', async (_event, folderPath: string) => {
    await fileIndexer.removeFolder(folderPath);
  });

  ipcMain.handle('shares:list', async () => {
    return fileIndexer.getSharedFolders();
  });

  ipcMain.handle('shares:get-files', async () => {
    return fileIndexer.getAllFiles();
  });

  ipcMain.handle('shares:scan', async (_event, folderPath: string) => {
    await fileIndexer.scanFolder(folderPath);
  });

  // Network
  ipcMain.handle('network:status', async (): Promise<NetworkStats & { statusText: string }> => {
    const dhtStats = dhtSearch.getStats();
    const uploadStats = fileServer.getStats();
    const activeDownloads = downloadClient.getActiveDownloads();
    const i2pState = i2pConnection.getState();

    let statusText = '';
    switch (connectionStatus) {
      case 'disconnected':
        statusText = 'Disconnected';
        break;
      case 'downloading':
        statusText = `Downloading I2P... ${downloadProgress}%`;
        break;
      case 'starting':
        statusText = 'Starting I2P daemon...';
        break;
      case 'connecting':
        statusText = 'Connecting to I2P network...';
        break;
      case 'connected':
        statusText = `Connected (${i2pState.b32Address.substring(0, 8)}...)`;
        break;
      case 'error':
        statusText = `Error: ${connectionError}`;
        break;
    }

    return {
      isConnected: connectionStatus === 'connected',
      activeTunnels: i2pState.isConnected ? 12 : 0,
      peersConnected: dhtStats.nodesCount,
      uploadSpeed: uploadStats.totalSpeed,
      downloadSpeed: activeDownloads.reduce((sum, d) => sum + d.speed, 0),
      totalUploaded: 0,
      totalDownloaded: 0,
      statusText
    };
  });

  ipcMain.handle('network:connect', async () => {
    if (connectionStatus === 'connecting' || connectionStatus === 'downloading' || connectionStatus === 'starting') {
      return { success: false, message: 'Already connecting' };
    }

    try {
      // Start i2pd if not running
      if (!i2pdManager.isRunning()) {
        connectionStatus = 'starting';
        mainWindow?.webContents.send('network:status-change', { status: connectionStatus });
        await i2pdManager.start();
      }

      connectionStatus = 'connecting';
      connectionError = '';
      mainWindow?.webContents.send('network:status-change', { status: connectionStatus });

      const result = await i2pConnection.connect();

      if (result.isConnected) {
        connectionStatus = 'connected';

        // Set up DHT with our I2P identity
        dhtSearch.setIdentity(result.destination, result.destination);

        // Set up message handler for DHT
        dhtSearch.setMessageHandler(async (dest, message) => {
          await i2pConnection.sendMessage(dest, message);
        });

        // Start file server and download client
        fileServer.setConnection(i2pConnection);
        downloadClient.setConnection(i2pConnection);

        // Announce ourselves to the network
        const files = fileIndexer.getAllFiles();
        await dhtSearch.announceFiles(files);

        mainWindow?.webContents.send('network:connected');
        return { success: true, address: result.b32Address };
      } else {
        connectionStatus = 'error';
        connectionError = result.error || 'Connection failed';
        mainWindow?.webContents.send('network:status-change', {
          status: connectionStatus,
          error: connectionError
        });
        return { success: false, message: connectionError };
      }
    } catch (error: any) {
      connectionStatus = 'error';
      connectionError = error.message;
      mainWindow?.webContents.send('network:status-change', {
        status: connectionStatus,
        error: connectionError
      });
      return { success: false, message: error.message };
    }
  });

  ipcMain.handle('network:disconnect', async () => {
    await i2pConnection.disconnect();
    connectionStatus = 'disconnected';
    connectionError = '';
    mainWindow?.webContents.send('network:disconnected');
  });

  // Peers
  ipcMain.handle('peers:list', async () => {
    const dbPeers = PeerOps.getAll() as any[];
    // Check which peers we've seen recently (within last 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    return dbPeers.map(p => ({
      ...p,
      isOnline: p.lastSeen > fiveMinutesAgo
    }));
  });

  // Window controls
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });

  // Open file in system
  ipcMain.handle('shell:openPath', async (_event, filePath: string) => {
    shell.openPath(filePath);
  });

  ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });
}

function setupEventForwarding(): void {
  // Forward file indexer events
  fileIndexer.on('scan:progress', (data) => {
    mainWindow?.webContents.send('scan:progress', data);
  });

  fileIndexer.on('scan:complete', (data) => {
    mainWindow?.webContents.send('scan:complete', data);

    // Re-announce files when scan completes
    if (i2pConnection.isReady()) {
      const files = fileIndexer.getAllFiles();
      dhtSearch.announceFiles(files);
    }
  });

  // Forward download events
  downloadClient.on('download:progress', (data) => {
    mainWindow?.webContents.send('download:progress', data);
  });

  downloadClient.on('download:completed', (data) => {
    mainWindow?.webContents.send('download:completed', data);
  });

  downloadClient.on('download:failed', (data) => {
    mainWindow?.webContents.send('download:failed', data);
  });

  // Forward DHT events
  dhtSearch.on('search:result', (data) => {
    mainWindow?.webContents.send('search:result', data);
  });

  dhtSearch.on('peer:announce', (data) => {
    mainWindow?.webContents.send('peer:announce', data);
    // Update peer in database
    PeerOps.upsert({
      peerId: data.peerId,
      displayName: data.announce.displayName,
      filesCount: data.announce.filesCount,
      totalSize: data.announce.totalSize
    });
  });

  // Forward I2P connection events
  i2pConnection.on('connected', (data) => {
    console.log('[Main] I2P connected:', data.b32Address);
    connectionStatus = 'connected';
    mainWindow?.webContents.send('network:connected', data);
  });

  i2pConnection.on('disconnected', () => {
    console.log('[Main] I2P disconnected');
    connectionStatus = 'disconnected';
    mainWindow?.webContents.send('network:disconnected');
  });

  i2pConnection.on('error', (error) => {
    console.error('[Main] I2P error:', error);
    connectionStatus = 'error';
    connectionError = error.message;
    mainWindow?.webContents.send('network:error', { error: error.message });
  });

  i2pConnection.on('message', ({ from, message }) => {
    // Route messages to DHT handler
    dhtSearch.handleMessage(from, message);
  });

  // Forward i2pd manager events
  i2pdManager.on('state', (state) => {
    console.log('[Main] i2pd state:', state.status);
    if (state.status === 'downloading') {
      connectionStatus = 'downloading';
      downloadProgress = state.progress || 0;
    } else if (state.status === 'starting') {
      connectionStatus = 'starting';
    } else if (state.status === 'error') {
      connectionStatus = 'error';
      connectionError = state.error || 'Unknown error';
    }
    mainWindow?.webContents.send('network:status-change', {
      status: connectionStatus,
      progress: downloadProgress
    });
  });
}

async function startI2PAndConnect(): Promise<void> {
  console.log('[Main] Starting I2P infrastructure...');

  try {
    // Check if i2pd is installed, download if needed
    const isInstalled = await i2pdManager.isInstalled();
    if (!isInstalled) {
      console.log('[Main] i2pd not found, downloading...');
      connectionStatus = 'downloading';
      mainWindow?.webContents.send('network:status-change', { status: connectionStatus });
    }

    // Start i2pd daemon
    connectionStatus = 'starting';
    mainWindow?.webContents.send('network:status-change', { status: connectionStatus });
    await i2pdManager.start();

    // Connect to SAM bridge
    console.log('[Main] i2pd started, connecting to SAM...');
    connectionStatus = 'connecting';
    mainWindow?.webContents.send('network:status-change', { status: connectionStatus });

    const result = await i2pConnection.connect();

    if (result.isConnected) {
      console.log('[Main] Connected to I2P:', result.b32Address);
      connectionStatus = 'connected';

      // Initialize DHT
      dhtSearch.setIdentity(result.destination, result.destination);
      dhtSearch.setMessageHandler(async (dest, message) => {
        await i2pConnection.sendMessage(dest, message);
      });

      // Start file server and download client
      fileServer.setConnection(i2pConnection);
      downloadClient.setConnection(i2pConnection);

      mainWindow?.webContents.send('network:connected', {
        address: result.b32Address
      });
    } else {
      console.error('[Main] Failed to connect to I2P:', result.error);
      connectionStatus = 'error';
      connectionError = result.error || 'Connection failed';
      mainWindow?.webContents.send('network:status-change', {
        status: connectionStatus,
        error: connectionError
      });
    }
  } catch (error: any) {
    console.error('[Main] I2P startup error:', error.message);
    connectionStatus = 'error';
    connectionError = error.message;
    mainWindow?.webContents.send('network:status-change', {
      status: connectionStatus,
      error: connectionError
    });
  }
}

app.whenReady().then(async () => {
  console.log('[Main] Starting I2P Share...');

  // Initialize database
  initDatabase();
  console.log('[Main] Database initialized');

  // Load saved data
  dhtSearch.loadFromDatabase();
  downloadClient.loadFromDatabase();

  // Setup IPC handlers
  setupIPC();
  setupEventForwarding();

  // Create window
  createWindow();

  // Auto-start I2P and connect (after window loads)
  setTimeout(() => {
    startI2PAndConnect();
  }, 1500);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  console.log('[Main] Shutting down...');

  // Disconnect from I2P
  await i2pConnection.disconnect();

  // Stop i2pd daemon
  await i2pdManager.stop();

  // Close database
  closeDatabase();
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('[Main] Uncaught exception:', error);
});

process.on('unhandledRejection', (reason) => {
  console.error('[Main] Unhandled rejection:', reason);
});
