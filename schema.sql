-- I2P Share Database Schema

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
