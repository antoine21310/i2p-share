#!/usr/bin/env node

import { TrackerServer } from './tracker-server';

const args = process.argv.slice(2);

// Parse command line arguments
const config: any = {};

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
  -h, --help              Show this help message

Example:
  npm run tracker
  npm run tracker -- --sam-host 192.168.1.100 --listen-port 7680

The tracker will display its I2P address (.b32.i2p) when started.
Share this address with users so their clients can discover each other.
`);
}

async function main(): Promise<void> {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║     I2P Share - Tracker Server         ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  const tracker = new TrackerServer(config);

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Tracker] Shutting down...');
    await tracker.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Tracker] Shutting down...');
    await tracker.stop();
    process.exit(0);
  });

  // Start the tracker
  const result = await tracker.start();

  if (!result.success) {
    console.error('[Tracker] Failed to start:', result.error);
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
