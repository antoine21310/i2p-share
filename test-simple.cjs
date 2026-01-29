// Minimal test
console.log('Script starting...');
console.log('process.type:', process.type);
console.log('process.versions.electron:', process.versions.electron);

const electron = require('electron');
console.log('typeof electron:', typeof electron);

if (typeof electron === 'object' && electron.app) {
  console.log('Electron API available!');
  electron.app.whenReady().then(() => {
    console.log('App ready!');
    electron.app.quit();
  });
} else {
  console.log('Electron API NOT available. Value:', electron);
  process.exit(1);
}
