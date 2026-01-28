#!/usr/bin/env node

import { TrackerServer } from './tracker-server';
import { I2PDManagerStandalone } from './i2pd-manager-standalone';

const args = process.argv.slice(2);

// Parse command line arguments
const config: any = {};
let skipI2pd = false;

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--sam-host':
      config.samHost = args[++i];
      break;
    case '--sam-port-tcp':
      config.samPortTCP = parseInt(args[++i], 10);
      break;
    case '--sam-port-udp':
      config.samPortUDP = parseInt(args[++i], 10);
      break;
    case '--listen-port':
      config.listenPort = parseInt(args[++i], 10);
      break;
    case '--peer-timeout':
      config.peerTimeout = parseInt(args[++i], 10) * 1000; // Convert to ms
      break;
    case '--no-i2pd':
      skipI2pd = true;
      break;
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
  }
}

function printHelp(): void {
  console.log(`
I2P Share Tracker Server
========================

A standalone tracker server for I2P Share peer discovery.

Usage: npm run tracker [options]

Options:
  --sam-host <host>       SAM bridge host (default: 127.0.0.1)
  --sam-port-tcp <port>   SAM TCP port (default: 7656)
  --sam-port-udp <port>   SAM UDP port (default: 7655)
  --listen-port <port>    Local listen port (default: 7670)
  --peer-timeout <secs>   Peer timeout in seconds (default: 300)
  --no-i2pd               Don't auto-start i2pd (use existing instance)
  -h, --help              Show this help message

Example:
  npm run tracker
  npm run tracker -- --no-i2pd
  npm run tracker -- --sam-host 192.168.1.100 --listen-port 7680

The tracker will display its I2P address when started.
Share this address with users so their clients can discover each other.
`);
}

async function main(): Promise<void> {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║     I2P Share - Tracker Server         ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  const i2pdManager = new I2PDManagerStandalone();
  const tracker = new TrackerServer(config);

  // Handle shutdown
  const shutdown = async () => {
    console.log('\n[Tracker] Shutting down...');
    await tracker.stop();
    if (!skipI2pd) {
      await i2pdManager.stop();
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Start i2pd if needed
  if (!skipI2pd) {
    console.log('[Tracker] Checking i2pd/SAM availability...');
    try {
      await i2pdManager.start();
    } catch (error: any) {
      console.error('[Tracker] Warning: Could not start i2pd:', error.message);

      // Check if SAM is available anyway
      const samAvailable = await i2pdManager.isSAMAvailable();
      if (!samAvailable) {
        console.error('[Tracker] SAM bridge not available. Please start i2pd manually or check your installation.');
        console.log('[Tracker] Tip: Use --no-i2pd if i2pd is already running');
        process.exit(1);
      }
      console.log('[Tracker] SAM bridge is available, continuing...');
    }
  } else {
    console.log('[Tracker] Skipping i2pd startup (--no-i2pd flag)');
  }

  // Start the tracker
  const result = await tracker.start();

  if (!result.success) {
    console.error('[Tracker] Failed to start:', result.error);
    if (!skipI2pd) {
      await i2pdManager.stop();
    }
    process.exit(1);
  }

  console.log('');
  console.log('[Tracker] Press Ctrl+C to stop');
  console.log('');
}

main().catch((error) => {
  console.error('[Tracker] Fatal error:', error);
  process.exit(1);
});
