/**
 * Torrent Module (WebTorrent Edition)
 *
 * Exports all torrent-related functionality.
 */

// Core I2P transport
export { I2PTransport, I2PTransportPool, TransportState, closeTransportPool, connectI2P, createI2PTransport, getTransportPool } from './i2p-transport.js';
export type { I2PTransportConfig } from './i2p-transport.js';

// I2P Socket Adapter for WebTorrent
export { I2PSocketAdapter, createI2PSocket, createI2PSocketSync, SocketState } from './i2p-socket-adapter.js';
export type { I2PSocketConfig } from './i2p-socket-adapter.js';

// WebTorrent I2P Client
export { WebTorrentI2PClient } from './webtorrent-i2p-client.js';
export type { I2PClientConfig, I2PTorrentOptions, WebTorrentI2PClientEvents } from './webtorrent-i2p-client.js';

// Peer Injector
export { I2PPeerInjector, createPeerInjector } from './i2p-peer-injector.js';
export type { PeerInjectorConfig, PeerInjectorEvents } from './i2p-peer-injector.js';

// Torrent file utilities
export { TorrentFileUtils, computeInfoHash, computePieceHash, createFromPath, generatePeerId, parseBuffer, parseFile, parseMagnet, toMagnetUri, verifyPiece } from './torrent-file.js';
export type { CreateTorrentOptions } from './torrent-file.js';

// Torrent Manager
export { TorrentManager, getTorrentManager } from './torrent-manager.js';
export type { GlobalStats, TorrentManagerConfig, TorrentManagerEvents } from './torrent-manager.js';

// Multi-tracker support
export { MultiTrackerManager, createMultiTrackerManager } from './multi-tracker-manager.js';
export type {
    MultiAnnounceResult,
    MultiScrapeResult, MultiTrackerManagerConfig,
    MultiTrackerManagerEvents,
    TrackerStatus
} from './multi-tracker-manager.js';

// Embedded tracker
export { EmbeddedTracker, createEmbeddedTracker, getEmbeddedTracker } from './embedded-tracker.js';
export type {
    EmbeddedTrackerConfig, EmbeddedTrackerEvents, EmbeddedTrackerState
} from './embedded-tracker.js';

// Re-export types from shared
export * from '../../shared/torrent-types.js';
