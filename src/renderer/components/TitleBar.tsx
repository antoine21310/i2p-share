import React from 'react';
import { useStore } from '../store';

export function TitleBar() {
  const { networkStatus } = useStore();

  const handleMinimize = () => window.electron.minimizeWindow();
  const handleMaximize = () => window.electron.maximizeWindow();
  const handleClose = () => window.electron.closeWindow();

  return (
    <div className="h-12 bg-dark-900 border-b border-dark-800 flex items-center justify-between px-4 drag-region">
      {/* Left side - App name and status */}
      <div className="flex items-center gap-3 no-drag">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center">
            <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
            </svg>
          </div>
          <span className="font-bold text-lg gradient-text">I2P Share</span>
        </div>

        {/* Connection status */}
        <div className="flex items-center gap-2 ml-4">
          <div className={`w-2 h-2 rounded-full ${
            networkStatus.isConnected
              ? 'status-online'
              : networkStatus.statusText?.includes('Error')
                ? 'bg-red-500'
                : 'bg-yellow-500 animate-pulse'
          }`} />
          <span className="text-sm text-dark-400">
            {networkStatus.isConnected
              ? `${networkStatus.peersConnected || 0} online`
              : networkStatus.statusText || 'Connecting...'}
          </span>
          {networkStatus.isConnected && (networkStatus.peersTotal || 0) > 0 && (
            <span className="text-sm text-dark-500">
              / {networkStatus.peersTotal} known
            </span>
          )}
        </div>
      </div>

      {/* Center - Network stats */}
      {networkStatus.isConnected && (
        <div className="flex items-center gap-6 text-sm text-dark-400">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
            </svg>
            <span>{formatSpeed(networkStatus.downloadSpeed)}</span>
          </div>
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
            </svg>
            <span>{formatSpeed(networkStatus.uploadSpeed)}</span>
          </div>
        </div>
      )}

      {/* Right side - Window controls */}
      <div className="flex items-center gap-1 no-drag">
        <button
          onClick={handleMinimize}
          className="w-10 h-8 flex items-center justify-center rounded hover:bg-dark-700 transition-colors"
        >
          <svg className="w-4 h-4 text-dark-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
          </svg>
        </button>
        <button
          onClick={handleMaximize}
          className="w-10 h-8 flex items-center justify-center rounded hover:bg-dark-700 transition-colors"
        >
          <svg className="w-4 h-4 text-dark-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
          </svg>
        </button>
        <button
          onClick={handleClose}
          className="w-10 h-8 flex items-center justify-center rounded hover:bg-red-600 transition-colors"
        >
          <svg className="w-4 h-4 text-dark-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}
