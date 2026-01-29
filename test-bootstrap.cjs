// Test what require('electron') returns in CJS context
const electron = require('electron');

console.log('=== CJS Bootstrap Test ===');
console.log('typeof electron:', typeof electron);
console.log('electron value:', electron);
console.log('electron.app:', electron.app);
console.log('process.type:', process.type);
console.log('process.versions.electron:', process.versions.electron);
