import React, { useEffect } from 'react';
import { useStore } from '../store';

export function PeersPage() {
  const { peers, fetchPeers, networkStatus } = useStore();

  useEffect(() => {
    fetchPeers();
    const interval = setInterval(fetchPeers, 10000);
    return () => clearInterval(interval);
  }, []);

  const onlinePeers = peers.filter(p => p.isOnline);
  const offlinePeers = peers.filter(p => !p.isOnline);

  return (
    <div className="h-full overflow-y-auto bg-dark-950 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Network Peers</h1>
          <p className="text-dark-400">
            {onlinePeers.length} online, {offlinePeers.length} offline
          </p>
        </div>

        {/* Network stats */}
        <div className="grid grid-cols-4 gap-4 mb-8">
          <div className="card p-4">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full ${networkStatus.isConnected ? 'status-online' : 'status-offline'}`} />
              <div>
                <div className="text-dark-400 text-sm">Status</div>
                <div className="text-lg font-bold text-white">
                  {networkStatus.isConnected ? 'Connected' : 'Disconnected'}
                </div>
              </div>
            </div>
          </div>
          <div className="card p-4">
            <div className="text-dark-400 text-sm mb-1">Active Tunnels</div>
            <div className="text-2xl font-bold text-white">{networkStatus.activeTunnels}</div>
          </div>
          <div className="card p-4">
            <div className="text-dark-400 text-sm mb-1">Known Peers</div>
            <div className="text-2xl font-bold text-white">{peers.length}</div>
          </div>
          <div className="card p-4">
            <div className="text-dark-400 text-sm mb-1">Online Now</div>
            <div className="text-2xl font-bold text-green-400">{onlinePeers.length}</div>
          </div>
        </div>

        {/* Online peers */}
        {onlinePeers.length > 0 && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full status-online" />
              Online Peers
            </h2>
            <div className="grid grid-cols-2 gap-4">
              {onlinePeers.map(peer => (
                <PeerCard key={peer.peerId} peer={peer} />
              ))}
            </div>
          </section>
        )}

        {/* Offline peers */}
        {offlinePeers.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-dark-500" />
              Recently Seen
            </h2>
            <div className="grid grid-cols-2 gap-4">
              {offlinePeers.map(peer => (
                <PeerCard key={peer.peerId} peer={peer} />
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {peers.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-24 h-24 rounded-full bg-dark-800 flex items-center justify-center mb-6">
              <svg className="w-12 h-12 text-dark-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">No Peers Found</h3>
            <p className="text-dark-400 text-center max-w-md">
              {networkStatus.isConnected
                ? 'Discovering peers on the network...'
                : 'Connect to the I2P network to discover peers'}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

interface PeerCardProps {
  peer: {
    peerId: string;
    displayName: string;
    filesCount: number;
    totalSize: number;
    isOnline: boolean;
    lastSeen: number;
  };
}

function PeerCard({ peer }: PeerCardProps) {
  // Generate a consistent color based on peer ID
  const colors = [
    'from-blue-500 to-purple-500',
    'from-green-500 to-teal-500',
    'from-orange-500 to-red-500',
    'from-pink-500 to-rose-500',
    'from-cyan-500 to-blue-500',
    'from-amber-500 to-orange-500',
  ];
  const colorIndex = peer.peerId.charCodeAt(0) % colors.length;
  const gradientClass = colors[colorIndex];

  return (
    <div className={`card p-4 ${peer.isOnline ? 'border-green-500/20' : ''}`}>
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${gradientClass} flex items-center justify-center text-white font-bold text-lg`}>
          {peer.displayName.charAt(0).toUpperCase()}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-white truncate">{peer.displayName}</h3>
            {peer.isOnline && (
              <div className="w-2 h-2 rounded-full status-online" />
            )}
          </div>
          <div className="text-sm text-dark-400 mt-1">
            {peer.filesCount.toLocaleString()} files ({formatBytes(peer.totalSize)})
          </div>
          {!peer.isOnline && (
            <div className="text-xs text-dark-500 mt-1">
              Last seen: {formatTimeAgo(peer.lastSeen)}
            </div>
          )}
        </div>

        {/* Actions */}
        {peer.isOnline && (
          <button className="btn btn-ghost p-2" title="Browse files">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() / 1000) - timestamp);

  const intervals = [
    { label: 'year', seconds: 31536000 },
    { label: 'month', seconds: 2592000 },
    { label: 'week', seconds: 604800 },
    { label: 'day', seconds: 86400 },
    { label: 'hour', seconds: 3600 },
    { label: 'minute', seconds: 60 },
  ];

  for (const interval of intervals) {
    const count = Math.floor(seconds / interval.seconds);
    if (count >= 1) {
      return `${count} ${interval.label}${count !== 1 ? 's' : ''} ago`;
    }
  }

  return 'Just now';
}
