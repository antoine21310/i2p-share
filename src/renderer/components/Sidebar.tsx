import React from 'react';
import { useStore } from '../store';

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
  const { downloads, networkStatus } = useStore();

  const activeDownloads = downloads.filter(d => d.status === 'downloading').length;

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

      {/* Network status card */}
      <div className="p-4">
        <div className="card p-4">
          <div className="flex items-center gap-3 mb-3">
            <div className={`w-3 h-3 rounded-full ${networkStatus.isConnected ? 'status-online' : 'status-offline'}`} />
            <span className="font-medium text-white">
              {networkStatus.isConnected ? 'Connected' : 'Disconnected'}
            </span>
          </div>

          {networkStatus.isConnected && (
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-dark-400">
                <span>Active Tunnels</span>
                <span className="text-white">{networkStatus.activeTunnels}</span>
              </div>
              <div className="flex justify-between text-dark-400">
                <span>Peers Online</span>
                <span className="text-white">{networkStatus.peersConnected}</span>
              </div>
            </div>
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
