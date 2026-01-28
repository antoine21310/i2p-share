import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

let db: Database.Database | null = null;

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
  `;

  db.exec(schema);

  console.log('[Database] Initialized at:', dbPath);
  return db;
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
    return db.prepare('SELECT * FROM peers WHERE lastSeen > ? AND isBlocked = 0').all(cutoff);
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
