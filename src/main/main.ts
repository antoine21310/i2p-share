import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import Store from 'electron-store';
import { initDatabase, closeDatabase, FileOps, SharedFolderOps, PeerOps, RemoteFileOps } from './database';
import { fileIndexer } from './file-indexer';
import { dhtSearch } from './dht-search';
import { fileServer } from './file-server';
import { downloadClient } from './download-client';
import { i2pConnection } from './i2p-connection';
import { i2pdManager } from './i2pd-manager';
import { trackerClient } from './tracker-client';
import type { SearchFilters, NetworkStats, SearchResult } from '../shared/types';

// Configuration store
const store = new Store({
  defaults: {
    trackerAddresses: [] as string[] // List of tracker addresses for redundancy
  }
});

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

    // Search remote files from peers (cached in database)
    const remoteResults = RemoteFileOps.search(query).map((f: any) => ({
      filename: f.filename,
      fileHash: f.hash,
      size: f.size,
      mimeType: f.mimeType,
      peerId: f.peerId,
      peerDisplayName: f.peerName || 'Unknown Peer',
      addedAt: f.lastUpdated
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

    // Deduplicate by fileHash (prefer local > remote > DHT)
    const seen = new Set<string>();
    const results: SearchResult[] = [];

    for (const r of localResults) {
      if (!seen.has(r.fileHash)) {
        seen.add(r.fileHash);
        results.push(r);
      }
    }
    for (const r of remoteResults) {
      if (!seen.has(r.fileHash)) {
        seen.add(r.fileHash);
        results.push(r);
      }
    }
    for (const r of dhtResults) {
      if (!seen.has(r.fileHash)) {
        seen.add(r.fileHash);
        results.push(r);
      }
    }

    console.log(`[IPC] Search results: ${localResults.length} local, ${remoteResults.length} remote, ${dhtResults.length} DHT`);
    return results;
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

    // Combine DHT nodes and tracker peers
    const trackerPeersCount = trackerClient.getPeersCount();
    const totalPeers = Math.max(dhtStats.nodesCount, trackerPeersCount);

    return {
      isConnected: connectionStatus === 'connected',
      activeTunnels: i2pState.isConnected ? 12 : 0,
      peersConnected: totalPeers,
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

        // Connect to tracker for peer discovery
        await connectToTracker(result.destination);

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
    // Note: lastSeen is stored as Unix timestamp in seconds, not milliseconds
    const fiveMinutesAgoInSeconds = Math.floor(Date.now() / 1000) - 5 * 60;
    return dbPeers.map(p => ({
      ...p,
      isOnline: p.lastSeen > fiveMinutesAgoInSeconds
    }));
  });

  ipcMain.handle('peers:get-files', async (_event, peerId: string) => {
    return RemoteFileOps.getByPeer(peerId);
  });

  ipcMain.handle('peers:request-files', async (_event, peerId: string) => {
    await requestFilesFromPeer(peerId);
    return { success: true };
  });

  ipcMain.handle('remote-files:all', async () => {
    return RemoteFileOps.getAll();
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

  // Tracker configuration
  ipcMain.handle('tracker:get-addresses', async () => {
    return store.get('trackerAddresses', []);
  });

  ipcMain.handle('tracker:set-addresses', async (_event, addresses: string[]) => {
    const validAddresses = addresses.filter(a => a && a.trim().length > 0);
    store.set('trackerAddresses', validAddresses);
    trackerClient.setTrackerAddresses(validAddresses);

    // If already connected to I2P, reconnect to trackers
    if (i2pConnection.isReady()) {
      const state = i2pConnection.getState();
      await connectToTracker(state.destination);
    }

    return { success: true };
  });

  ipcMain.handle('tracker:get-active', async () => {
    return trackerClient.getActiveTracker();
  });

  ipcMain.handle('tracker:get-peers', async () => {
    return trackerClient.getPeers();
  });

  ipcMain.handle('tracker:refresh', async () => {
    await trackerClient.requestPeers();
    return { success: true };
  });

  // Legacy single address support (for backwards compatibility)
  ipcMain.handle('tracker:get-address', async () => {
    const addresses = store.get('trackerAddresses', []) as string[];
    return addresses.length > 0 ? addresses[0] : '';
  });

  ipcMain.handle('tracker:set-address', async (_event, address: string) => {
    const addresses = address ? [address] : [];
    store.set('trackerAddresses', addresses);
    trackerClient.setTrackerAddresses(addresses);

    if (i2pConnection.isReady()) {
      const state = i2pConnection.getState();
      await connectToTracker(state.destination);
    }

    return { success: true };
  });
}

async function connectToTracker(myDestination: string): Promise<void> {
  const trackerAddresses = store.get('trackerAddresses', []) as string[];

  if (trackerAddresses.length === 0) {
    console.log('[Main] No tracker addresses configured - peer discovery disabled');
    console.log('[Main] Configure tracker addresses in settings to discover peers');
    return;
  }

  console.log(`[Main] Connecting to trackers (${trackerAddresses.length} configured)...`);
  console.log(`[Main] My destination (first 50 chars): ${myDestination.substring(0, 50)}...`);
  console.log(`[Main] Tracker address (first 50 chars): ${trackerAddresses[0]?.substring(0, 50)}...`);

  // Set up tracker client with all addresses
  trackerClient.setTrackerAddresses(trackerAddresses);
  trackerClient.setIdentity(myDestination);
  trackerClient.setMessageHandler(async (dest, msg) => {
    console.log(`[Main] Sending message to ${dest.substring(0, 30)}...: ${msg.type}`);
    const result = await i2pConnection.sendMessage(dest, msg);
    console.log(`[Main] Send result: ${result}`);
    return result;
  });

  // Update stats
  const files = fileIndexer.getAllFiles();
  trackerClient.updateStats(files.length, files.reduce((sum, f: any) => sum + f.size, 0));

  // Connect to a random tracker
  const connected = await trackerClient.connect();

  if (connected) {
    const activeTracker = trackerClient.getActiveTracker();
    console.log('[Main] Connected to tracker:', activeTracker?.substring(0, 20) + '...');
  } else {
    console.log('[Main] Failed to connect to any tracker');
  }
}

// P2P file exchange protocol
function handleP2PMessage(from: string, message: any): boolean {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'GET_FILES':
      handleGetFilesRequest(from);
      return true;
    case 'FILES_LIST':
      handleFilesListResponse(from, message.payload);
      return true;
    default:
      return false;
  }
}

function handleGetFilesRequest(from: string): void {
  console.log(`[P2P] Received GET_FILES request from ${from.substring(0, 30)}...`);

  // Get our shared files
  const files = fileIndexer.getAllFiles();
  const filesList = files.map((f: any) => ({
    filename: f.filename,
    hash: f.hash,
    size: f.size,
    mimeType: f.mimeType
  }));

  // Send response
  const response = {
    type: 'FILES_LIST',
    payload: { files: filesList },
    timestamp: Date.now()
  };

  i2pConnection.sendMessage(from, response);
  console.log(`[P2P] Sent FILES_LIST with ${filesList.length} files to ${from.substring(0, 30)}...`);
}

function handleFilesListResponse(from: string, payload: any): void {
  const files = payload?.files || [];
  console.log(`[P2P] Received FILES_LIST with ${files.length} files from ${from.substring(0, 30)}...`);

  if (files.length === 0) return;

  // Save to database
  RemoteFileOps.upsertBatch(from, files);
  console.log(`[P2P] Saved ${files.length} remote files to database`);

  // Notify UI
  mainWindow?.webContents.send('remote-files:updated', { peerId: from, files });
}

async function requestFilesFromPeer(peerDestination: string): Promise<void> {
  if (!i2pConnection.isReady()) return;

  console.log(`[P2P] Requesting files from peer ${peerDestination.substring(0, 30)}...`);

  const message = {
    type: 'GET_FILES',
    payload: {},
    timestamp: Date.now()
  };

  await i2pConnection.sendMessage(peerDestination, message);
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

  // Forward tracker client events - save discovered peers to database
  trackerClient.on('peer:discovered', (peer) => {
    console.log(`[Main] Tracker discovered peer: ${peer.displayName} (${peer.b32Address.substring(0, 16)}...)`);
    PeerOps.upsert({
      peerId: peer.destination,
      displayName: peer.displayName,
      filesCount: peer.filesCount,
      totalSize: peer.totalSize
    });
    mainWindow?.webContents.send('peer:discovered', peer);

    // Request files from this new peer
    requestFilesFromPeer(peer.destination);
  });

  trackerClient.on('peers:updated', (peers) => {
    console.log(`[Main] Tracker peers updated: ${peers.length} peers`);
    // Update all peers in database and request files
    for (const peer of peers) {
      PeerOps.upsert({
        peerId: peer.destination,
        displayName: peer.displayName,
        filesCount: peer.filesCount,
        totalSize: peer.totalSize
      });

      // Request files from each peer (will get fresh list)
      requestFilesFromPeer(peer.destination);
    }
    mainWindow?.webContents.send('peers:updated', peers);
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
    // First check if it's a tracker message
    const isTrackerMessage = trackerClient.handleMessage(from, message);
    if (isTrackerMessage) return;

    // Check if it's a P2P file exchange message
    const isP2PMessage = handleP2PMessage(from, message);
    if (isP2PMessage) return;

    // Otherwise route to DHT handler
    dhtSearch.handleMessage(from, message);
  });

  // Forward tracker events
  trackerClient.on('peer:discovered', (peer) => {
    console.log('[Main] New peer from tracker:', peer.b32Address.substring(0, 16) + '...');

    // Add to DHT routing table for future communication
    const nodeId = require('crypto').createHash('sha1').update(peer.destination).digest('hex');
    dhtSearch.updateNode(nodeId, peer.destination);

    // Save to database
    PeerOps.upsert({
      peerId: peer.destination,
      displayName: peer.displayName,
      filesCount: peer.filesCount,
      totalSize: peer.totalSize
    });

    mainWindow?.webContents.send('peer:discovered', peer);
  });

  trackerClient.on('peers:updated', (peers) => {
    mainWindow?.webContents.send('tracker:peers-updated', peers);
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

      // Connect to tracker for peer discovery
      await connectToTracker(result.destination);

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

  // Disconnect from I2P (but keep i2pd running for tracker)
  await i2pConnection.disconnect();

  // Don't stop i2pd - keep it running so tracker can continue working
  // If you want to stop i2pd, run: i2pdManager.stop() manually
  // await i2pdManager.stop();

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
