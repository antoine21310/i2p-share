import { EventEmitter } from 'events';
import { createRaw, createLocalDestination, toB32 } from '@diva.exchange/i2p-sam';

interface I2PConfig {
  samHost: string;
  samPortTCP: number;
  samPortUDP: number;
  listenPort: number;
}

interface I2PConnectionState {
  isConnected: boolean;
  destination: string;
  b32Address: string;
  error?: string;
}

export class I2PConnection extends EventEmitter {
  private config: I2PConfig;
  private sam: any = null;
  private destination: string = '';
  private b32Address: string = '';
  private publicKey: string = '';
  private privateKey: string = '';
  private isConnectedFlag: boolean = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: Partial<I2PConfig> = {}) {
    super();
    this.config = {
      samHost: config.samHost || '127.0.0.1',
      samPortTCP: config.samPortTCP || 7656,
      samPortUDP: config.samPortUDP || 7655,
      listenPort: config.listenPort || 0 // 0 = random port
    };
  }

  async connect(): Promise<I2PConnectionState> {
    console.log('[I2P] Connecting to SAM bridge at', `${this.config.samHost}:${this.config.samPortTCP}`);

    try {
      // First, create a local destination (keypair)
      console.log('[I2P] Creating local destination...');
      const destInfo = await createLocalDestination({
        sam: {
          host: this.config.samHost,
          portTCP: this.config.samPortTCP
        }
      });

      // Note: In i2p-sam library:
      // - destInfo.public = full I2P destination (base64, ~400 chars)
      // - destInfo.address = b32 address (short hash)
      // We need the FULL destination for SAM communication
      this.destination = destInfo.public;
      this.publicKey = destInfo.public;
      this.privateKey = destInfo.private;
      this.b32Address = destInfo.address;

      console.log('[I2P] Destination created:', this.b32Address);

      // Now create the RAW session for datagram communication
      console.log('[I2P] Creating RAW session...');
      this.sam = await createRaw({
        sam: {
          host: this.config.samHost,
          portTCP: this.config.samPortTCP,
          portUDP: this.config.samPortUDP,
          publicKey: this.publicKey,
          privateKey: this.privateKey
        },
        listen: {
          address: '127.0.0.1',
          port: this.config.listenPort || 7660 + Math.floor(Math.random() * 100)
        }
      });

      // Set up event handlers for the new API
      this.sam.on('data', (msg: Buffer) => {
        this.handleIncomingData(msg);
      });

      this.sam.on('close', () => {
        console.log('[I2P] Session closed');
        this.handleDisconnect();
      });

      this.sam.on('error', (error: Error) => {
        console.error('[I2P] Session error:', error.message);
      });

      console.log('[I2P] RAW session created successfully');
      console.log('[I2P] Your I2P address:', this.b32Address);

      this.isConnectedFlag = true;
      this.emit('connected', {
        destination: this.destination,
        b32Address: this.b32Address
      });

      return {
        isConnected: true,
        destination: this.destination,
        b32Address: this.b32Address
      };

    } catch (error: any) {
      console.error('[I2P] Connection failed:', error.message);
      this.isConnectedFlag = false;

      let errorMsg = error.message;
      if (error.code === 'ECONNREFUSED') {
        errorMsg = 'I2P router not running. Starting i2pd...';
      }

      // Schedule reconnection attempt
      this.scheduleReconnect();

      return {
        isConnected: false,
        destination: '',
        b32Address: '',
        error: errorMsg
      };
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    console.log('[I2P] Scheduling reconnection in 10 seconds...');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      console.log('[I2P] Attempting reconnection...');
      await this.connect();
    }, 10000);
  }

  private handleDisconnect(): void {
    this.isConnectedFlag = false;
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  private handleIncomingData(data: Buffer): void {
    try {
      // The message format from I2P includes the sender
      // Try to parse as JSON message
      const str = data.toString();

      // Check if it's a JSON message
      if (str.startsWith('{')) {
        const message = JSON.parse(str);
        const from = message._from || 'unknown';
        delete message._from;
        this.emit('message', { from, message });
      } else {
        // Binary data
        this.emit('data', { from: 'unknown', data });
      }
    } catch (e) {
      // Raw binary data
      this.emit('data', { from: 'unknown', data });
    }
  }

  async sendMessage(destination: string, message: object): Promise<boolean> {
    if (!this.isConnectedFlag || !this.sam) {
      console.error('[I2P] Cannot send: not connected');
      return false;
    }

    try {
      // Add our address to the message so recipient knows who sent it
      const msgWithSender = {
        ...message,
        _from: this.destination
      };

      const data = Buffer.from(JSON.stringify(msgWithSender));
      this.sam.send(destination, data);
      return true;
    } catch (error: any) {
      console.error('[I2P] Send failed:', error.message);
      return false;
    }
  }

  async sendData(destination: string, data: Buffer): Promise<boolean> {
    if (!this.isConnectedFlag || !this.sam) {
      console.error('[I2P] Cannot send: not connected');
      return false;
    }

    try {
      this.sam.send(destination, data);
      return true;
    } catch (error: any) {
      console.error('[I2P] Send data failed:', error.message);
      return false;
    }
  }

  getState(): I2PConnectionState {
    return {
      isConnected: this.isConnectedFlag,
      destination: this.destination,
      b32Address: this.b32Address
    };
  }

  getDestination(): string {
    return this.destination;
  }

  getB32Address(): string {
    return this.b32Address;
  }

  isReady(): boolean {
    return this.isConnectedFlag && !!this.sam;
  }

  async disconnect(): Promise<void> {
    console.log('[I2P] Disconnecting...');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Properly close the SAM session
    if (this.sam) {
      try {
        this.sam.close();
      } catch (e) {
        // Ignore close errors
      }
    }

    this.sam = null;
    this.isConnectedFlag = false;
    this.destination = '';
    this.b32Address = '';

    this.emit('disconnected');
  }
}

// Singleton instance
export const i2pConnection = new I2PConnection();
