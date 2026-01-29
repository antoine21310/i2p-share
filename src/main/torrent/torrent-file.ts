/**
 * Torrent File Utilities
 *
 * Creates and parses .torrent files and magnet URIs.
 * Uses create-torrent and parse-torrent packages.
 */

import bencode from 'bencode';
import createTorrent from 'create-torrent';
import crypto from 'crypto';
import fs from 'fs';
import parseTorrent from 'parse-torrent';
import path from 'path';
import {
    calculatePieceLength,
    TORRENT_CONSTANTS,
    TorrentFile,
    TorrentMetadata
} from '../../shared/torrent-types.js';

// Type for parsed torrent data
interface ParsedTorrent {
  infoHash?: string;
  name?: string;
  length?: number;
  pieceLength?: number;
  pieces?: string[];
  files?: Array<{ path: string; name: string; length: number; offset: number }>;
  announce?: string[];
  urlList?: string[];
  private?: boolean;
  created?: Date;
  createdBy?: string;
  comment?: string;
  'announce-list'?: string[][];
}

/**
 * Options for creating a torrent
 */
export interface CreateTorrentOptions {
  /** Torrent name (defaults to file/folder name) */
  name?: string;
  /** Tracker URLs */
  announce?: string[];
  /** Comment field */
  comment?: string;
  /** Created by field */
  createdBy?: string;
  /** Private torrent flag */
  isPrivate?: boolean;
  /** Custom piece length (auto-calculated if not specified) */
  pieceLength?: number;
  /** URL list for web seeding */
  urlList?: string[];
}

/**
 * Convert parsed torrent to our TorrentMetadata format
 */
function parsedToMetadata(parsed: ParsedTorrent): TorrentMetadata {
  const files: TorrentFile[] = [];
  let offset = 0;

  if (parsed.files) {
    for (const file of parsed.files) {
      files.push({
        path: Array.isArray(file.path) ? file.path.join('/') : (file.name || ''),
        size: file.length,
        offset: file.offset || offset,
        pathArray: Array.isArray(file.path) ? file.path : undefined
      });
      offset += file.length;
    }
  } else if (parsed.length) {
    // Single file torrent
    files.push({
      path: parsed.name || 'unknown',
      size: parsed.length,
      offset: 0
    });
  }

  return {
    infoHash: parsed.infoHash || '',
    name: parsed.name || 'unknown',
    totalSize: parsed.length || 0,
    pieceLength: parsed.pieceLength || 0,
    pieceCount: parsed.pieces?.length || 0,
    pieces: parsed.pieces ? Buffer.from(parsed.pieces.map(p => Buffer.from(p, 'hex')).reduce((a, b) => Buffer.concat([a, b]), Buffer.alloc(0))) : Buffer.alloc(0),
    files,
    magnetUri: parseTorrent.toMagnetURI(parsed as any),
    announce: parsed.announce?.[0],
    announceList: parsed['announce-list'],
    isPrivate: parsed.private || false,
    createdAt: parsed.created ? new Date(parsed.created).getTime() : undefined,
    createdBy: parsed.createdBy,
    comment: parsed.comment
  };
}

/**
 * Torrent File Utilities
 */
export class TorrentFileUtils {
  /**
   * Create a .torrent file from a local file or directory
   */
  static async createFromPath(
    filePath: string,
    options: CreateTorrentOptions = {}
  ): Promise<{ metadata: TorrentMetadata; torrentData: Buffer }> {
    return new Promise((resolve, reject) => {
      // Check if path exists
      if (!fs.existsSync(filePath)) {
        reject(new Error(`Path does not exist: ${filePath}`));
        return;
      }

      const stats = fs.statSync(filePath);
      const totalSize = stats.isDirectory()
        ? TorrentFileUtils.getDirectorySize(filePath)
        : stats.size;

      // Calculate piece length if not specified
      const pieceLength = options.pieceLength || calculatePieceLength(totalSize);

      const createOptions = {
        name: options.name || path.basename(filePath),
        pieceLength,
        private: options.isPrivate || false,
        announce: options.announce,
        announceList: options.announce ? [options.announce] : undefined,
        comment: options.comment,
        createdBy: options.createdBy || 'I2P Share',
        urlList: options.urlList
      };

      createTorrent(filePath, createOptions, (err, torrentData) => {
        if (err) {
          reject(err);
          return;
        }

        try {
          // Parse the created torrent to get metadata
          const parsed = parseTorrent(torrentData) as unknown as ParsedTorrent;
          const metadata = parsedToMetadata(parsed);
          metadata.torrentData = Buffer.from(torrentData);

          resolve({ metadata, torrentData: Buffer.from(torrentData) });
        } catch (parseErr) {
          reject(parseErr);
        }
      });
    });
  }

  /**
   * Parse a .torrent file buffer
   */
  static parseBuffer(torrentData: Buffer): TorrentMetadata {
    const parsed = parseTorrent(torrentData) as unknown as ParsedTorrent;
    const metadata = parsedToMetadata(parsed);
    metadata.torrentData = torrentData;
    return metadata;
  }

  /**
   * Parse a .torrent file from disk
   */
  static parseFile(torrentPath: string): TorrentMetadata {
    const torrentData = fs.readFileSync(torrentPath);
    return TorrentFileUtils.parseBuffer(torrentData);
  }

  /**
   * Parse a magnet URI
   */
  static parseMagnet(magnetUri: string): Partial<TorrentMetadata> {
    const parsed = parseTorrent(magnetUri) as unknown as ParsedTorrent;

    return {
      infoHash: parsed.infoHash || '',
      name: parsed.name || parsed.infoHash || 'unknown',
      magnetUri,
      announce: parsed.announce?.[0],
      announceList: parsed['announce-list']
    };
  }

  /**
   * Generate a magnet URI from torrent metadata
   */
  static toMagnetUri(metadata: TorrentMetadata, trackers?: string[]): string {
    let uri = `magnet:?xt=urn:btih:${metadata.infoHash}`;

    if (metadata.name) {
      uri += `&dn=${encodeURIComponent(metadata.name)}`;
    }

    const allTrackers = trackers || [];
    if (metadata.announce) {
      allTrackers.push(metadata.announce);
    }
    if (metadata.announceList) {
      for (const tier of metadata.announceList) {
        allTrackers.push(...tier);
      }
    }

    // Deduplicate trackers
    const uniqueTrackers = [...new Set(allTrackers)];
    for (const tracker of uniqueTrackers) {
      uri += `&tr=${encodeURIComponent(tracker)}`;
    }

    // Add file size
    if (metadata.totalSize) {
      uri += `&xl=${metadata.totalSize}`;
    }

    return uri;
  }

  /**
   * Generate info hash from info dictionary
   */
  static computeInfoHash(infoDict: Buffer | object): string {
    const infoBuffer = Buffer.isBuffer(infoDict)
      ? infoDict
      : bencode.encode(infoDict);
    return crypto.createHash('sha1').update(infoBuffer).digest('hex');
  }

  /**
   * Compute SHA1 hash of a piece
   */
  static computePieceHash(pieceData: Buffer): Buffer {
    return crypto.createHash('sha1').update(pieceData).digest();
  }

  /**
   * Compute piece hashes for a file
   */
  static async computePieceHashes(
    filePath: string,
    pieceLength: number,
    onProgress?: (pieceIndex: number, total: number) => void
  ): Promise<Buffer[]> {
    return new Promise((resolve, reject) => {
      const stats = fs.statSync(filePath);
      const totalSize = stats.size;
      const pieceCount = Math.ceil(totalSize / pieceLength);
      const hashes: Buffer[] = [];

      const stream = fs.createReadStream(filePath, {
        highWaterMark: pieceLength
      });

      let currentPieceData = Buffer.alloc(0);
      let pieceIndex = 0;

      stream.on('data', (chunk: string | Buffer) => {
        const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        currentPieceData = Buffer.concat([currentPieceData, data]);

        while (currentPieceData.length >= pieceLength) {
          const pieceData = currentPieceData.slice(0, pieceLength);
          currentPieceData = currentPieceData.slice(pieceLength);

          const hash = TorrentFileUtils.computePieceHash(pieceData);
          hashes.push(hash);
          pieceIndex++;

          if (onProgress) {
            onProgress(pieceIndex, pieceCount);
          }
        }
      });

      stream.on('end', () => {
        // Handle last piece (may be smaller)
        if (currentPieceData.length > 0) {
          const hash = TorrentFileUtils.computePieceHash(currentPieceData);
          hashes.push(hash);
          pieceIndex++;

          if (onProgress) {
            onProgress(pieceIndex, pieceCount);
          }
        }

        resolve(hashes);
      });

      stream.on('error', reject);
    });
  }

  /**
   * Verify a piece against its expected hash
   */
  static verifyPiece(pieceData: Buffer, expectedHash: Buffer | string): boolean {
    const actualHash = TorrentFileUtils.computePieceHash(pieceData);
    const expected = Buffer.isBuffer(expectedHash)
      ? expectedHash
      : Buffer.from(expectedHash, 'hex');
    return actualHash.equals(expected);
  }

  /**
   * Get total size of a directory
   */
  static getDirectorySize(dirPath: string): number {
    let totalSize = 0;

    const walk = (currentPath: string) => {
      const entries = fs.readdirSync(currentPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          totalSize += fs.statSync(fullPath).size;
        }
      }
    };

    walk(dirPath);
    return totalSize;
  }

  /**
   * Get piece hash at specific index from concatenated pieces buffer
   */
  static getPieceHash(pieces: Buffer | string, index: number): Buffer {
    const piecesBuffer = Buffer.isBuffer(pieces)
      ? pieces
      : Buffer.from(pieces, 'hex');
    const start = index * TORRENT_CONSTANTS.PIECE_HASH_LENGTH;
    const end = start + TORRENT_CONSTANTS.PIECE_HASH_LENGTH;
    return piecesBuffer.slice(start, end);
  }

  /**
   * Convert pieces buffer to array of hex strings
   */
  static piecesToArray(pieces: Buffer | string): string[] {
    const piecesBuffer = Buffer.isBuffer(pieces)
      ? pieces
      : Buffer.from(pieces, 'hex');
    const result: string[] = [];
    const hashLength = TORRENT_CONSTANTS.PIECE_HASH_LENGTH;

    for (let i = 0; i < piecesBuffer.length; i += hashLength) {
      result.push(piecesBuffer.slice(i, i + hashLength).toString('hex'));
    }

    return result;
  }

  /**
   * Convert array of hex strings to pieces buffer
   */
  static arrayToPieces(hashes: string[]): Buffer {
    return Buffer.concat(hashes.map(h => Buffer.from(h, 'hex')));
  }

  /**
   * Calculate piece index and offset for a byte position
   */
  static bytePositionToPiece(
    bytePosition: number,
    pieceLength: number
  ): { pieceIndex: number; offset: number } {
    const pieceIndex = Math.floor(bytePosition / pieceLength);
    const offset = bytePosition % pieceLength;
    return { pieceIndex, offset };
  }

  /**
   * Calculate byte range for a piece
   */
  static pieceToByteRange(
    pieceIndex: number,
    pieceLength: number,
    totalSize: number
  ): { start: number; end: number; length: number } {
    const start = pieceIndex * pieceLength;
    const end = Math.min(start + pieceLength, totalSize);
    return { start, end, length: end - start };
  }

  /**
   * Find file for a piece index in multi-file torrent
   */
  static findFileForPiece(
    pieceIndex: number,
    pieceLength: number,
    files: TorrentFile[]
  ): Array<{ file: TorrentFile; start: number; end: number }> {
    const pieceStart = pieceIndex * pieceLength;
    const pieceEnd = pieceStart + pieceLength;
    const result: Array<{ file: TorrentFile; start: number; end: number }> = [];

    for (const file of files) {
      const fileEnd = file.offset + file.size;

      // Check if piece overlaps with this file
      if (pieceStart < fileEnd && pieceEnd > file.offset) {
        const start = Math.max(0, pieceStart - file.offset);
        const end = Math.min(file.size, pieceEnd - file.offset);
        result.push({ file, start, end });
      }

      // If we've passed this piece, no need to check more files
      if (file.offset >= pieceEnd) {
        break;
      }
    }

    return result;
  }

  /**
   * Generate a unique peer ID for this client
   */
  static generatePeerId(): Buffer {
    // Format: -I2PS10-<12 random bytes>
    // I2PS = I2P Share, 10 = version 1.0
    const prefix = Buffer.from('-I2PS10-');
    const random = crypto.randomBytes(12);
    return Buffer.concat([prefix, random]);
  }

  /**
   * Parse peer ID to get client name/version
   */
  static parsePeerId(peerId: Buffer): { client: string; version: string } | null {
    const str = peerId.toString('ascii');

    // Azureus-style: -XX0000-
    if (str[0] === '-' && str[7] === '-') {
      const clientCode = str.slice(1, 3);
      const version = str.slice(3, 7);

      const clients: Record<string, string> = {
        'I2': 'I2P Share',
        'AZ': 'Azureus',
        'UT': 'uTorrent',
        'TR': 'Transmission',
        'qB': 'qBittorrent',
        'DE': 'Deluge',
        'LT': 'libtorrent',
        'WT': 'WebTorrent'
      };

      return {
        client: clients[clientCode] || `Unknown (${clientCode})`,
        version: `${version[0]}.${version[1]}.${version[2]}.${version[3]}`
      };
    }

    return null;
  }
}

/**
 * Export convenience functions
 */
export const createFromPath = TorrentFileUtils.createFromPath;
export const parseBuffer = TorrentFileUtils.parseBuffer;
export const parseFile = TorrentFileUtils.parseFile;
export const parseMagnet = TorrentFileUtils.parseMagnet;
export const toMagnetUri = TorrentFileUtils.toMagnetUri;
export const computeInfoHash = TorrentFileUtils.computeInfoHash;
export const computePieceHash = TorrentFileUtils.computePieceHash;
export const verifyPiece = TorrentFileUtils.verifyPiece;
export const generatePeerId = TorrentFileUtils.generatePeerId;
