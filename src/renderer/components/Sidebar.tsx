import React from 'react';
import { useStore } from '../store';
import { formatSpeed } from '../utils/format';

type Page = 'search' | 'downloads' | 'shares' | 'peers' | 'settings';

interface SidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
}

interface NavItem {
  id: Page;
  label: string;
  icon: React.ReactNode;
  badge?: number;
}

export function Sidebar({ currentPage, onPageChange }: SidebarProps) {
  const { downloads, networkStatus, indexingProgress, connectionError } = useStore();

  const activeDownloads = downloads.filter(d =>
    ['pending', 'connecting', 'downloading'].includes(d.status)
  ).length;

  const navItems: NavItem[] = [
    {
      id: 'search',
      label: 'Search',
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      )
    },
    {
      id: 'downloads',
      label: 'Downloads',
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      ),
      badge: activeDownloads > 0 ? activeDownloads : undefined
    },
    {
      id: 'shares',
      label: 'My Shares',
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
        </svg>
      )
    },
    {
      id: 'peers',
      label: 'Peers',
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
        </svg>
      ),
      badge: networkStatus.peersConnected > 0 ? networkStatus.peersConnected : undefined
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: (
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      )
    }
  ];

  // Determine connection state
  const getConnectionState = () => {
    if (connectionError) {
      return { status: 'error', color: 'bg-red-500', text: 'Error' };
    }
    if (networkStatus.statusText?.includes('Downloading')) {
      return { status: 'downloading', color: 'bg-yellow-500 animate-pulse', text: 'Downloading I2P...' };
    }
    if (networkStatus.statusText?.includes('Starting')) {
      return { status: 'starting', color: 'bg-yellow-500 animate-pulse', text: 'Starting...' };
    }
    if (networkStatus.statusText?.includes('Connecting')) {
      return { status: 'connecting', color: 'bg-blue-500 animate-pulse', text: 'Connecting...' };
    }
    if (networkStatus.isConnected) {
      return { status: 'connected', color: 'bg-green-500', text: 'Connected' };
    }
    return { status: 'disconnected', color: 'bg-dark-500', text: 'Disconnected' };
  };

  const connState = getConnectionState();

  return (
    <aside className="w-64 bg-dark-900 border-r border-dark-800 flex flex-col">
      {/* Navigation */}
      <nav className="flex-1 p-4 space-y-2">
        {navItems.map(item => (
          <button
            key={item.id}
            onClick={() => onPageChange(item.id)}
            className={`
              w-full flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200
              ${currentPage === item.id
                ? 'bg-gradient-to-r from-primary-500/20 to-purple-500/20 text-white border border-primary-500/30'
                : 'text-dark-400 hover:text-white hover:bg-dark-800'
              }
            `}
          >
            <span className={currentPage === item.id ? 'text-primary-400' : ''}>{item.icon}</span>
            <span className="flex-1 text-left font-medium">{item.label}</span>
            {item.badge && (
              <span className="px-2 py-0.5 text-xs font-bold rounded-full bg-primary-500 text-white">
                {item.badge}
              </span>
            )}
          </button>
        ))}
      </nav>

      {/* Indexing progress (if active) */}
      {indexingProgress && (
        <div className="px-4 pb-2">
          <div className="card p-3 bg-blue-500/10 border-blue-500/30">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-blue-400 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-sm font-medium text-blue-400">Indexing files...</span>
            </div>
            <div className="text-xs text-dark-400 truncate mb-1">
              {indexingProgress.currentFile || indexingProgress.folder}
            </div>
            <div className="h-1 bg-dark-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300"
                style={{
                  width: indexingProgress.total > 0
                    ? `${(indexingProgress.current / indexingProgress.total) * 100}%`
                    : '0%'
                }}
              />
            </div>
            {indexingProgress.total > 0 && (
              <p className="text-xs text-dark-500 mt-1">
                {indexingProgress.current} / {indexingProgress.total} files
              </p>
            )}
          </div>
        </div>
      )}

      {/* Network status card */}
      <div className="p-4">
        <div className="card p-4">
          {/* Connection status header */}
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-3 h-3 rounded-full ${connState.color}`} />
            <span className="font-medium text-white flex-1">
              {connState.text}
            </span>
            {connState.status === 'connected' && (
              <span className="text-xs text-dark-500">
                {networkStatus.statusText?.match(/\(([^)]+)\)/)?.[1] || ''}
              </span>
            )}
          </div>

          {/* Error message */}
          {connectionError && (
            <div className="mb-3 p-2 bg-red-500/10 border border-red-500/30 rounded text-xs text-red-400">
              {connectionError}
            </div>
          )}

          {/* Connected stats */}
          {networkStatus.isConnected && (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-dark-400">
                <span>Tunnels</span>
                <span className="text-white">{networkStatus.activeTunnels}</span>
              </div>
              <div className="flex justify-between text-dark-400">
                <span>Peers</span>
                <span className="text-white">{networkStatus.peersConnected}</span>
              </div>
              {(networkStatus.uploadSpeed > 0 || networkStatus.downloadSpeed > 0) && (
                <>
                  <div className="border-t border-dark-700 my-2" />
                  {networkStatus.downloadSpeed > 0 && (
                    <div className="flex justify-between text-dark-400">
                      <span className="flex items-center gap-1">
                        <svg className="w-3 h-3 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                        </svg>
                        Down
                      </span>
                      <span className="text-green-400">{formatSpeed(networkStatus.downloadSpeed)}</span>
                    </div>
                  )}
                  {networkStatus.uploadSpeed > 0 && (
                    <div className="flex justify-between text-dark-400">
                      <span className="flex items-center gap-1">
                        <svg className="w-3 h-3 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                        Up
                      </span>
                      <span className="text-blue-400">{formatSpeed(networkStatus.uploadSpeed)}</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Disconnected state */}
          {!networkStatus.isConnected && !connectionError && connState.status === 'disconnected' && (
            <p className="text-xs text-dark-500">
              Waiting to connect to I2P network...
            </p>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-dark-800">
        <div className="text-center">
          <p className="text-xs text-dark-500">I2P Share v1.0.0</p>
          <p className="text-xs text-dark-600 mt-1">Anonymous P2P File Sharing</p>
        </div>
      </div>
    </aside>
  );
}
