import { EventEmitter } from 'events';
import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import https from 'https';
import { spawn, ChildProcess } from 'child_process';
import { createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';

// i2pd release URLs for each platform
const I2PD_VERSION = '2.54.0';
const I2PD_URLS: Record<string, string> = {
  win32: `https://github.com/PurpleI2P/i2pd/releases/download/${I2PD_VERSION}/i2pd_${I2PD_VERSION}_win64_mingw.zip`,
  darwin: `https://github.com/PurpleI2P/i2pd/releases/download/${I2PD_VERSION}/i2pd-${I2PD_VERSION}-osx.tar.gz`,
  linux: `https://github.com/PurpleI2P/i2pd/releases/download/${I2PD_VERSION}/i2pd_${I2PD_VERSION}_linux_x64.tar.gz`
};

interface I2PDState {
  status: 'stopped' | 'downloading' | 'starting' | 'running' | 'error';
  error?: string;
  progress?: number;
}

export class I2PDManager extends EventEmitter {
  private i2pdProcess: ChildProcess | null = null;
  private i2pdPath: string;
  private dataPath: string;
  private state: I2PDState = { status: 'stopped' };

  constructor() {
    super();
    // Store i2pd in app's userData folder
    const userDataPath = app?.getPath('userData') || path.join(process.cwd(), 'data');
    this.i2pdPath = path.join(userDataPath, 'i2pd');
    this.dataPath = path.join(this.i2pdPath, 'data');
  }

  getState(): I2PDState {
    return { ...this.state };
  }

  private setState(state: Partial<I2PDState>): void {
    this.state = { ...this.state, ...state };
    this.emit('state', this.state);
  }

  private getExecutableName(): string {
    return process.platform === 'win32' ? 'i2pd.exe' : 'i2pd';
  }

  private getExecutablePath(): string {
    return path.join(this.i2pdPath, this.getExecutableName());
  }

  async isInstalled(): Promise<boolean> {
    const execPath = this.getExecutablePath();
    return fs.existsSync(execPath);
  }

  async ensureInstalled(): Promise<void> {
    if (await this.isInstalled()) {
      console.log('[I2PD] Already installed');
      return;
    }

    console.log('[I2PD] Not found, downloading...');
    await this.download();
  }

  private async download(): Promise<void> {
    const platform = process.platform;
    const url = I2PD_URLS[platform];

    if (!url) {
      throw new Error(`Unsupported platform: ${platform}`);
    }

    this.setState({ status: 'downloading', progress: 0 });

    // Create directories
    if (!fs.existsSync(this.i2pdPath)) {
      fs.mkdirSync(this.i2pdPath, { recursive: true });
    }

    const archiveName = path.basename(url);
    const archivePath = path.join(this.i2pdPath, archiveName);

    console.log('[I2PD] Downloading from:', url);

    // Download the file with redirect handling
    await this.downloadFile(url, archivePath);

    console.log('[I2PD] Extracting...');

    // Extract based on file type
    if (archiveName.endsWith('.zip')) {
      await this.extractZip(archivePath);
    } else if (archiveName.endsWith('.tar.gz')) {
      await this.extractTarGz(archivePath);
    }

    // Clean up archive
    fs.unlinkSync(archivePath);

    // Make executable on Unix
    if (process.platform !== 'win32') {
      const execPath = this.getExecutablePath();
      fs.chmodSync(execPath, 0o755);
    }

    // Create config file
    await this.createConfig();

    console.log('[I2PD] Installation complete');
    this.setState({ status: 'stopped', progress: 100 });
  }

  private downloadFile(url: string, destPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const download = (downloadUrl: string, redirectCount = 0) => {
        if (redirectCount > 5) {
          reject(new Error('Too many redirects'));
          return;
        }

        const protocol = downloadUrl.startsWith('https') ? https : require('http');

        protocol.get(downloadUrl, (response: any) => {
          // Handle redirects
          if (response.statusCode === 301 || response.statusCode === 302) {
            const redirectUrl = response.headers.location;
            console.log('[I2PD] Redirecting to:', redirectUrl);
            download(redirectUrl, redirectCount + 1);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Download failed: HTTP ${response.statusCode}`));
            return;
          }

          const totalSize = parseInt(response.headers['content-length'] || '0', 10);
          let downloadedSize = 0;

          const file = createWriteStream(destPath);

          response.on('data', (chunk: Buffer) => {
            downloadedSize += chunk.length;
            if (totalSize > 0) {
              const progress = Math.round((downloadedSize / totalSize) * 100);
              this.setState({ progress });
            }
          });

          response.pipe(file);

          file.on('finish', () => {
            file.close();
            resolve();
          });

          file.on('error', (err: Error) => {
            fs.unlinkSync(destPath);
            reject(err);
          });
        }).on('error', reject);
      };

      download(url);
    });
  }

  private async extractZip(archivePath: string): Promise<void> {
    // Use PowerShell on Windows to extract zip
    return new Promise((resolve, reject) => {
      const destDir = this.i2pdPath;
      const ps = spawn('powershell', [
        '-NoProfile',
        '-Command',
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force`
      ]);

      ps.on('close', (code) => {
        if (code === 0) {
          // Move files from extracted folder to root if needed
          this.flattenExtractedDir();
          resolve();
        } else {
          reject(new Error(`Extraction failed with code ${code}`));
        }
      });

      ps.on('error', reject);
    });
  }

  private async extractTarGz(archivePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const destDir = this.i2pdPath;
      const tar = spawn('tar', ['-xzf', archivePath, '-C', destDir]);

      tar.on('close', (code) => {
        if (code === 0) {
          this.flattenExtractedDir();
          resolve();
        } else {
          reject(new Error(`Extraction failed with code ${code}`));
        }
      });

      tar.on('error', reject);
    });
  }

  private flattenExtractedDir(): void {
    // Sometimes archives extract into a subdirectory, move files up
    const entries = fs.readdirSync(this.i2pdPath);
    for (const entry of entries) {
      const entryPath = path.join(this.i2pdPath, entry);
      if (fs.statSync(entryPath).isDirectory() && entry.startsWith('i2pd')) {
        // Move all files from subdirectory to i2pdPath
        const subEntries = fs.readdirSync(entryPath);
        for (const subEntry of subEntries) {
          const src = path.join(entryPath, subEntry);
          const dest = path.join(this.i2pdPath, subEntry);
          if (!fs.existsSync(dest)) {
            fs.renameSync(src, dest);
          }
        }
        // Remove empty directory
        try {
          fs.rmdirSync(entryPath, { recursive: true });
        } catch (e) {
          // Ignore
        }
      }
    }
  }

  private async createConfig(): Promise<void> {
    const configPath = path.join(this.i2pdPath, 'i2pd.conf');

    const config = `# I2PD Configuration for I2P Share
# Auto-generated - do not edit manually

# General settings
datadir = ${this.dataPath.replace(/\\/g, '/')}
log = file
logfile = ${path.join(this.i2pdPath, 'i2pd.log').replace(/\\/g, '/')}
loglevel = warn

# Network
ipv4 = true
ipv6 = false
nat = true

# Bandwidth (KB/s) - adjust based on your connection
bandwidth = L

# SAM interface (required for I2P Share)
[sam]
enabled = true
address = 127.0.0.1
port = 7656
portudp = 7655

# HTTP interface (for web console)
[http]
enabled = true
address = 127.0.0.1
port = 7070

# Disable services we don't need
[httpproxy]
enabled = false

[socksproxy]
enabled = false

[bob]
enabled = false

[i2cp]
enabled = false

[i2pcontrol]
enabled = false

[upnp]
enabled = true
`;

    fs.writeFileSync(configPath, config, 'utf-8');
    console.log('[I2PD] Config created at:', configPath);

    // Create data directory
    if (!fs.existsSync(this.dataPath)) {
      fs.mkdirSync(this.dataPath, { recursive: true });
    }
  }

  async start(): Promise<void> {
    if (this.i2pdProcess) {
      console.log('[I2PD] Already running');
      return;
    }

    await this.ensureInstalled();

    const execPath = this.getExecutablePath();
    const configPath = path.join(this.i2pdPath, 'i2pd.conf');

    if (!fs.existsSync(execPath)) {
      throw new Error(`i2pd executable not found at ${execPath}`);
    }

    console.log('[I2PD] Starting daemon...');
    this.setState({ status: 'starting' });

    // Start i2pd process
    this.i2pdProcess = spawn(execPath, ['--conf', configPath], {
      cwd: this.i2pdPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });

    this.i2pdProcess.stdout?.on('data', (data) => {
      console.log('[I2PD]', data.toString().trim());
    });

    this.i2pdProcess.stderr?.on('data', (data) => {
      console.error('[I2PD Error]', data.toString().trim());
    });

    this.i2pdProcess.on('error', (err) => {
      console.error('[I2PD] Process error:', err);
      this.setState({ status: 'error', error: err.message });
      this.i2pdProcess = null;
    });

    this.i2pdProcess.on('exit', (code, signal) => {
      console.log(`[I2PD] Process exited with code ${code}, signal ${signal}`);
      if (this.state.status === 'running') {
        this.setState({ status: 'error', error: 'Process terminated unexpectedly' });
      }
      this.i2pdProcess = null;
    });

    // Wait for SAM to be ready
    await this.waitForSAM();

    this.setState({ status: 'running' });
    console.log('[I2PD] Daemon started successfully');
  }

  private async waitForSAM(timeout = 60000): Promise<void> {
    const startTime = Date.now();
    const net = require('net');

    while (Date.now() - startTime < timeout) {
      try {
        await new Promise<void>((resolve, reject) => {
          const socket = new net.Socket();
          socket.setTimeout(1000);

          socket.on('connect', () => {
            socket.destroy();
            resolve();
          });

          socket.on('error', () => {
            socket.destroy();
            reject(new Error('Connection failed'));
          });

          socket.on('timeout', () => {
            socket.destroy();
            reject(new Error('Connection timeout'));
          });

          socket.connect(7656, '127.0.0.1');
        });

        console.log('[I2PD] SAM bridge is ready');
        return;
      } catch (e) {
        // Wait and retry
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    throw new Error('Timeout waiting for SAM bridge');
  }

  async stop(): Promise<void> {
    if (!this.i2pdProcess) {
      return;
    }

    console.log('[I2PD] Stopping daemon...');

    return new Promise((resolve) => {
      if (!this.i2pdProcess) {
        resolve();
        return;
      }

      this.i2pdProcess.on('exit', () => {
        this.i2pdProcess = null;
        this.setState({ status: 'stopped' });
        resolve();
      });

      // Send SIGTERM on Unix, kill on Windows
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', this.i2pdProcess.pid!.toString(), '/f']);
      } else {
        this.i2pdProcess.kill('SIGTERM');
      }

      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.i2pdProcess) {
          this.i2pdProcess.kill('SIGKILL');
        }
      }, 5000);
    });
  }

  isRunning(): boolean {
    return this.i2pdProcess !== null && this.state.status === 'running';
  }
}

// Singleton
export const i2pdManager = new I2PDManager();
