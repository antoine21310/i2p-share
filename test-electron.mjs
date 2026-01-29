import * as electronNs from 'electron';
import electronDefault from 'electron';

console.log('=== import * as electron ===');
console.log('electronNs:', typeof electronNs);
console.log('electronNs keys:', Object.keys(electronNs));

console.log('\n=== import electron (default) ===');
console.log('electronDefault:', typeof electronDefault);
console.log('electronDefault keys:', Object.keys(electronDefault || {}));

// Check process.type to verify we're in Electron main
console.log('\n=== Environment ===');
console.log('process.type:', process.type);
console.log('process.versions.electron:', process.versions.electron);

// Try require
console.log('\n=== Dynamic require ===');
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
try {
  const electronReq = require('electron');
  console.log('require electron:', typeof electronReq);
  console.log('require electron keys:', Object.keys(electronReq || {}));
  console.log('require electron.app:', electronReq?.app);
} catch (e) {
  console.log('require failed:', e.message);
}
