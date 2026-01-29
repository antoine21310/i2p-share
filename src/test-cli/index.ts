#!/usr/bin/env node

/**
 * I2P-Share Test CLI
 * Automated testing tool that simulates 2 PCs communicating via I2P
 */

import { TestRunner } from './test-runner.js';

const args = process.argv.slice(2);

// Parse command line arguments
interface Config {
  testDataDir: string;
  samHost: string;
  samPortTCP: number;
  samPortUDP: number;
  skipI2pd: boolean;
}

const config: Partial<Config> = {};

function printHelp(): void {
  console.log(`
I2P-Share Test CLI
==================

Automated testing tool that simulates 2 PCs communicating via I2P.
This will test: tracker connection, peer discovery, file sharing, search, and download.

Usage: npm run test:cli [options]

Options:
  --test-data <dir>     Test data directory (default: ./test-data)
  --sam-host <host>     SAM bridge host (default: 127.0.0.1)
  --sam-port-tcp <port> SAM TCP port (default: 7656)
  --sam-port-udp <port> SAM UDP port (default: 7655)
  --no-i2pd             Don't auto-start i2pd (use existing instance)
  -h, --help            Show this help message

Examples:
  npm run test:cli
  npm run test:cli -- --no-i2pd
  npm run test:cli -- --test-data ./my-test-data

What the tests do:
  1. Start i2pd (or use existing)
  2. Start a tracker server
  3. Create Client A (simulated PC 1)
  4. Create Client B (simulated PC 2)
  5. Both clients connect to the tracker
  6. Test peer discovery
  7. Client A shares files
  8. Client B searches for files
  9. Client B downloads a file from Client A
  10. Test bidirectional communication

Requirements:
  - i2pd must be installed and accessible, OR already running
  - Network connectivity
`);
}

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--test-data':
      config.testDataDir = args[++i];
      break;
    case '--sam-host':
      config.samHost = args[++i];
      break;
    case '--sam-port-tcp':
      config.samPortTCP = parseInt(args[++i], 10);
      break;
    case '--sam-port-udp':
      config.samPortUDP = parseInt(args[++i], 10);
      break;
    case '--no-i2pd':
      config.skipI2pd = true;
      break;
    case '--help':
    case '-h':
      printHelp();
      process.exit(0);
  }
}

async function main(): Promise<void> {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║     I2P-Share Test CLI                 ║');
  console.log('║     Simulating 2 PCs via I2P           ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');

  const runner = new TestRunner(config);

  // Handle shutdown
  const shutdown = async () => {
    console.log('\n\nShutting down...');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await runner.run();
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
