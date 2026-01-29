import * as esbuild from 'esbuild';
import fs from 'fs';
import path from 'path';

const isWatch = process.argv.includes('--watch');

// Copy sql-wasm.wasm to dist/main
function copySqlWasm() {
  const src = 'node_modules/sql.js/dist/sql-wasm.wasm';
  const dest = 'dist/main/sql-wasm.wasm';
  fs.mkdirSync('dist/main', { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('Copied sql-wasm.wasm to dist/main');
}

const buildOptions = {
  entryPoints: ['src/main/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/main/main.mjs',
  external: [
    'better-sqlite3',
    'electron-store',
    'webtorrent',
    '@diva.exchange/i2p-sam'
  ],
  sourcemap: true,
  tsconfig: 'tsconfig.main.json',
  logLevel: 'info',
  banner: {
    js: `
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
`
  }
};

const preloadBuildOptions = {
  entryPoints: ['src/main/preload.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/main/preload.cjs',
  external: ['electron'],
  sourcemap: true,
  tsconfig: 'tsconfig.main.json',
  logLevel: 'info'
};

async function build() {
  try {
    // Copy WASM file before building
    copySqlWasm();

    if (isWatch) {
      const mainCtx = await esbuild.context(buildOptions);
      const preloadCtx = await esbuild.context(preloadBuildOptions);
      await Promise.all([mainCtx.watch(), preloadCtx.watch()]);
      console.log('Watching for changes...');
    } else {
      await Promise.all([
        esbuild.build(buildOptions),
        esbuild.build(preloadBuildOptions)
      ]);
      console.log('Build completed successfully');
    }
  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

build();
