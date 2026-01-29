/**
 * WebTorrent Type Declarations
 *
 * Minimal type definitions for WebTorrent used in I2P Share
 */

declare module 'webtorrent' {
  import { EventEmitter } from 'events';
  import { Duplex } from 'stream';

  export interface TorrentOptions {
    path?: string;
    announce?: string[];
    skipVerify?: boolean;
    name?: string;
  }

  export interface TorrentFile {
    name: string;
    path: string;
    length: number;
    offset: number;
    createReadStream(opts?: { start?: number; end?: number }): NodeJS.ReadableStream;
  }

  export interface Wire extends EventEmitter {
    peerId: string;
    peerIdBuffer: Buffer;
    type: 'webrtc' | 'tcpIncoming' | 'tcpOutgoing' | 'utp';
    uploaded: number;
    downloaded: number;
    uploadSpeed(): number;
    downloadSpeed(): number;
    destroy(): void;
  }

  export interface Torrent extends EventEmitter {
    infoHash: string;
    magnetURI: string;
    torrentFile: Buffer;
    name: string;
    path: string;
    length: number;
    pieceLength: number;
    files: TorrentFile[];
    pieces: (null | boolean)[];
    downloaded: number;
    uploaded: number;
    downloadSpeed: number;
    uploadSpeed: number;
    progress: number;
    ratio: number;
    numPeers: number;
    timeRemaining: number | null;
    done: boolean;
    ready: boolean;
    paused: boolean;

    addPeer(peer: string | Duplex): void;
    removePeer(peer: string): void;
    select(start: number, end: number, priority?: number): void;
    deselect(start: number, end: number): void;
    critical(start: number, end: number): void;
    pause(): void;
    resume(): void;
    destroy(opts?: { destroyStore?: boolean }, callback?: (err?: Error) => void): void;

    on(event: 'ready', listener: () => void): this;
    on(event: 'metadata', listener: () => void): this;
    on(event: 'done', listener: () => void): this;
    on(event: 'download', listener: (bytes: number) => void): this;
    on(event: 'upload', listener: (bytes: number) => void): this;
    on(event: 'wire', listener: (wire: Wire) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'warning', listener: (warning: Error | string) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export interface Options {
    dht?: boolean;
    tracker?: boolean;
    lsd?: boolean;
    webSeeds?: boolean;
    utp?: boolean;
    maxConns?: number;
    downloadLimit?: number;
    uploadLimit?: number;
  }

  export interface Instance extends EventEmitter {
    torrents: Torrent[];
    downloadSpeed: number;
    uploadSpeed: number;
    ratio: number;

    add(torrentId: string | Buffer, opts?: TorrentOptions): Torrent;
    seed(input: string | string[] | Buffer | Buffer[], opts?: TorrentOptions): Torrent;
    get(infoHash: string): Torrent | null;
    remove(infoHash: string, opts?: { destroyStore?: boolean }, callback?: (err?: Error) => void): void;
    destroy(callback?: (err?: Error) => void): void;

    on(event: 'torrent', listener: (torrent: Torrent) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  class WebTorrent extends EventEmitter implements Instance {
    constructor(opts?: Options);
    torrents: Torrent[];
    downloadSpeed: number;
    uploadSpeed: number;
    ratio: number;

    add(torrentId: string | Buffer, opts?: TorrentOptions): Torrent;
    seed(input: string | string[] | Buffer | Buffer[], opts?: TorrentOptions): Torrent;
    get(infoHash: string): Torrent | null;
    remove(infoHash: string, opts?: { destroyStore?: boolean }, callback?: (err?: Error) => void): void;
    destroy(callback?: (err?: Error) => void): void;

    on(event: 'torrent', listener: (torrent: Torrent) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export default WebTorrent;
  export { Torrent, TorrentOptions, Instance };
}
