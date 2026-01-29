import type { BrowserWindow as BrowserWindowType } from 'electron';
import Store from 'electron-store';
import path from 'path';
import type { SearchFilters, SearchResult } from '../shared/types.js';
import {
    closeDatabase,
    FileOps,
    initDatabase,
    PeerOps,
    RemoteFileOps,
    RoutingOps,
    TorrentOps
} from './database.js';
import { dhtSearch } from './dht-search.js';
import { FileIndexer } from './file-indexer.js';
import { i2pConnection } from './i2p-connection.js';
import { i2pdManager } from './i2pd-manager.js';
import { EmbeddedTracker, getEmbeddedTracker } from './torrent/embedded-tracker.js';
import { getTorrentManager, TorrentManager } from './torrent/torrent-manager.js';
import { trackerClient, DEFAULT_TRACKERS } from './tracker-client.js';

// Get electron from global (set by bootstrap.cjs)
const electron = (globalThis as any).__electron;
const { app, BrowserWindow, dialog, ipcMain, shell } = electron;

// Configuration store
const store = new Store({
  defaults: {
    displayName: 'I2P Share User', // User's display name visible to other peers
  }
});

let mainWindow: BrowserWindowType | null = null;
let connectionStatus: string = 'disconnected';
let connectionError: string = '';
let downloadProgress: number = 0;

// Torrent system
let torrentManager: TorrentManager | null = null;
let embeddedTracker: EmbeddedTracker | null = null;
const fileIndexer = new FileIndexer();

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
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false
    }
  });

  // Load the app - use Vite dev server in development, built files in production
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Auto-seed new files as torrents
 * This creates torrents for shared files that don't have an infoHash yet,
 * enabling BitTorrent-based downloads for files found via DHT search.
 */
async function autoSeedNewFiles(): Promise<void> {
  if (!torrentManager) {
    console.log('[AutoSeed] TorrentManager not available');
    return;
  }

  // Get files that need to be seeded (no infoHash yet)
  const filesToSeed = FileOps.getWithoutInfoHash() as any[];

  if (filesToSeed.length === 0) {
    console.log('[AutoSeed] All files already seeded');
    return;
  }

  console.log(`[AutoSeed] Seeding ${filesToSeed.length} new files as torrents...`);

  let seeded = 0;
  let failed = 0;

  for (const file of filesToSeed) {
    try {
      // Check if file still exists
      const fs = await import('fs');
      if (!fs.existsSync(file.path)) {
        console.log(`[AutoSeed] File not found, skipping: ${file.filename}`);
        continue;
      }

      // Create torrent for the file
      const result = await torrentManager.createTorrent(file.path, {
        name: file.filename
      });

      if (result.infoHash) {
        // Store the infoHash in the database
        FileOps.setInfoHash(file.hash, result.infoHash);
        seeded++;
        console.log(`[AutoSeed] Seeded: ${file.filename} → ${result.infoHash.substring(0, 16)}...`);
      }
    } catch (error: any) {
      failed++;
      console.error(`[AutoSeed] Failed to seed ${file.filename}:`, error.message);
    }
  }

  console.log(`[AutoSeed] Complete: ${seeded} seeded, ${failed} failed`);
}

function setupIPC(): void {
  // Search - uses DHT for distributed search
  ipcMain.handle('search:query', async (_event, query: string, filters: SearchFilters) => {
    console.log('[IPC] Search:', query, filters);

    // First search local files (include infoHash for torrent-based downloads)
    const localResults = fileIndexer.searchFiles(query).map((f: any) => {
      // Get the full file record to get the infoHash
      const fileWithInfoHash = FileOps.getWithInfoHash(f.hash);
      return {
        filename: f.filename,
        fileHash: f.hash,
        infoHash: fileWithInfoHash?.infoHash || null, // Include torrent infoHash if available
        size: f.size,
        mimeType: f.mimeType,
        peerId: 'local',
        peerDisplayName: 'Me (Local)',
        addedAt: f.sharedAt
      };
    });

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

    // Deduplicate by fileHash (prefer local > DHT)
    const seen = new Set<string>();
    const results: SearchResult[] = [];

    for (const r of localResults) {
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

    console.log(`[IPC] Search results: ${localResults.length} local, ${dhtResults.length} DHT`);
    return results;
  });

  // Downloads - use TorrentManager for BitTorrent-based transfers
  ipcMain.handle('download:start', async (_event, fileHash: string, peerId: string, filename: string, size: number, peerName: string, streamingDest?: string, providedInfoHash?: string) => {
    if (!i2pConnection.isReady()) {
      throw new Error('Not connected to I2P network');
    }

    if (!torrentManager) {
      throw new Error('TorrentManager not initialized');
    }

    // Determine the infoHash to use
    let infoHash: string | null = null;

    // 1. If infoHash was provided directly, use it
    if (providedInfoHash && providedInfoHash.length === 40 && /^[0-9a-fA-F]+$/.test(providedInfoHash)) {
      infoHash = providedInfoHash;
      console.log(`[Download] Using provided infoHash: ${infoHash.substring(0, 16)}...`);
    }
    // 2. If fileHash looks like an infoHash (40 hex chars), use it directly
    else if (fileHash.length === 40 && /^[0-9a-fA-F]+$/.test(fileHash)) {
      infoHash = fileHash;
      console.log(`[Download] fileHash is infoHash format: ${infoHash.substring(0, 16)}...`);
    }
    // 3. Otherwise, look up the infoHash from database (fileHash -> infoHash mapping)
    else {
      const fileRecord = FileOps.getWithInfoHash(fileHash);
      if (fileRecord?.infoHash) {
        infoHash = fileRecord.infoHash;
        console.log(`[Download] Found infoHash from database: ${infoHash.substring(0, 16)}...`);
      }
    }

    if (!infoHash) {
      throw new Error('This file is not available for download. The peer needs to seed it as a torrent first.');
    }

    // Add peer to the torrent swarm
    const targetDest = streamingDest || peerId;
    if (targetDest && targetDest !== 'local') {
      const added = await torrentManager.addPeer(infoHash, targetDest);
      if (added) {
        console.log(`[Download] Added peer to torrent swarm: ${targetDest.substring(0, 20)}...`);
      }
    }

    // Start or resume the torrent download via magnet link
    // First check if torrent already exists
    const existingTorrent = torrentManager.getStatus(infoHash);
    if (existingTorrent) {
      // Torrent exists, resume it
      await torrentManager.resumeTorrent(infoHash);
    } else {
      // Create magnet link and add torrent
      const magnetUri = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(filename)}`;
      await torrentManager.addMagnet(magnetUri);
    }

    return { infoHash, name: filename };
  });

  ipcMain.handle('download:pause', async (_event, downloadId: string) => {
    if (torrentManager) {
      await torrentManager.pauseTorrent(downloadId);
    }
  });

  ipcMain.handle('download:resume', async (_event, downloadId: string) => {
    if (torrentManager) {
      await torrentManager.resumeTorrent(downloadId);
    }
  });

  ipcMain.handle('download:cancel', async (_event, downloadId: string) => {
    if (torrentManager) {
      await torrentManager.removeTorrent(downloadId, false);
    }
  });

  ipcMain.handle('download:list', async () => {
    if (!torrentManager) return [];
    return torrentManager.listTorrents();
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

  // Torrent operations
  ipcMain.handle('torrent:add', async (_event, torrentData: Buffer) => {
    if (!torrentManager) {
      throw new Error('Torrent manager not initialized');
    }
    return torrentManager.addTorrent(torrentData);
  });

  ipcMain.handle('torrent:addMagnet', async (_event, magnetUri: string) => {
    if (!torrentManager) {
      throw new Error('Torrent manager not initialized');
    }
    return torrentManager.addMagnet(magnetUri);
  });

  ipcMain.handle('torrent:create', async (_event, filePath: string, options?: { name?: string; trackers?: string[] }) => {
    if (!torrentManager) {
      throw new Error('Torrent manager not initialized');
    }
    return torrentManager.createTorrent(filePath, options);
  });

  ipcMain.handle('torrent:status', async (_event, infoHash: string) => {
    if (!torrentManager) return null;
    return torrentManager.getStatus(infoHash);
  });

  ipcMain.handle('torrent:list', async () => {
    if (!torrentManager) return [];
    return torrentManager.listTorrents();
  });

  ipcMain.handle('torrent:remove', async (_event, infoHash: string, deleteFiles?: boolean) => {
    if (!torrentManager) {
      throw new Error('Torrent manager not initialized');
    }
    await torrentManager.removeTorrent(infoHash, deleteFiles || false);
    return { success: true };
  });

  ipcMain.handle('torrent:pause', async (_event, infoHash: string) => {
    if (!torrentManager) {
      throw new Error('Torrent manager not initialized');
    }
    await torrentManager.pauseTorrent(infoHash);
    return { success: true };
  });

  ipcMain.handle('torrent:resume', async (_event, infoHash: string) => {
    if (!torrentManager) {
      throw new Error('Torrent manager not initialized');
    }
    await torrentManager.resumeTorrent(infoHash);
    return { success: true };
  });

  ipcMain.handle('torrent:addPeer', async (_event, infoHash: string, destination: string) => {
    if (!torrentManager) return false;
    return torrentManager.addPeer(infoHash, destination);
  });

  ipcMain.handle('torrent:globalStats', async () => {
    if (!torrentManager) {
      return { totalDownloadSpeed: 0, totalUploadSpeed: 0, activeTorrents: 0, totalPeers: 0 };
    }
    return torrentManager.getGlobalStats();
  });

  // Add torrent file via dialog
  ipcMain.handle('torrent:addFile', async () => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ['openFile'],
      filters: [{ name: 'Torrent Files', extensions: ['torrent'] }]
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const fs = await import('fs');
      const torrentData = fs.readFileSync(result.filePaths[0]);
      if (!torrentManager) {
        throw new Error('Torrent manager not initialized');
      }
      return torrentManager.addTorrent(torrentData);
    }
    return null;
  });

  // Network
  ipcMain.handle('network:status', async () => {
    const dhtStats = dhtSearch.getStats();
    const i2pState = i2pConnection.getState();

    // Get torrent stats
    const torrentStats = torrentManager?.getGlobalStats() || {
      totalDownloadSpeed: 0,
      totalUploadSpeed: 0,
      activeTorrents: 0,
      totalPeers: 0
    };

    // Get peer counts from database (2 minute threshold for "online", aligned with tracker timeout)
    const peerCounts = PeerOps.getCounts(120);

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

    // Get real tunnel count from i2pd (or default to 0)
    const activeTunnels = i2pState.isConnected ? await i2pdManager.getActiveTunnelCount() : 0;

    return {
      isConnected: connectionStatus === 'connected',
      activeTunnels,
      // Peer counts: online = seen in last 5 mins, total = all discovered peers
      peersConnected: peerCounts.online,      // Online peers (seen recently)
      peersOnline: peerCounts.online,         // Same, explicit name
      peersOffline: peerCounts.offline,       // Offline peers (not seen recently)
      peersTotal: peerCounts.total,           // Total discovered peers
      uploadSpeed: torrentStats.totalUploadSpeed,
      downloadSpeed: torrentStats.totalDownloadSpeed,
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

        // Initialize TorrentManager for BitTorrent transfers
        console.log('[Main] Initializing TorrentManager...');
        try {
          torrentManager = getTorrentManager();
          await torrentManager.initialize();

          // Configure with our destination and DHT
          torrentManager.setLocalDestination(result.destination);
          torrentManager.setDHTEngine(dhtSearch);

          console.log('[Main] TorrentManager initialized');

          // Set up torrent event forwarding
          setupTorrentEvents();
        } catch (err: any) {
          console.error('[Main] Failed to initialize TorrentManager:', err.message);
        }

        // Initialize embedded tracker if enabled
        console.log('[Main] Initializing EmbeddedTracker...');
        try {
          embeddedTracker = getEmbeddedTracker({ enabled: true });
          embeddedTracker.setDHTEngine(dhtSearch);
          await embeddedTracker.start();

          // If embedded tracker started, add it to our trackers
          const destinations = embeddedTracker.getDestinations();
          if (destinations.peerDiscovery && torrentManager) {
            torrentManager.addTracker(destinations.peerDiscovery);
            console.log('[Main] Added embedded tracker to multi-tracker');
          }
        } catch (err: any) {
          console.error('[Main] Failed to start EmbeddedTracker:', err.message);
        }

        // Announce ourselves and our torrents to DHT
        const activeTorrents = TorrentOps.getActive();
        for (const t of activeTorrents) {
            dhtSearch.announcePeer(t.infoHash);
        }

        mainWindow?.webContents.send('network:connected', { address: result.b32Address });
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

  // User profile settings
  ipcMain.handle('profile:get-display-name', async () => {
    return store.get('displayName', 'I2P Share User');
  });

  ipcMain.handle('profile:set-display-name', async (_event, name: string) => {
    const displayName = name.trim() || 'I2P Share User';
    store.set('displayName', displayName);
    // Update DHT with new display name
    if (i2pConnection.isReady()) {
      dhtSearch.setIdentity(i2pConnection.getState().destination, displayName);
    }
    return { success: true };
  });

  // ==================== PEERS ====================
  ipcMain.handle('peers:list', async () => {
    const peers = PeerOps.getAll() as any[];
    const now = Math.floor(Date.now() / 1000);
    const onlineThreshold = 120; // 2 minutes (aligned with tracker's 90s timeout + buffer)

    // Add isOnline status based on lastSeen
    return peers.map(peer => ({
      ...peer,
      isOnline: peer.lastSeen && (now - peer.lastSeen) < onlineThreshold
    }));
  });

  ipcMain.handle('peers:get-files', async (_event, peerId: string) => {
    // Get files shared by a specific peer from database
    return RemoteFileOps.getByPeer(peerId);
  });

  ipcMain.handle('peers:request-files', async (_event, peerId: string) => {
    // Request file list from a peer via DHT search
    if (!i2pConnection.isReady()) {
      return { success: false, error: 'Not connected to I2P' };
    }
    try {
      // Trigger a search to refresh peer data from the network
      await dhtSearch.search('*', {}, 5000);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('remote-files:all', async () => {
    // Get all files from all known remote peers from database
    return RemoteFileOps.getAll();
  });

  // ==================== TRACKER ====================
  ipcMain.handle('tracker:get-addresses', async () => {
    return store.get('trackerAddresses', []) as string[];
  });

  ipcMain.handle('tracker:set-addresses', async (_event, addresses: string[]) => {
    store.set('trackerAddresses', addresses);

    // Update torrent manager with new trackers
    if (torrentManager) {
      for (const addr of addresses) {
        torrentManager.addTracker(addr);
      }
    }

    // Update TrackerClient and connect to new trackers
    if (addresses.length > 0 && i2pConnection.isReady()) {
      console.log(`[Main] Updating TrackerClient with ${addresses.length} tracker(s)...`);

      // Add new addresses to TrackerClient
      for (const addr of addresses) {
        trackerClient.addTrackerAddress(addr);
        knownTrackerDestinations.add(addr);
      }

      // Connect/reconnect to trackers
      try {
        await trackerClient.connect();
        console.log('[Main] TrackerClient connected to new tracker(s)');

        // Announce the tracker to DHT
        const activeTracker = trackerClient.getActiveTracker();
        if (activeTracker) {
          announceTrackerToDHT(activeTracker);
        }
      } catch (err: any) {
        console.error('[Main] TrackerClient connection failed:', err.message);
      }
    }

    return { success: true };
  });

  ipcMain.handle('tracker:get-active', async () => {
    // Return tracker status with actual connection state
    const addresses = store.get('trackerAddresses', []) as string[];
    const activeTracker = trackerClient.getActiveTracker();
    const isConnected = trackerClient.isTrackerConnected();
    const peersFromTracker = trackerClient.getPeersCount();

    return {
      address: activeTracker || (addresses.length > 0 ? addresses[0] : null),
      isConnected: isConnected,
      peersCount: peersFromTracker,
      configuredCount: addresses.length,
      hasEmbeddedTracker: !!embeddedTracker
    };
  });

  ipcMain.handle('tracker:get-peers', async () => {
    // Get peers from database
    return PeerOps.getAll();
  });

  ipcMain.handle('tracker:refresh', async () => {
    // Trigger a DHT refresh/bootstrap
    if (!i2pConnection.isReady()) {
      return { success: false, error: 'Not connected to I2P' };
    }
    try {
      // Get known nodes from routing table and bootstrap
      const nodes = RoutingOps.getClosest('', 20) as any[];
      const bootstrapNodes = nodes.map(n => ({
        nodeId: n.nodeId,
        destination: n.destination
      }));
      await dhtSearch.bootstrap(bootstrapNodes);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  });

  // Legacy single address (backwards compat)
  ipcMain.handle('tracker:get-address', async () => {
    const addresses = store.get('trackerAddresses', []) as string[];
    return addresses[0] || '';
  });

  ipcMain.handle('tracker:set-address', async (_event, address: string) => {
    const addresses = address ? [address] : [];
    store.set('trackerAddresses', addresses);
    if (torrentManager && address) {
      torrentManager.addTracker(address);
    }
    return { success: true };
  });

  // ==================== EMBEDDED TRACKER ====================
  ipcMain.handle('embedded-tracker:get-enabled', async () => {
    return store.get('embeddedTrackerEnabled', true) as boolean;
  });

  ipcMain.handle('embedded-tracker:set-enabled', async (_event, enabled: boolean) => {
    store.set('embeddedTrackerEnabled', enabled);
    if (enabled && !embeddedTracker) {
      // Start embedded tracker
      try {
        embeddedTracker = getEmbeddedTracker({ enabled: true });
        embeddedTracker.setDHTEngine(dhtSearch);
        await embeddedTracker.start();
      } catch (err: any) {
        console.error('[Main] Failed to start EmbeddedTracker:', err.message);
        return { success: false, error: err.message };
      }
    } else if (!enabled && embeddedTracker) {
      // Stop embedded tracker
      await embeddedTracker.cleanup();
      embeddedTracker = null;
    }
    return { success: true };
  });

  ipcMain.handle('embedded-tracker:get-status', async () => {
    if (!embeddedTracker) {
      return {
        isRunning: false,
        b32Address: null,
        btTrackerB32: null,
        destination: null,
        peersCount: 0,
        torrentsCount: 0,
        uptime: 0
      };
    }
    const stats = embeddedTracker.getStats();
    const destinations = embeddedTracker.getDestinations();
    return {
      isRunning: stats.isRunning,
      b32Address: destinations.peerDiscoveryB32 || null,
      btTrackerB32: destinations.btTrackerB32 || null,
      destination: destinations.peerDiscovery || null,
      peersCount: stats.peersCount || 0,
      torrentsCount: stats.torrentsCount || 0,
      uptime: stats.uptime || 0
    };
  });

  // ==================== UPLOADS ====================
  ipcMain.handle('uploads:active', async () => {
    if (!torrentManager) return [];
    // Return torrents that are seeding (complete and uploading)
    const torrents = torrentManager.listTorrents();
    return torrents.filter((t: any) => t.progress === 1 && t.uploadSpeed > 0);
  });
}

/**
 * Set up TorrentManager event forwarding to renderer
 */
function setupTorrentEvents(): void {
  if (!torrentManager) return;

  torrentManager.on('torrent-added', (infoHash, name) => {
    console.log(`[Main] Torrent added: ${name} (${infoHash.substring(0, 16)}...)`);
    mainWindow?.webContents.send('torrent:added', { infoHash, name });
  });

  torrentManager.on('torrent-removed', (infoHash) => {
    console.log(`[Main] Torrent removed: ${infoHash.substring(0, 16)}...`);
    mainWindow?.webContents.send('torrent:removed', { infoHash });
  });

  torrentManager.on('torrent-started', (infoHash) => {
    mainWindow?.webContents.send('torrent:started', { infoHash });
  });

  torrentManager.on('torrent-stopped', (infoHash) => {
    mainWindow?.webContents.send('torrent:stopped', { infoHash });
  });

  torrentManager.on('torrent-complete', (infoHash) => {
    console.log(`[Main] Torrent complete: ${infoHash.substring(0, 16)}...`);
    mainWindow?.webContents.send('torrent:complete', { infoHash });
    // Also send as download:completed for compatibility
    mainWindow?.webContents.send('download:completed', { infoHash });
  });

  torrentManager.on('torrent-error', (infoHash, error) => {
    console.error(`[Main] Torrent error (${infoHash.substring(0, 16)}...):`, error.message);
    mainWindow?.webContents.send('torrent:error', { infoHash, error: error.message });
  });

  torrentManager.on('progress', (infoHash, progress) => {
    mainWindow?.webContents.send('torrent:progress', { infoHash, progress });
    // Also send as download:progress for compatibility
    mainWindow?.webContents.send('download:progress', { infoHash, progress });
  });

  torrentManager.on('stats', (stats) => {
    mainWindow?.webContents.send('torrent:stats', stats);
  });
}

function setupEventForwarding(): void {
  // Forward file indexer events
  fileIndexer.on('scan:start', (data) => {
    mainWindow?.webContents.send('scan:start', data);
  });

  fileIndexer.on('scan:progress', (data) => {
    mainWindow?.webContents.send('scan:progress', data);
  });

  fileIndexer.on('scan:complete', (data) => {
    mainWindow?.webContents.send('scan:complete', data);

    // Re-announce files when scan completes
    if (i2pConnection.isReady()) {
      const files = fileIndexer.getAllFiles();
      dhtSearch.announceFiles(files);

      // Update TrackerClient stats and re-announce to tracker
      const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
      trackerClient.updateStats(files.length, totalSize);
      trackerClient.announce().catch(err => {
        console.log('[Main] Re-announce after scan:', err.message);
      });
      console.log(`[Main] Updated tracker stats: ${files.length} files, ${totalSize} bytes`);

      // Also update embedded tracker's local peer entry
      if (embeddedTracker) {
        embeddedTracker.registerLocalPeer({
          destination: i2pConnection.getDestination(),
          b32Address: i2pConnection.getB32Address(),
          displayName: store.get('displayName', 'I2P Share User') as string,
          filesCount: files.length,
          totalSize: totalSize,
          nodeId: dhtSearch.getNodeId()
        });
      }

      // Auto-seed files as torrents (in background)
      if (torrentManager) {
        autoSeedNewFiles().catch(err => {
          console.error('[Main] Auto-seed error:', err.message);
        });
      }
    }
  });

  // Note: Torrent events are set up in setupTorrentEvents() after TorrentManager initialization

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
    // Log ALL incoming messages for debugging
    // Route to DHT handler
    if (dhtSearch) {
        dhtSearch.handleMessage(from, message);
    }
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

// Track known trackers to avoid duplicate connections
const knownTrackerDestinations = new Set<string>();
let trackerDiscoveryInterval: NodeJS.Timeout | null = null;

/**
 * Bootstrap DHT via tracker for initial peer discovery.
 * This enables new clients to discover peers even with an empty DHT.
 * Also sets up automatic tracker discovery and propagation.
 */
async function bootstrapDHTViaTracker(destination: string, displayName: string): Promise<void> {
  // Get configured trackers (from settings or defaults)
  const configuredTrackers = store.get('trackerAddresses', []) as string[];
  const allTrackers = [...configuredTrackers, ...DEFAULT_TRACKERS].filter(t => t && t.trim().length > 0);

  // Add configured trackers to known set
  for (const tracker of allTrackers) {
    knownTrackerDestinations.add(tracker);
  }

  // Configure TrackerClient
  trackerClient.setIdentity(destination, displayName);
  trackerClient.setNodeId(dhtSearch.getNodeId());
  trackerClient.setMessageHandler(async (dest, msg) => {
    return i2pConnection.sendMessage(dest, msg);
  });

  // Listen for DHT nodes from tracker
  trackerClient.on('dht:nodes', async (nodes: { nodeId: string; destination: string }[]) => {
    console.log(`[Main] Received ${nodes.length} DHT nodes from tracker for bootstrap`);

    // Filter valid nodes and bootstrap DHT
    const validNodes = nodes.filter(n => n.destination && n.destination.length > 50);

    if (validNodes.length > 0) {
      try {
        await dhtSearch.bootstrap(validNodes);
        console.log(`[Main] DHT bootstrapped with ${validNodes.length} nodes from tracker`);
      } catch (err: any) {
        console.error('[Main] DHT bootstrap failed:', err.message);
      }
    }
  });

  // Listen for peers discovered (they can also be used for DHT)
  trackerClient.on('peers:updated', (peers: any[]) => {
    console.log(`[Main] Tracker discovered ${peers.length} peers`);

    // Save all peers to database and notify UI
    const now = Math.floor(Date.now() / 1000);
    for (const peer of peers) {
      if (peer.destination || peer.b32Address) {
        PeerOps.upsert({
          peerId: peer.b32Address || peer.destination,
          displayName: peer.displayName || 'Unknown',
          filesCount: peer.filesCount || 0,
          totalSize: peer.totalSize || 0
        });
      }
    }

    // Notify renderer that peers list has been updated
    mainWindow?.webContents.send('peers:updated', { count: peers.length });

    // Peers can be used as DHT nodes too
    const peerNodes = peers
      .filter(p => p.destination && p.destination.length > 50)
      .map(p => ({ nodeId: '', destination: p.destination }));

    if (peerNodes.length > 0) {
      dhtSearch.bootstrap(peerNodes).catch(err => {
        console.log('[Main] Peer-based DHT bootstrap:', err.message);
      });
    }
  });

  // Listen for real-time peer online notifications
  trackerClient.on('peer:online', (peer: any) => {
    console.log(`[Main] Peer came online: ${peer.displayName || peer.b32Address?.substring(0, 16)}...`);

    // Update peer in database with current timestamp
    const now = Math.floor(Date.now() / 1000);
    PeerOps.upsert({
      peerId: peer.destination || peer.b32Address,
      displayName: peer.displayName || 'Unknown',
      filesCount: peer.filesCount || 0,
      totalSize: peer.totalSize || 0,
      lastSeen: now,
      isOnline: true
    });

    // Send real-time update to renderer
    mainWindow?.webContents.send('peer:online', {
      peerId: peer.destination || peer.b32Address,
      b32Address: peer.b32Address,
      displayName: peer.displayName || 'Unknown',
      filesCount: peer.filesCount || 0,
      totalSize: peer.totalSize || 0,
      streamingDestination: peer.streamingDestination
    });
  });

  // Listen for real-time peer offline notifications
  trackerClient.on('peer:offline', (peer: any) => {
    console.log(`[Main] Peer went offline: ${peer.displayName || peer.b32Address?.substring(0, 16)}...`);

    // Update peer in database - mark as offline by setting lastSeen to a past timestamp
    // This ensures getCounts() properly categorizes them as offline
    const offlineTimestamp = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago
    PeerOps.updateLastSeen(peer.destination || peer.b32Address, offlineTimestamp);

    // Send real-time update to renderer
    mainWindow?.webContents.send('peer:offline', {
      peerId: peer.destination || peer.b32Address,
      b32Address: peer.b32Address,
      displayName: peer.displayName || 'Unknown'
    });
  });

  // Handle incoming messages for TrackerClient
  i2pConnection.on('message', ({ from, message }: { from: string; message: any }) => {
    // Try TrackerClient first
    if (trackerClient.handleMessage(from, message)) {
      return; // Handled by TrackerClient
    }
    // Otherwise it's a DHT message (already handled by DHT)
  });

  // Connect to configured trackers
  if (allTrackers.length > 0) {
    console.log(`[Main] Bootstrapping DHT via ${allTrackers.length} tracker(s)...`);
    trackerClient.setTrackerAddresses(allTrackers);

    try {
      await trackerClient.connect();
      console.log('[Main] TrackerClient connected - waiting for DHT nodes...');

      // Announce the tracker to DHT so others can discover it
      const activeTracker = trackerClient.getActiveTracker();
      if (activeTracker) {
        announceTrackerToDHT(activeTracker);
      }
    } catch (err: any) {
      console.error('[Main] TrackerClient connection failed:', err.message);
    }
  } else {
    console.log('[Main] No bootstrap trackers configured - will discover via DHT');
  }

  // Start periodic tracker discovery via DHT (every 5 minutes)
  startTrackerDiscovery();
}

/**
 * Announce a tracker to the DHT so other peers can discover it
 */
async function announceTrackerToDHT(trackerDestination: string): Promise<void> {
  try {
    console.log(`[Main] Announcing tracker to DHT for network resilience...`);
    await dhtSearch.announceTracker(trackerDestination);
    console.log(`[Main] Tracker announced to DHT successfully`);
  } catch (err: any) {
    console.error('[Main] Failed to announce tracker to DHT:', err.message);
  }
}

/**
 * Start periodic tracker discovery via DHT
 * This enables automatic network healing when trackers go down
 */
function startTrackerDiscovery(): void {
  if (trackerDiscoveryInterval) {
    clearInterval(trackerDiscoveryInterval);
  }

  // Discover trackers every 5 minutes
  const DISCOVERY_INTERVAL = 5 * 60 * 1000;

  // Initial discovery after 30 seconds (give DHT time to bootstrap)
  setTimeout(() => {
    discoverAndConnectTrackers();
  }, 30000);

  // Periodic discovery
  trackerDiscoveryInterval = setInterval(() => {
    discoverAndConnectTrackers();
  }, DISCOVERY_INTERVAL);

  console.log('[Main] Tracker discovery started (every 5 minutes)');
}

/**
 * Discover trackers via DHT and auto-connect to new ones
 */
async function discoverAndConnectTrackers(): Promise<void> {
  try {
    console.log('[Main] Discovering trackers via DHT...');
    const discoveredTrackers = await dhtSearch.discoverTrackers(15000);

    if (discoveredTrackers.length === 0) {
      console.log('[Main] No new trackers discovered via DHT');
      return;
    }

    // Filter out already known trackers
    const newTrackers = discoveredTrackers.filter(t => !knownTrackerDestinations.has(t));

    if (newTrackers.length === 0) {
      console.log(`[Main] All ${discoveredTrackers.length} discovered trackers are already known`);
      return;
    }

    console.log(`[Main] Found ${newTrackers.length} new tracker(s) via DHT!`);

    // Add new trackers
    for (const tracker of newTrackers) {
      knownTrackerDestinations.add(tracker);
      trackerClient.addTrackerAddress(tracker);
      console.log(`[Main] Added new tracker: ${tracker.substring(0, 30)}...`);

      // Also add to TorrentManager if available
      if (torrentManager) {
        torrentManager.addTracker(tracker);
      }
    }

    // Re-announce to spread tracker info further
    for (const tracker of newTrackers) {
      announceTrackerToDHT(tracker).catch(() => {});
    }

    // Notify UI
    mainWindow?.webContents.send('trackers:discovered', {
      count: newTrackers.length,
      total: knownTrackerDestinations.size
    });
  } catch (err: any) {
    console.error('[Main] Tracker discovery failed:', err.message);
  }
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
      const storedDisplayName = store.get('displayName', 'I2P Share User') as string;
      dhtSearch.setIdentity(result.destination, storedDisplayName);
      dhtSearch.setMessageHandler(async (dest, message) => {
        await i2pConnection.sendMessage(dest, message);
      });

      // Bootstrap DHT via tracker if we have few nodes
      await bootstrapDHTViaTracker(result.destination, storedDisplayName);

      // Initialize TorrentManager for BitTorrent transfers
      console.log('[Main] Initializing TorrentManager...');
      try {
        torrentManager = getTorrentManager();
        await torrentManager.initialize();

        // Configure multi-tracker with our destination and DHT
        torrentManager.setLocalDestination(result.destination);
        torrentManager.setDHTEngine(dhtSearch);

        console.log('[Main] TorrentManager initialized');

        // Set up torrent event forwarding
        setupTorrentEvents();
      } catch (err: any) {
        console.error('[Main] Failed to initialize TorrentManager:', err.message);
      }

      // Initialize embedded tracker if enabled
      console.log('[Main] Initializing EmbeddedTracker...');
      try {
        embeddedTracker = getEmbeddedTracker({ enabled: true });
        embeddedTracker.setDHTEngine(dhtSearch);
        await embeddedTracker.start();

        // If embedded tracker started, add it to our trackers and announce to DHT
        const destinations = embeddedTracker.getDestinations();
        if (destinations.peerDiscovery) {
          // Add to local tracker list
          if (torrentManager) {
            torrentManager.addTracker(destinations.peerDiscovery);
            console.log('[Main] Added embedded tracker to multi-tracker');
          }

          // Add to known trackers
          knownTrackerDestinations.add(destinations.peerDiscovery);

          // Register ourselves as a peer in our own tracker
          // This way when other peers connect, they can discover us
          const storedDisplayName = store.get('displayName', 'I2P Share User') as string;
          embeddedTracker.registerLocalPeer({
            destination: result.destination,
            b32Address: result.b32Address,
            displayName: storedDisplayName,
            filesCount: 0, // Will be updated later
            totalSize: 0,
            nodeId: dhtSearch.getNodeId()
          });
          console.log('[Main] Registered local host in embedded tracker');

          // IMPORTANT: Also connect TrackerClient to our own embedded tracker
          // This way we receive peer updates when others connect to our tracker
          trackerClient.addTrackerAddress(destinations.peerDiscovery);
          console.log('[Main] Added embedded tracker to TrackerClient');

          // Connect/reconnect to include the embedded tracker
          trackerClient.connect().then(() => {
            console.log('[Main] TrackerClient connected (includes embedded tracker)');
          }).catch(err => {
            console.log('[Main] TrackerClient connect:', err.message);
          });

          // Announce embedded tracker to DHT for network-wide discovery
          // This allows other peers to find our tracker automatically
          console.log('[Main] Announcing embedded tracker to DHT...');
          announceTrackerToDHT(destinations.peerDiscovery).catch(err => {
            console.log('[Main] Embedded tracker DHT announcement:', err.message);
          });
        }

        // Listen for peer events from embedded tracker (local notifications)
        // This handles peers connecting to our tracker without going through I2P
        embeddedTracker.on('peer:connected', (peer: any) => {
          console.log(`[Main] Embedded tracker: peer connected - ${peer.displayName || peer.b32Address?.substring(0, 16)}`);

          // Save to database
          const now = Math.floor(Date.now() / 1000);
          PeerOps.upsert({
            peerId: peer.b32Address || peer.destination,
            displayName: peer.displayName || 'Unknown',
            filesCount: peer.filesCount || 0,
            totalSize: peer.totalSize || 0
          });

          // Notify UI
          mainWindow?.webContents.send('peer:online', {
            peerId: peer.b32Address || peer.destination,
            b32Address: peer.b32Address,
            displayName: peer.displayName || 'Unknown',
            filesCount: peer.filesCount || 0,
            totalSize: peer.totalSize || 0,
            streamingDestination: peer.streamingDestination
          });

          // Also trigger a peers refresh
          mainWindow?.webContents.send('peers:updated', { count: 1 });
        });

        embeddedTracker.on('peer:updated', (peer: any) => {
          // Update peer in database
          PeerOps.upsert({
            peerId: peer.b32Address || peer.destination,
            displayName: peer.displayName || 'Unknown',
            filesCount: peer.filesCount || 0,
            totalSize: peer.totalSize || 0
          });
        });

        // Periodically sync peers from embedded tracker to application database
        // This ensures the UI shows peers connected to our tracker
        const syncTrackerPeers = () => {
          if (!embeddedTracker) return;

          const trackerPeers = embeddedTracker.getActivePeers();
          const myB32 = result.b32Address;

          for (const peer of trackerPeers) {
            // Skip ourselves
            if (peer.b32Address === myB32) continue;

            // Save to application database
            PeerOps.upsert({
              peerId: peer.b32Address || peer.destination,
              displayName: peer.displayName || 'Unknown',
              filesCount: peer.filesCount || 0,
              totalSize: peer.totalSize || 0
            });
          }

          if (trackerPeers.length > 1) { // More than just ourselves
            console.log(`[Main] Synced ${trackerPeers.length - 1} peer(s) from embedded tracker`);
            mainWindow?.webContents.send('peers:updated', { count: trackerPeers.length - 1 });
          }
        };

        // Periodically refresh local peer entry to prevent it from becoming stale
        const refreshLocalPeer = () => {
          if (!embeddedTracker || !i2pConnection.isReady()) return;

          const files = fileIndexer.getAllFiles();
          const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
          const storedDisplayName = store.get('displayName', 'I2P Share User') as string;

          embeddedTracker.registerLocalPeer({
            destination: result.destination,
            b32Address: result.b32Address,
            displayName: storedDisplayName,
            filesCount: files.length,
            totalSize: totalSize,
            nodeId: dhtSearch.getNodeId()
          });
        };

        // Sync immediately and then every 10 seconds
        syncTrackerPeers();
        setInterval(syncTrackerPeers, 10000);

        // Refresh local peer every 30 seconds to keep it active
        setInterval(refreshLocalPeer, 30000);

      } catch (err: any) {
        console.error('[Main] Failed to start EmbeddedTracker:', err.message);
      }

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

  i2pConnection.on('status', (status) => {
    connectionStatus = status;
    let statusText = status;

    // Improved UX messages for I2P latency
    switch (status) {
      case 'starting': statusText = 'Starting I2P Node...'; break;
      case 'connecting': statusText = 'Building Tunnels (may take 1-3 mins)...'; break;
      case 'connected': statusText = 'I2P Network Connected'; break;
      case 'error': statusText = 'Connection Error'; break;
    }

    mainWindow?.webContents.send('network:status-change', {
      status: connectionStatus,
      text: statusText,
      error: connectionError
    });
  });
}

app.whenReady().then(async () => {
  console.log('[Main] Starting I2P Share...');

  // Initialize database
  initDatabase();
  console.log('[Main] Database initialized');

  // Load saved data
  dhtSearch.loadFromDatabase();
  // Note: TorrentManager.initialize() loads torrents from database when I2P connects

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

  // Stop tracker discovery
  if (trackerDiscoveryInterval) {
    clearInterval(trackerDiscoveryInterval);
    trackerDiscoveryInterval = null;
  }

  // Disconnect tracker client
  await trackerClient.disconnect();

  // Shutdown TorrentManager
  if (torrentManager) {
    await torrentManager.shutdown();
  }

  // Shutdown EmbeddedTracker
  if (embeddedTracker) {
    await embeddedTracker.cleanup();
  }

  // Disconnect from I2P (but keep i2pd running)
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
