// Shared utilities - DO NOT duplicate in other files!
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ============================================================================
// FORMATTING UTILITIES
// ============================================================================

/**
 * Format bytes to human readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 0) return 'Invalid';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const index = Math.min(i, sizes.length - 1);

  return parseFloat((bytes / Math.pow(k, index)).toFixed(2)) + ' ' + sizes[index];
}

/**
 * Format bytes per second to human readable speed
 */
export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return '0 B/s';
  return formatBytes(bytesPerSec) + '/s';
}

/**
 * Format duration in milliseconds to human readable string
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return 'less than a second';

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/**
 * Format timestamp to relative time (e.g., "2 hours ago")
 */
export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;

  return new Date(timestamp).toLocaleDateString();
}

/**
 * Truncate I2P destination for display
 */
export function truncateDestination(dest: string, length: number = 16): string {
  if (!dest) return 'Unknown';
  if (dest.length <= length) return dest;
  return dest.substring(0, length) + '...';
}

// ============================================================================
// VALIDATION UTILITIES
// ============================================================================

/**
 * Validate and sanitize filename to prevent path traversal
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) return 'unnamed';

  // Remove path separators and dangerous characters
  let safe = path.basename(filename);
  safe = safe.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');

  // Prevent hidden files on Unix
  if (safe.startsWith('.')) {
    safe = '_' + safe.substring(1);
  }

  // Limit length
  if (safe.length > 255) {
    const ext = path.extname(safe);
    const name = path.basename(safe, ext);
    safe = name.substring(0, 255 - ext.length) + ext;
  }

  return safe || 'unnamed';
}

/**
 * Validate search query
 */
export function validateSearchQuery(query: string): { valid: boolean; sanitized: string; error?: string } {
  if (!query || typeof query !== 'string') {
    return { valid: false, sanitized: '', error: 'Query must be a non-empty string' };
  }

  // Trim and limit length
  let sanitized = query.trim().substring(0, 500);

  // Remove potentially dangerous characters (but allow unicode)
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

  if (sanitized.length < 1) {
    return { valid: false, sanitized: '', error: 'Query too short' };
  }

  return { valid: true, sanitized };
}

/**
 * Validate I2P destination format
 */
export function validateI2PDestination(dest: string): boolean {
  if (!dest || typeof dest !== 'string') return false;

  // Full destination is base64, typically 516+ characters ending in AAAA
  if (dest.length > 100) {
    // Check if it's valid base64
    try {
      const decoded = Buffer.from(dest, 'base64');
      return decoded.length >= 387; // Minimum destination size
    } catch {
      return false;
    }
  }

  // B32 address is 52 characters + .b32.i2p
  const b32Regex = /^[a-z2-7]{52}(\.b32\.i2p)?$/i;
  return b32Regex.test(dest);
}

/**
 * Validate display name
 */
export function validateDisplayName(name: string): { valid: boolean; sanitized: string; error?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, sanitized: 'Anonymous', error: 'Name must be a string' };
  }

  let sanitized = name.trim().substring(0, 50);
  sanitized = sanitized.replace(/[\x00-\x1f]/g, '');

  if (sanitized.length < 1) {
    return { valid: true, sanitized: 'Anonymous' };
  }

  return { valid: true, sanitized };
}

// ============================================================================
// DISK SPACE UTILITIES
// ============================================================================

/**
 * Get available disk space for a path (cross-platform)
 */
export async function getAvailableDiskSpace(targetPath: string): Promise<number> {
  return new Promise((resolve) => {
    try {
      // Use statfs on supported platforms
      if (process.platform === 'win32') {
        // On Windows, use child_process to run wmic
        const { exec } = require('child_process');
        const drive = path.parse(targetPath).root || 'C:\\';
        const driveLetter = drive.charAt(0).toUpperCase();

        exec(`wmic logicaldisk where "DeviceID='${driveLetter}:'" get FreeSpace /format:value`,
          (error: any, stdout: string) => {
            if (error) {
              resolve(0);
              return;
            }
            const match = stdout.match(/FreeSpace=(\d+)/);
            resolve(match ? parseInt(match[1], 10) : 0);
          }
        );
      } else {
        // On Unix-like systems, use fs.statfs
        fs.statfs(targetPath, (err, stats) => {
          if (err) {
            resolve(0);
            return;
          }
          resolve(stats.bavail * stats.bsize);
        });
      }
    } catch {
      resolve(0);
    }
  });
}

/**
 * Check if there's enough disk space for a download
 */
export async function hasEnoughDiskSpace(
  targetPath: string,
  requiredBytes: number,
  minFreeBytes: number = 100 * 1024 * 1024
): Promise<{ enough: boolean; available: number; required: number }> {
  const available = await getAvailableDiskSpace(targetPath);
  const totalRequired = requiredBytes + minFreeBytes;

  return {
    enough: available >= totalRequired,
    available,
    required: totalRequired
  };
}

// ============================================================================
// CRYPTO UTILITIES (using Node.js crypto, NOT crypto-js)
// ============================================================================

/**
 * Generate SHA256 hash of data
 */
export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

// ============================================================================
// ED25519 ASYMMETRIC SIGNING (for message authentication)
// ============================================================================

export interface SigningKeypair {
  publicKey: string;  // Base64 encoded
  privateKey: string; // Base64 encoded
}

/**
 * Generate a new Ed25519 keypair for message signing
 */
export function generateSigningKeypair(): SigningKeypair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  };
}

/**
 * Sign a message with Ed25519 private key
 */
export function signMessageEd25519(message: string, privateKeyBase64: string): string {
  try {
    const privateKeyDer = Buffer.from(privateKeyBase64, 'base64');
    const privateKey = crypto.createPrivateKey({
      key: privateKeyDer,
      format: 'der',
      type: 'pkcs8'
    });

    const signature = crypto.sign(null, Buffer.from(message, 'utf8'), privateKey);
    return signature.toString('base64');
  } catch (error) {
    console.error('[Crypto] Failed to sign message:', error);
    return '';
  }
}

/**
 * Verify an Ed25519 signature
 */
export function verifySignatureEd25519(message: string, signature: string, publicKeyBase64: string): boolean {
  try {
    const publicKeyDer = Buffer.from(publicKeyBase64, 'base64');
    const publicKey = crypto.createPublicKey({
      key: publicKeyDer,
      format: 'der',
      type: 'spki'
    });

    const signatureBuffer = Buffer.from(signature, 'base64');
    return crypto.verify(null, Buffer.from(message, 'utf8'), publicKey, signatureBuffer);
  } catch (error) {
    console.error('[Crypto] Failed to verify signature:', error);
    return false;
  }
}

/**
 * Create a signed message object (for tracker/DHT messages)
 */
export interface SignedMessage {
  data: any;
  nonce: string;
  timestamp: number;
  signature: string;
  signingKey: string;  // Public key of signer
}

/**
 * Create and sign a message
 */
export function createSignedMessage(
  data: any,
  privateKey: string,
  publicKey: string
): SignedMessage {
  const nonce = generateNonce();
  const timestamp = Date.now();

  // Create canonical message for signing
  const messageToSign = JSON.stringify({ data, nonce, timestamp });
  const signature = signMessageEd25519(messageToSign, privateKey);

  return {
    data,
    nonce,
    timestamp,
    signature,
    signingKey: publicKey
  };
}

/**
 * Verify a signed message
 * Returns the data if valid, throws if invalid
 */
export function verifySignedMessage(
  message: SignedMessage,
  maxAgeMs: number = 5 * 60 * 1000 // 5 minutes default
): { valid: boolean; data: any; error?: string } {
  // Check timestamp is recent
  const age = Date.now() - message.timestamp;
  if (age > maxAgeMs) {
    return { valid: false, data: null, error: 'Message expired' };
  }

  if (age < -60000) { // Allow 1 minute clock drift
    return { valid: false, data: null, error: 'Message timestamp in future' };
  }

  // Verify signature
  const messageToVerify = JSON.stringify({
    data: message.data,
    nonce: message.nonce,
    timestamp: message.timestamp
  });

  const isValid = verifySignatureEd25519(messageToVerify, message.signature, message.signingKey);

  if (!isValid) {
    return { valid: false, data: null, error: 'Invalid signature' };
  }

  return { valid: true, data: message.data };
}

/**
 * Generate SHA1 hash (for DHT node IDs)
 */
export function sha1(data: string | Buffer): string {
  return crypto.createHash('sha1').update(data).digest('hex');
}

/**
 * Generate random bytes as hex string
 */
export function randomHex(bytes: number = 16): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Generate a nonce for message replay protection
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex') + '-' + Date.now().toString(36);
}

/**
 * Sign a message with HMAC-SHA256
 */
export function signMessage(message: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(message).digest('hex');
}

/**
 * Verify a message signature
 */
export function verifySignature(message: string, signature: string, secret: string): boolean {
  const expected = signMessage(message, secret);
  return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
}

/**
 * Calculate file hash with streaming (memory efficient)
 */
export function hashFileStream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 * 1024 });

    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ============================================================================
// RETRY UTILITIES
// ============================================================================

/**
 * Calculate exponential backoff delay
 */
export function calculateBackoff(
  attempt: number,
  baseDelayMs: number = 5000,
  maxDelayMs: number = 60000
): number {
  const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  // Add jitter (±20%)
  const jitter = delay * 0.2 * (Math.random() - 0.5);
  return Math.round(delay + jitter);
}

/**
 * Sleep for specified milliseconds
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    onRetry?: (attempt: number, error: Error) => void;
  } = {}
): Promise<T> {
  const { maxRetries = 5, baseDelayMs = 5000, maxDelayMs = 60000, onRetry } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (attempt < maxRetries) {
        const delay = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
        onRetry?.(attempt + 1, lastError);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

// ============================================================================
// EVENT EMITTER UTILITIES
// ============================================================================

/**
 * Cleanup helper for EventEmitter
 * Call this in your class destructor/cleanup method
 */
export function cleanupEventEmitter(emitter: NodeJS.EventEmitter): void {
  emitter.removeAllListeners();
}

/**
 * Create a one-time event listener with timeout
 */
export function onceWithTimeout<T>(
  emitter: NodeJS.EventEmitter,
  event: string,
  timeoutMs: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.removeListener(event, handler);
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeoutMs);

    const handler = (data: T) => {
      clearTimeout(timeout);
      resolve(data);
    };

    emitter.once(event, handler);
  });
}
