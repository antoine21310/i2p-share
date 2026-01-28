import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import path from 'path';
import Store from 'electron-store';
import { initDatabase, closeDatabase, FileOps, SharedFolderOps, PeerOps, RemoteFileOps } from './database';
import { fileIndexer } from './file-indexer';
import { dhtSearch } from './dht-search';
import { fileServer } from './file-server';
import { downloadClient } from './download-client';
import { streamingClient } from './streaming-client';
import { streamingServer } from './streaming-server';
import { i2pConnection } from './i2p-connection';
import { i2pdManager } from './i2pd-manager';
import { trackerClient } from './tracker-client';
import type { SearchFilters, NetworkStats, SearchResult } from '../shared/types';

// Use streaming by default (more reliable), fallback to UDP for compatibility
const USE_STREAMING = true;

// Configuration store
const store = new Store({
  defaults: {
    trackerAddresses: [] as string[], // List of tracker addresses for redundancy
    displayName: 'I2P Share User' // User's display name visible to other peers
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

  // Downloads - use streaming client for reliable transfers
  // peerId can be either the datagram destination or the streaming destination
  ipcMain.handle('download:start', async (_event, fileHash: string, peerId: string, filename: string, size: number, streamingDest?: string) => {
    if (!i2pConnection.isReady()) {
      throw new Error('Not connected to I2P network');
    }

    if (USE_STREAMING) {
      // Use I2P Streaming for reliable transfers with resume support
      // Prefer streaming destination if available, fall back to regular peerId
      const targetDest = streamingDest || peerId;
      return streamingClient.addDownload(filename, fileHash, targetDest, 'Unknown Peer', size);
    } else {
      // Legacy UDP-based transfers
      return downloadClient.addDownload(filename, fileHash, peerId, 'Unknown Peer', size);
    }
  });

  ipcMain.handle('download:pause', async (_event, downloadId: number) => {
    if (USE_STREAMING) {
      streamingClient.pauseDownload(downloadId);
    } else {
      downloadClient.pauseDownload(downloadId);
    }
  });

  ipcMain.handle('download:resume', async (_event, downloadId: number) => {
    if (USE_STREAMING) {
      streamingClient.resumeDownload(downloadId);
    } else {
      downloadClient.resumeDownload(downloadId);
    }
  });

  ipcMain.handle('download:cancel', async (_event, downloadId: number) => {
    if (USE_STREAMING) {
      streamingClient.cancelDownload(downloadId);
    } else {
      downloadClient.cancelDownload(downloadId);
    }
  });

  ipcMain.handle('download:list', async () => {
    if (USE_STREAMING) {
      return streamingClient.getDownloads();
    } else {
      return downloadClient.getDownloads();
    }
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
    const uploadStats = USE_STREAMING ? streamingServer.getStats() : fileServer.getStats();
    const activeDownloads = USE_STREAMING ? streamingClient.getActiveDownloads() : downloadClient.getActiveDownloads();
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

    // Use tracker peers count as the primary source (these are actually online)
    const trackerPeersCount = trackerClient.getPeersCount();

    // Get real tunnel count from i2pd (or default to 0)
    const activeTunnels = i2pState.isConnected ? await i2pdManager.getActiveTunnelCount() : 0;

    return {
      isConnected: connectionStatus === 'connected',
      activeTunnels,
      peersConnected: trackerPeersCount, // Only count actual online peers from tracker
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
        if (USE_STREAMING) {
          // Start streaming server for reliable file transfers
          console.log('[Main] Starting streaming server...');
          try {
            const streamingDest = await streamingServer.start();
            console.log('[Main] Streaming server started');
            // Set streaming destination for tracker announcements
            trackerClient.setStreamingDestination(streamingDest);
          } catch (err: any) {
            console.error('[Main] Failed to start streaming server:', err.message);
          }
          // Load pending downloads
          streamingClient.loadFromDatabase();
        } else {
          // Legacy UDP-based transfers
          fileServer.setConnection(i2pConnection);
          downloadClient.setConnection(i2pConnection);
        }

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
    // Return only online peers from the tracker (no database storage)
    const trackerPeers = trackerClient.getPeers();

    // Deduplicate by destination (use Map to keep only unique peers)
    const uniquePeers = new Map<string, any>();
    for (const peer of trackerPeers) {
      // Use b32 address as key for deduplication
      const key = peer.b32Address || peer.destination.substring(0, 50);
      if (!uniquePeers.has(key)) {
        uniquePeers.set(key, {
          peerId: peer.destination,
          displayName: peer.displayName || 'Unknown',
          filesCount: peer.filesCount || 0,
          totalSize: peer.totalSize || 0,
          b32Address: peer.b32Address,
          streamingDestination: peer.streamingDestination, // For I2P Streaming downloads
          isOnline: true, // All tracker peers are online
          lastSeen: Math.floor(Date.now() / 1000)
        });
      }
    }

    return Array.from(uniquePeers.values());
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

  // User profile settings
  ipcMain.handle('profile:get-display-name', async () => {
    return store.get('displayName', 'I2P Share User');
  });

  ipcMain.handle('profile:set-display-name', async (_event, name: string) => {
    const displayName = name.trim() || 'I2P Share User';
    store.set('displayName', displayName);
    // Update tracker client with new display name
    trackerClient.setDisplayName(displayName);
    // Re-announce to tracker with new name if connected
    if (i2pConnection.isReady()) {
      trackerClient.announce();
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
  const storedDisplayName = store.get('displayName', 'I2P Share User') as string;
  trackerClient.setIdentity(myDestination, storedDisplayName);
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

  // Forward download events (both streaming and legacy)
  if (USE_STREAMING) {
    // Notify UI immediately when download is added
    streamingClient.on('download:added', (data) => {
      mainWindow?.webContents.send('download:added', data);
    });

    streamingClient.on('download:started', (data) => {
      mainWindow?.webContents.send('download:started', data);
    });

    streamingClient.on('download:progress', (data) => {
      mainWindow?.webContents.send('download:progress', data);
    });

    streamingClient.on('download:completed', (data) => {
      mainWindow?.webContents.send('download:completed', data);
    });

    streamingClient.on('download:failed', (data) => {
      mainWindow?.webContents.send('download:failed', data);
    });

    streamingClient.on('download:paused', (data) => {
      mainWindow?.webContents.send('download:paused', data);
    });

    streamingClient.on('download:resumed', (data) => {
      mainWindow?.webContents.send('download:resumed', data);
    });

    // Forward upload events from streaming server
    streamingServer.on('upload:start', (data) => {
      mainWindow?.webContents.send('upload:start', data);
    });

    streamingServer.on('upload:progress', (data) => {
      mainWindow?.webContents.send('upload:progress', data);
    });

    streamingServer.on('upload:complete', (data) => {
      mainWindow?.webContents.send('upload:complete', data);
    });
  } else {
    downloadClient.on('download:progress', (data) => {
      mainWindow?.webContents.send('download:progress', data);
    });

    downloadClient.on('download:completed', (data) => {
      mainWindow?.webContents.send('download:completed', data);
    });

    downloadClient.on('download:failed', (data) => {
      mainWindow?.webContents.send('download:failed', data);
    });
  }

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
  // NOTE: These are the main handlers, don't duplicate below
  trackerClient.on('peer:discovered', (peer) => {
    console.log(`[Main] Tracker discovered peer: ${peer.displayName} (${peer.b32Address.substring(0, 16)}...)`);

    // Save to database
    PeerOps.upsert({
      peerId: peer.destination,
      displayName: peer.displayName,
      filesCount: peer.filesCount,
      totalSize: peer.totalSize
    });

    // Add to DHT routing table for future communication
    const crypto = require('crypto');
    const nodeId = crypto.createHash('sha1').update(peer.destination).digest('hex');
    dhtSearch.updateNode(nodeId, peer.destination);

    mainWindow?.webContents.send('peer:discovered', peer);

    // Request files from this new peer (with small delay to let connection stabilize)
    setTimeout(() => requestFilesFromPeer(peer.destination), 500);
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

      // Add to DHT routing table
      const crypto = require('crypto');
      const nodeId = crypto.createHash('sha1').update(peer.destination).digest('hex');
      dhtSearch.updateNode(nodeId, peer.destination);

      // Request files from each peer (will get fresh list)
      setTimeout(() => requestFilesFromPeer(peer.destination), 500);
    }
    mainWindow?.webContents.send('peers:updated', peers);
    mainWindow?.webContents.send('tracker:peers-updated', peers);
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
    // Log ALL incoming messages for debugging
    const fromShort = from.substring(0, 30);
    console.log(`[Main] Received message type=${message?.type} from ${fromShort}...`);

    // First check if it's a tracker message
    const isTrackerMessage = trackerClient.handleMessage(from, message);
    if (isTrackerMessage) {
      console.log(`[Main] -> Handled as tracker message`);
      return;
    }

    // Check if it's a P2P file exchange message
    const isP2PMessage = handleP2PMessage(from, message);
    if (isP2PMessage) {
      console.log(`[Main] -> Handled as P2P message`);
      return;
    }

    // Otherwise route to DHT handler
    console.log(`[Main] -> Routing to DHT handler`);
    dhtSearch.handleMessage(from, message);
  });

  // Note: tracker event handlers are defined above, no duplicates needed here

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
      if (USE_STREAMING) {
        // Start streaming server for reliable file transfers
        console.log('[Main] Starting streaming server...');
        try {
          const streamingDest = await streamingServer.start();
          console.log('[Main] Streaming server started');
          // Set streaming destination for tracker announcements
          trackerClient.setStreamingDestination(streamingDest);
        } catch (err: any) {
          console.error('[Main] Failed to start streaming server:', err.message);
        }
        // Load pending downloads
        streamingClient.loadFromDatabase();
      } else {
        // Legacy UDP-based transfers
        fileServer.setConnection(i2pConnection);
        downloadClient.setConnection(i2pConnection);
      }

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
  if (!USE_STREAMING) {
    downloadClient.loadFromDatabase();
  }
  // Note: streamingClient.loadFromDatabase() is called when I2P connects

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

  // Stop streaming server
  if (USE_STREAMING) {
    await streamingServer.stop();
  }

  // Notify tracker that we're disconnecting (so other peers are updated)
  await trackerClient.disconnect();

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
