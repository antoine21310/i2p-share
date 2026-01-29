import Database from 'better-sqlite3';
import fs from 'fs';

// Get electron from global (set by bootstrap.cjs)
const electron = (globalThis as any).__electron;
const { app } = electron;
import path from 'path';

let db: Database.Database | null = null;

/** Database schema version for migrations */
const SCHEMA_VERSION = 2;

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDatabase first.');
  }
  return db;
}

export function initDatabase(): Database.Database {
  const userDataPath = app?.getPath('userData') || process.cwd();
  const dbPath = path.join(userDataPath, 'i2pshare.db');

  // Ensure directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  const schema = `
    -- Local files that are shared
    CREATE TABLE IF NOT EXISTS local_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      filename TEXT NOT NULL,
      hash TEXT UNIQUE NOT NULL,
      size INTEGER NOT NULL,
      mimeType TEXT,
      modifiedAt INTEGER,
      sharedAt INTEGER DEFAULT (strftime('%s', 'now')),
      isShared INTEGER DEFAULT 1,
      createdAt INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_files_hash ON local_files(hash);
    CREATE INDEX IF NOT EXISTS idx_files_shared ON local_files(isShared);
    CREATE INDEX IF NOT EXISTS idx_files_filename ON local_files(filename);

    -- DHT cache for network data
    CREATE TABLE IF NOT EXISTS dht_cache (
      key TEXT PRIMARY KEY,
      value TEXT,
      expiresAt INTEGER,
      lastUpdated INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_dht_expires ON dht_cache(expiresAt);

    -- Downloads tracking
    CREATE TABLE IF NOT EXISTS downloads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      fileHash TEXT NOT NULL,
      peerId TEXT NOT NULL,
      peerName TEXT,
      totalSize INTEGER NOT NULL,
      downloadedSize INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      createdAt INTEGER DEFAULT (strftime('%s', 'now')),
      startedAt INTEGER,
      completedAt INTEGER,
      chunkMap TEXT,
      savePath TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_downloads_status ON downloads(status);
    CREATE INDEX IF NOT EXISTS idx_downloads_hash ON downloads(fileHash);

    -- Known peers
    CREATE TABLE IF NOT EXISTS peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peerId TEXT UNIQUE NOT NULL,
      displayName TEXT,
      avatar TEXT,
      bio TEXT,
      filesCount INTEGER DEFAULT 0,
      totalSize INTEGER DEFAULT 0,
      firstSeen INTEGER DEFAULT (strftime('%s', 'now')),
      lastSeen INTEGER DEFAULT (strftime('%s', 'now')),
      isBlocked INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_peers_lastSeen ON peers(lastSeen);
    CREATE INDEX IF NOT EXISTS idx_peers_peerId ON peers(peerId);

    -- Shared folders configuration
    CREATE TABLE IF NOT EXISTS shared_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT UNIQUE NOT NULL,
      filesCount INTEGER DEFAULT 0,
      totalSize INTEGER DEFAULT 0,
      lastScanned INTEGER,
      isEnabled INTEGER DEFAULT 1,
      createdAt INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Search history
    CREATE TABLE IF NOT EXISTS search_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      resultsCount INTEGER DEFAULT 0,
      searchedAt INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_search_date ON search_history(searchedAt);

    -- Kademlia routing table
    CREATE TABLE IF NOT EXISTS routing_table (
      nodeId TEXT PRIMARY KEY,
      destination TEXT NOT NULL,
      lastSeen INTEGER DEFAULT (strftime('%s', 'now')),
      failCount INTEGER DEFAULT 0,
      bucketIndex INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_routing_bucket ON routing_table(bucketIndex);
    CREATE INDEX IF NOT EXISTS idx_routing_lastSeen ON routing_table(lastSeen);

    -- Remote files from peers
    CREATE TABLE IF NOT EXISTS remote_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      peerId TEXT NOT NULL,
      filename TEXT NOT NULL,
      hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mimeType TEXT,
      lastUpdated INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(peerId, hash)
    );

    CREATE INDEX IF NOT EXISTS idx_remote_files_peer ON remote_files(peerId);
    CREATE INDEX IF NOT EXISTS idx_remote_files_hash ON remote_files(hash);
    CREATE INDEX IF NOT EXISTS idx_remote_files_filename ON remote_files(filename);

    -- ============================================================================
    -- BITTORRENT TABLES (Phase 2: Migration to BitTorrent protocol)
    -- ============================================================================

    -- Torrents metadata
    CREATE TABLE IF NOT EXISTS torrents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      infoHash TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      totalSize INTEGER NOT NULL,
      pieceLength INTEGER NOT NULL,
      pieceCount INTEGER NOT NULL,
      pieces TEXT NOT NULL,
      magnetUri TEXT,
      torrentData BLOB,
      isSeeding INTEGER DEFAULT 0,
      savePath TEXT,
      state TEXT DEFAULT 'stopped',
      downloadedBytes INTEGER DEFAULT 0,
      uploadedBytes INTEGER DEFAULT 0,
      createdAt INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_torrents_infoHash ON torrents(infoHash);
    CREATE INDEX IF NOT EXISTS idx_torrents_state ON torrents(state);
    CREATE INDEX IF NOT EXISTS idx_torrents_seeding ON torrents(isSeeding);

    -- Torrent files (for multi-file torrents)
    CREATE TABLE IF NOT EXISTS torrent_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      torrentId INTEGER NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      offset INTEGER NOT NULL,
      FOREIGN KEY (torrentId) REFERENCES torrents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_torrent_files_torrentId ON torrent_files(torrentId);

    -- Torrent pieces tracking
    CREATE TABLE IF NOT EXISTS torrent_pieces (
      torrentId INTEGER NOT NULL,
      pieceIndex INTEGER NOT NULL,
      isComplete INTEGER DEFAULT 0,
      PRIMARY KEY (torrentId, pieceIndex),
      FOREIGN KEY (torrentId) REFERENCES torrents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_torrent_pieces_torrentId ON torrent_pieces(torrentId);
    CREATE INDEX IF NOT EXISTS idx_torrent_pieces_complete ON torrent_pieces(torrentId, isComplete);

    -- Torrent peers (swarm members)
    CREATE TABLE IF NOT EXISTS torrent_peers (
      torrentId INTEGER NOT NULL,
      destination TEXT NOT NULL,
      uploadedTo INTEGER DEFAULT 0,
      downloadedFrom INTEGER DEFAULT 0,
      lastSeen INTEGER,
      PRIMARY KEY (torrentId, destination),
      FOREIGN KEY (torrentId) REFERENCES torrents(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_torrent_peers_torrentId ON torrent_peers(torrentId);
    CREATE INDEX IF NOT EXISTS idx_torrent_peers_lastSeen ON torrent_peers(lastSeen);

    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );
  `;

  db.exec(schema);

  // Run migrations
  runMigrations(db);

  console.log('[Database] Initialized at:', dbPath);
  return db;
}

/**
 * Run database migrations
 */
function runMigrations(db: Database.Database): void {
  // Get current schema version
  let currentVersion = 0;
  try {
    const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
    currentVersion = row?.version || 0;
  } catch {
    // Table might not exist yet
    currentVersion = 0;
  }

  console.log(`[Database] Current schema version: ${currentVersion}, target: ${SCHEMA_VERSION}`);

  // Migration 1 -> 2: Add BitTorrent columns to existing tables
  if (currentVersion < 2) {
    console.log('[Database] Running migration to version 2 (BitTorrent support)...');

    // Check if columns already exist before adding
    const downloadsCols = db.prepare("PRAGMA table_info(downloads)").all() as { name: string }[];
    const downloadsColNames = downloadsCols.map(c => c.name);

    if (!downloadsColNames.includes('infoHash')) {
      db.exec('ALTER TABLE downloads ADD COLUMN infoHash TEXT');
    }
    if (!downloadsColNames.includes('protocol')) {
      db.exec("ALTER TABLE downloads ADD COLUMN protocol TEXT DEFAULT 'legacy'");
    }

    const localFilesCols = db.prepare("PRAGMA table_info(local_files)").all() as { name: string }[];
    const localFilesColNames = localFilesCols.map(c => c.name);

    if (!localFilesColNames.includes('infoHash')) {
      db.exec('ALTER TABLE local_files ADD COLUMN infoHash TEXT');
    }

    // Create index for infoHash on local_files
    try {
      db.exec('CREATE INDEX IF NOT EXISTS idx_local_files_infoHash ON local_files(infoHash)');
    } catch {
      // Index might already exist
    }

    // Update schema version
    db.prepare('INSERT OR REPLACE INTO schema_version (version) VALUES (?)').run(2);
    console.log('[Database] Migration to version 2 complete');
  }
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    console.log('[Database] Closed');
  }
}

// File operations
export const FileOps = {
  insert: (file: {
    path: string;
    filename: string;
    hash: string;
    size: number;
    mimeType: string;
    modifiedAt: number;
  }) => {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO local_files (path, filename, hash, size, mimeType, modifiedAt, sharedAt)
      VALUES (?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
    `);
    return stmt.run(file.path, file.filename, file.hash, file.size, file.mimeType, file.modifiedAt);
  },

  getByHash: (hash: string) => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM local_files WHERE hash = ? AND isShared = 1').get(hash);
  },

  getAll: () => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM local_files WHERE isShared = 1 ORDER BY filename').all();
  },

  search: (query: string) => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM local_files WHERE isShared = 1 AND filename LIKE ? ORDER BY filename').all(`%${query}%`);
  },

  delete: (hash: string) => {
    const db = getDatabase();
    return db.prepare('DELETE FROM local_files WHERE hash = ?').run(hash);
  },

  setShared: (hash: string, shared: boolean) => {
    const db = getDatabase();
    return db.prepare('UPDATE local_files SET isShared = ? WHERE hash = ?').run(shared ? 1 : 0, hash);
  },

  // Update infoHash for a file (after torrent is created)
  setInfoHash: (fileHash: string, infoHash: string) => {
    const db = getDatabase();
    return db.prepare('UPDATE local_files SET infoHash = ? WHERE hash = ?').run(infoHash, fileHash);
  },

  // Get file by infoHash
  getByInfoHash: (infoHash: string) => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM local_files WHERE infoHash = ? AND isShared = 1').get(infoHash);
  },

  // Get files without infoHash (need to be seeded)
  getWithoutInfoHash: () => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM local_files WHERE isShared = 1 AND (infoHash IS NULL OR infoHash = "")').all();
  },

  // Get file with its infoHash for downloads
  getWithInfoHash: (fileHash: string) => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM local_files WHERE hash = ? AND isShared = 1').get(fileHash) as {
      path: string;
      filename: string;
      hash: string;
      size: number;
      infoHash: string | null
    } | undefined;
  }
};

// Download operations
export const DownloadOps = {
  create: (download: {
    filename: string;
    fileHash: string;
    peerId: string;
    peerName: string;
    totalSize: number;
    savePath: string;
  }) => {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO downloads (filename, fileHash, peerId, peerName, totalSize, savePath, status)
      VALUES (?, ?, ?, ?, ?, ?, 'pending')
    `);
    const result = stmt.run(
      download.filename,
      download.fileHash,
      download.peerId,
      download.peerName,
      download.totalSize,
      download.savePath
    );
    return result.lastInsertRowid;
  },

  updateProgress: (id: number, downloadedSize: number, chunkMap?: string) => {
    const db = getDatabase();
    if (chunkMap) {
      return db.prepare('UPDATE downloads SET downloadedSize = ?, chunkMap = ? WHERE id = ?').run(downloadedSize, chunkMap, id);
    }
    return db.prepare('UPDATE downloads SET downloadedSize = ? WHERE id = ?').run(downloadedSize, id);
  },

  setStatus: (id: number, status: string) => {
    const db = getDatabase();
    const updates: Record<string, any> = { status };
    if (status === 'downloading') {
      return db.prepare('UPDATE downloads SET status = ?, startedAt = strftime(\'%s\', \'now\') WHERE id = ?').run(status, id);
    }
    if (status === 'completed') {
      return db.prepare('UPDATE downloads SET status = ?, completedAt = strftime(\'%s\', \'now\') WHERE id = ?').run(status, id);
    }
    return db.prepare('UPDATE downloads SET status = ? WHERE id = ?').run(status, id);
  },

  getAll: () => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM downloads ORDER BY createdAt DESC').all();
  },

  getActive: () => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM downloads WHERE status IN (\'pending\', \'downloading\') ORDER BY createdAt').all();
  },

  getById: (id: number) => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM downloads WHERE id = ?').get(id);
  },

  delete: (id: number) => {
    const db = getDatabase();
    return db.prepare('DELETE FROM downloads WHERE id = ?').run(id);
  },

  updatePeerId: (id: number, newPeerId: string) => {
    const db = getDatabase();
    return db.prepare('UPDATE downloads SET peerId = ? WHERE id = ?').run(newPeerId, id);
  }
};

// Peer operations
export const PeerOps = {
  upsert: (peer: {
    peerId: string;
    displayName?: string;
    filesCount?: number;
    totalSize?: number;
  }) => {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO peers (peerId, displayName, filesCount, totalSize, lastSeen)
      VALUES (?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(peerId) DO UPDATE SET
        displayName = COALESCE(?, displayName),
        filesCount = COALESCE(?, filesCount),
        totalSize = COALESCE(?, totalSize),
        lastSeen = strftime('%s', 'now')
    `);
    return stmt.run(
      peer.peerId,
      peer.displayName,
      peer.filesCount || 0,
      peer.totalSize || 0,
      peer.displayName,
      peer.filesCount,
      peer.totalSize
    );
  },

  getAll: () => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM peers WHERE isBlocked = 0 ORDER BY lastSeen DESC').all();
  },

  getOnline: (threshold = 300) => {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - threshold;
    return db.prepare('SELECT * FROM peers WHERE lastSeen > ? AND isBlocked = 0 ORDER BY lastSeen DESC').all(cutoff);
  },

  getOffline: (threshold = 300) => {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - threshold;
    return db.prepare('SELECT * FROM peers WHERE lastSeen <= ? AND isBlocked = 0 ORDER BY lastSeen DESC').all(cutoff);
  },

  getCounts: (threshold = 300) => {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - threshold;
    const online = db.prepare('SELECT COUNT(*) as count FROM peers WHERE lastSeen > ? AND isBlocked = 0').get(cutoff) as { count: number };
    const total = db.prepare('SELECT COUNT(*) as count FROM peers WHERE isBlocked = 0').get() as { count: number };
    return {
      online: online?.count || 0,
      offline: (total?.count || 0) - (online?.count || 0),
      total: total?.count || 0
    };
  },

  updateLastSeen: (peerId: string, timestamp?: number) => {
    const db = getDatabase();
    const ts = timestamp || Math.floor(Date.now() / 1000);
    return db.prepare('UPDATE peers SET lastSeen = ? WHERE peerId = ?').run(ts, peerId);
  },

  delete: (peerId: string) => {
    const db = getDatabase();
    return db.prepare('DELETE FROM peers WHERE peerId = ?').run(peerId);
  }
};

// Shared folder operations
export const SharedFolderOps = {
  add: (folderPath: string) => {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO shared_folders (path) VALUES (?)
    `);
    return stmt.run(folderPath);
  },

  remove: (folderPath: string) => {
    const db = getDatabase();
    return db.prepare('DELETE FROM shared_folders WHERE path = ?').run(folderPath);
  },

  getAll: () => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM shared_folders WHERE isEnabled = 1').all();
  },

  updateStats: (folderPath: string, filesCount: number, totalSize: number) => {
    const db = getDatabase();
    return db.prepare(`
      UPDATE shared_folders
      SET filesCount = ?, totalSize = ?, lastScanned = strftime('%s', 'now')
      WHERE path = ?
    `).run(filesCount, totalSize, folderPath);
  }
};

// DHT cache operations
export const DHTCacheOps = {
  set: (key: string, value: string, ttl = 3600) => {
    const db = getDatabase();
    const expiresAt = Math.floor(Date.now() / 1000) + ttl;
    return db.prepare(`
      INSERT OR REPLACE INTO dht_cache (key, value, expiresAt, lastUpdated)
      VALUES (?, ?, ?, strftime('%s', 'now'))
    `).run(key, value, expiresAt);
  },

  get: (key: string) => {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    const row = db.prepare('SELECT value FROM dht_cache WHERE key = ? AND expiresAt > ?').get(key, now) as { value: string } | undefined;
    return row?.value;
  },

  cleanup: () => {
    const db = getDatabase();
    const now = Math.floor(Date.now() / 1000);
    return db.prepare('DELETE FROM dht_cache WHERE expiresAt < ?').run(now);
  }
};

// Routing table operations
export const RoutingOps = {
  upsert: (nodeId: string, destination: string, bucketIndex: number) => {
    const db = getDatabase();
    return db.prepare(`
      INSERT INTO routing_table (nodeId, destination, bucketIndex, lastSeen)
      VALUES (?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(nodeId) DO UPDATE SET
        destination = ?,
        lastSeen = strftime('%s', 'now'),
        failCount = 0
    `).run(nodeId, destination, bucketIndex, destination);
  },

  getByBucket: (bucketIndex: number, limit = 20) => {
    const db = getDatabase();
    return db.prepare(`
      SELECT * FROM routing_table
      WHERE bucketIndex = ? AND failCount < 5
      ORDER BY lastSeen DESC
      LIMIT ?
    `).all(bucketIndex, limit);
  },

  getClosest: (targetId: string, limit = 20) => {
    const db = getDatabase();
    // Return all nodes, we'll sort by XOR distance in JS
    return db.prepare('SELECT * FROM routing_table WHERE failCount < 5 ORDER BY lastSeen DESC LIMIT ?').all(limit * 2);
  },

  incrementFail: (nodeId: string) => {
    const db = getDatabase();
    return db.prepare('UPDATE routing_table SET failCount = failCount + 1 WHERE nodeId = ?').run(nodeId);
  },

  cleanup: () => {
    const db = getDatabase();
    // Remove nodes with too many failures
    return db.prepare('DELETE FROM routing_table WHERE failCount >= 5').run();
  }
};

// Remote file operations (files from peers)
export const RemoteFileOps = {
  upsert: (file: {
    peerId: string;
    filename: string;
    hash: string;
    size: number;
    mimeType?: string;
  }) => {
    const db = getDatabase();
    return db.prepare(`
      INSERT INTO remote_files (peerId, filename, hash, size, mimeType, lastUpdated)
      VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(peerId, hash) DO UPDATE SET
        filename = ?,
        size = ?,
        mimeType = ?,
        lastUpdated = strftime('%s', 'now')
    `).run(
      file.peerId, file.filename, file.hash, file.size, file.mimeType || null,
      file.filename, file.size, file.mimeType || null
    );
  },

  upsertBatch: (peerId: string, files: Array<{
    filename: string;
    hash: string;
    size: number;
    mimeType?: string;
  }>) => {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO remote_files (peerId, filename, hash, size, mimeType, lastUpdated)
      VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
      ON CONFLICT(peerId, hash) DO UPDATE SET
        filename = ?,
        size = ?,
        mimeType = ?,
        lastUpdated = strftime('%s', 'now')
    `);

    const insertMany = db.transaction((files: any[]) => {
      for (const file of files) {
        stmt.run(
          peerId, file.filename, file.hash, file.size, file.mimeType || null,
          file.filename, file.size, file.mimeType || null
        );
      }
    });

    insertMany(files);
  },

  getByPeer: (peerId: string) => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM remote_files WHERE peerId = ? ORDER BY filename').all(peerId);
  },

  search: (query: string) => {
    const db = getDatabase();
    return db.prepare(`
      SELECT rf.*, p.displayName as peerName
      FROM remote_files rf
      LEFT JOIN peers p ON rf.peerId = p.peerId
      WHERE rf.filename LIKE ?
      ORDER BY rf.filename
    `).all(`%${query}%`);
  },

  getAll: () => {
    const db = getDatabase();
    return db.prepare(`
      SELECT rf.*, p.displayName as peerName
      FROM remote_files rf
      LEFT JOIN peers p ON rf.peerId = p.peerId
      ORDER BY rf.lastUpdated DESC
    `).all();
  },

  deleteByPeer: (peerId: string) => {
    const db = getDatabase();
    return db.prepare('DELETE FROM remote_files WHERE peerId = ?').run(peerId);
  },

  cleanup: (maxAge = 3600) => {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - maxAge;
    return db.prepare('DELETE FROM remote_files WHERE lastUpdated < ?').run(cutoff);
  }
};

// ============================================================================
// TORRENT OPERATIONS
// ============================================================================

export interface TorrentRow {
  id: number;
  infoHash: string;
  name: string;
  totalSize: number;
  pieceLength: number;
  pieceCount: number;
  pieces: string;
  magnetUri: string | null;
  torrentData: Buffer | null;
  isSeeding: number;
  savePath: string | null;
  state: string;
  downloadedBytes: number;
  uploadedBytes: number;
  createdAt: number;
}

export interface TorrentFileRow {
  id: number;
  torrentId: number;
  path: string;
  size: number;
  offset: number;
}

export interface TorrentPieceRow {
  torrentId: number;
  pieceIndex: number;
  isComplete: number;
}

export interface TorrentPeerRow {
  torrentId: number;
  destination: string;
  uploadedTo: number;
  downloadedFrom: number;
  lastSeen: number | null;
}

export const TorrentOps = {
  /**
   * Create a new torrent entry
   */
  create: (torrent: {
    infoHash: string;
    name: string;
    totalSize: number;
    pieceLength: number;
    pieceCount: number;
    pieces: string;
    magnetUri?: string;
    torrentData?: Buffer;
    savePath?: string;
    isSeeding?: boolean;
  }): number => {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO torrents (infoHash, name, totalSize, pieceLength, pieceCount, pieces, magnetUri, torrentData, savePath, isSeeding, state)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped')
    `);
    const result = stmt.run(
      torrent.infoHash,
      torrent.name,
      torrent.totalSize,
      torrent.pieceLength,
      torrent.pieceCount,
      torrent.pieces,
      torrent.magnetUri || null,
      torrent.torrentData || null,
      torrent.savePath || null,
      torrent.isSeeding ? 1 : 0
    );
    return result.lastInsertRowid as number;
  },

  /**
   * Get torrent by infoHash
   */
  getByInfoHash: (infoHash: string): TorrentRow | undefined => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM torrents WHERE infoHash = ?').get(infoHash) as TorrentRow | undefined;
  },

  /**
   * Get torrent by ID
   */
  getById: (id: number): TorrentRow | undefined => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM torrents WHERE id = ?').get(id) as TorrentRow | undefined;
  },

  /**
   * Get all torrents
   */
  getAll: (): TorrentRow[] => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM torrents ORDER BY createdAt DESC').all() as TorrentRow[];
  },

  /**
   * Get seeding torrents
   */
  getSeeding: (): TorrentRow[] => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM torrents WHERE isSeeding = 1').all() as TorrentRow[];
  },

  /**
   * Get active (downloading/seeding) torrents
   */
  getActive: (): TorrentRow[] => {
    const db = getDatabase();
    return db.prepare("SELECT * FROM torrents WHERE state IN ('downloading', 'seeding')").all() as TorrentRow[];
  },

  /**
   * Update torrent state
   */
  setState: (infoHash: string, state: string): void => {
    const db = getDatabase();
    db.prepare('UPDATE torrents SET state = ? WHERE infoHash = ?').run(state, infoHash);
  },

  /**
   * Update torrent progress
   */
  updateProgress: (infoHash: string, downloadedBytes: number, uploadedBytes: number): void => {
    const db = getDatabase();
    db.prepare('UPDATE torrents SET downloadedBytes = ?, uploadedBytes = ? WHERE infoHash = ?')
      .run(downloadedBytes, uploadedBytes, infoHash);
  },

  /**
   * Set torrent as seeding
   */
  setSeeding: (infoHash: string, isSeeding: boolean): void => {
    const db = getDatabase();
    db.prepare('UPDATE torrents SET isSeeding = ? WHERE infoHash = ?').run(isSeeding ? 1 : 0, infoHash);
  },

  /**
   * Update torrent metadata (name, sizes, etc)
   */
  updateMetadata: (infoHash: string, metadata: { name: string, totalSize: number, pieceLength: number, pieceCount: number, pieces: string }): void => {
    const db = getDatabase();
    db.prepare(`
      UPDATE torrents 
      SET name = ?, totalSize = ?, pieceLength = ?, pieceCount = ?, pieces = ?
      WHERE infoHash = ?
    `).run(metadata.name, metadata.totalSize, metadata.pieceLength, metadata.pieceCount, metadata.pieces, infoHash);

    // Also need to initialize pieces in torrent_pieces if not already done
    const torrent = TorrentOps.getByInfoHash(infoHash);
    if (torrent) {
        TorrentPieceOps.initPieces(torrent.id, metadata.pieceCount);
    }
  },

  /**
   * Update save path
   */
  setSavePath: (infoHash: string, savePath: string): void => {
    const db = getDatabase();
    db.prepare('UPDATE torrents SET savePath = ? WHERE infoHash = ?').run(savePath, infoHash);
  },

  /**
   * Delete torrent
   */
  delete: (infoHash: string): void => {
    const db = getDatabase();
    // Cascading delete will remove files, pieces, and peers
    db.prepare('DELETE FROM torrents WHERE infoHash = ?').run(infoHash);
  },

  /**
   * Check if torrent exists
   */
  exists: (infoHash: string): boolean => {
    const db = getDatabase();
    const row = db.prepare('SELECT 1 FROM torrents WHERE infoHash = ?').get(infoHash);
    return !!row;
  }
};

export const TorrentFileOps = {
  /**
   * Add files to a torrent
   */
  addFiles: (torrentId: number, files: Array<{ path: string; size: number; offset: number }>): void => {
    const db = getDatabase();
    const stmt = db.prepare('INSERT INTO torrent_files (torrentId, path, size, offset) VALUES (?, ?, ?, ?)');
    const insertMany = db.transaction((files: any[]) => {
      for (const file of files) {
        stmt.run(torrentId, file.path, file.size, file.offset);
      }
    });
    insertMany(files);
  },

  /**
   * Get files for a torrent
   */
  getByTorrentId: (torrentId: number): TorrentFileRow[] => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM torrent_files WHERE torrentId = ? ORDER BY offset').all(torrentId) as TorrentFileRow[];
  },

  /**
   * Update files for a torrent (replaces existing files)
   */
  updateFiles: (torrentId: number, files: Array<{ path: string; size: number; offset: number }>): void => {
    const db = getDatabase();
    const deleteStmt = db.prepare('DELETE FROM torrent_files WHERE torrentId = ?');
    const insertStmt = db.prepare('INSERT INTO torrent_files (torrentId, path, size, offset) VALUES (?, ?, ?, ?)');
    
    const transaction = db.transaction((torrentId: number, files: any[]) => {
      deleteStmt.run(torrentId);
      for (const file of files) {
        insertStmt.run(torrentId, file.path, file.size, file.offset);
      }
    });
    
    transaction(torrentId, files);
  },

  /**
   * Get files by infoHash
   */
  getByInfoHash: (infoHash: string): TorrentFileRow[] => {
    const db = getDatabase();
    return db.prepare(`
      SELECT tf.* FROM torrent_files tf
      JOIN torrents t ON tf.torrentId = t.id
      WHERE t.infoHash = ?
      ORDER BY tf.offset
    `).all(infoHash) as TorrentFileRow[];
  }
};

export const TorrentPieceOps = {
  /**
   * Initialize pieces for a torrent
   */
  initPieces: (torrentId: number, pieceCount: number): void => {
    const db = getDatabase();
    const stmt = db.prepare('INSERT OR IGNORE INTO torrent_pieces (torrentId, pieceIndex, isComplete) VALUES (?, ?, 0)');
    const insertMany = db.transaction((count: number) => {
      for (let i = 0; i < count; i++) {
        stmt.run(torrentId, i);
      }
    });
    insertMany(pieceCount);
  },

  /**
   * Mark piece as complete
   */
  setComplete: (torrentId: number, pieceIndex: number, isComplete: boolean): void => {
    const db = getDatabase();
    db.prepare('UPDATE torrent_pieces SET isComplete = ? WHERE torrentId = ? AND pieceIndex = ?')
      .run(isComplete ? 1 : 0, torrentId, pieceIndex);
  },

  /**
   * Mark multiple pieces as complete
   */
  setCompleteMany: (torrentId: number, pieceIndices: number[]): void => {
    const db = getDatabase();
    const stmt = db.prepare('UPDATE torrent_pieces SET isComplete = 1 WHERE torrentId = ? AND pieceIndex = ?');
    const updateMany = db.transaction((indices: number[]) => {
      for (const index of indices) {
        stmt.run(torrentId, index);
      }
    });
    updateMany(pieceIndices);
  },

  /**
   * Get completed pieces
   */
  getCompleted: (torrentId: number): number[] => {
    const db = getDatabase();
    const rows = db.prepare('SELECT pieceIndex FROM torrent_pieces WHERE torrentId = ? AND isComplete = 1')
      .all(torrentId) as { pieceIndex: number }[];
    return rows.map(r => r.pieceIndex);
  },

  /**
   * Get incomplete pieces
   */
  getIncomplete: (torrentId: number): number[] => {
    const db = getDatabase();
    const rows = db.prepare('SELECT pieceIndex FROM torrent_pieces WHERE torrentId = ? AND isComplete = 0')
      .all(torrentId) as { pieceIndex: number }[];
    return rows.map(r => r.pieceIndex);
  },

  /**
   * Count completed pieces
   */
  countCompleted: (torrentId: number): number => {
    const db = getDatabase();
    const row = db.prepare('SELECT COUNT(*) as count FROM torrent_pieces WHERE torrentId = ? AND isComplete = 1')
      .get(torrentId) as { count: number };
    return row.count;
  },

  /**
   * Check if piece is complete
   */
  isComplete: (torrentId: number, pieceIndex: number): boolean => {
    const db = getDatabase();
    const row = db.prepare('SELECT isComplete FROM torrent_pieces WHERE torrentId = ? AND pieceIndex = ?')
      .get(torrentId, pieceIndex) as { isComplete: number } | undefined;
    return row?.isComplete === 1;
  },

  /**
   * Check if all pieces are complete
   */
  isAllComplete: (torrentId: number): boolean => {
    const db = getDatabase();
    const row = db.prepare('SELECT COUNT(*) as count FROM torrent_pieces WHERE torrentId = ? AND isComplete = 0')
      .get(torrentId) as { count: number };
    return row.count === 0;
  }
};

export const TorrentPeerOps = {
  /**
   * Add or update peer for a torrent
   */
  upsert: (torrentId: number, destination: string): void => {
    const db = getDatabase();
    db.prepare(`
      INSERT INTO torrent_peers (torrentId, destination, lastSeen)
      VALUES (?, ?, strftime('%s', 'now'))
      ON CONFLICT(torrentId, destination) DO UPDATE SET
        lastSeen = strftime('%s', 'now')
    `).run(torrentId, destination);
  },

  /**
   * Update peer stats
   */
  updateStats: (torrentId: number, destination: string, uploadedTo: number, downloadedFrom: number): void => {
    const db = getDatabase();
    db.prepare(`
      UPDATE torrent_peers
      SET uploadedTo = ?, downloadedFrom = ?, lastSeen = strftime('%s', 'now')
      WHERE torrentId = ? AND destination = ?
    `).run(uploadedTo, downloadedFrom, torrentId, destination);
  },

  /**
   * Increment uploaded/downloaded bytes
   */
  incrementStats: (torrentId: number, destination: string, uploaded: number, downloaded: number): void => {
    const db = getDatabase();
    db.prepare(`
      UPDATE torrent_peers
      SET uploadedTo = uploadedTo + ?, downloadedFrom = downloadedFrom + ?, lastSeen = strftime('%s', 'now')
      WHERE torrentId = ? AND destination = ?
    `).run(uploaded, downloaded, torrentId, destination);
  },

  /**
   * Get peers for a torrent
   */
  getByTorrentId: (torrentId: number): TorrentPeerRow[] => {
    const db = getDatabase();
    return db.prepare('SELECT * FROM torrent_peers WHERE torrentId = ? ORDER BY lastSeen DESC')
      .all(torrentId) as TorrentPeerRow[];
  },

  /**
   * Get recent peers (seen within threshold seconds)
   */
  getRecent: (torrentId: number, thresholdSeconds: number = 300): TorrentPeerRow[] => {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - thresholdSeconds;
    return db.prepare('SELECT * FROM torrent_peers WHERE torrentId = ? AND lastSeen > ? ORDER BY lastSeen DESC')
      .all(torrentId, cutoff) as TorrentPeerRow[];
  },

  /**
   * Remove peer
   */
  remove: (torrentId: number, destination: string): void => {
    const db = getDatabase();
    db.prepare('DELETE FROM torrent_peers WHERE torrentId = ? AND destination = ?').run(torrentId, destination);
  },

  /**
   * Remove stale peers
   */
  cleanup: (torrentId: number, maxAgeSeconds: number = 3600): number => {
    const db = getDatabase();
    const cutoff = Math.floor(Date.now() / 1000) - maxAgeSeconds;
    const result = db.prepare('DELETE FROM torrent_peers WHERE torrentId = ? AND lastSeen < ?').run(torrentId, cutoff);
    return result.changes;
  },

  /**
   * Count peers for a torrent
   */
  count: (torrentId: number): number => {
    const db = getDatabase();
    const row = db.prepare('SELECT COUNT(*) as count FROM torrent_peers WHERE torrentId = ?')
      .get(torrentId) as { count: number };
    return row.count;
  }
};
