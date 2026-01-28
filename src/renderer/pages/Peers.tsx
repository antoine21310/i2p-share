import React, { useEffect, useState } from 'react';
import { useStore } from '../store';

interface PeerFile {
  filename: string;
  hash: string;
  size: number;
  mimeType?: string;
}

export function PeersPage() {
  const { peers, fetchPeers, networkStatus } = useStore();
  const [selectedPeer, setSelectedPeer] = useState<string | null>(null);
  const [peerFiles, setPeerFiles] = useState<PeerFile[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);

  useEffect(() => {
    fetchPeers();
    const interval = setInterval(fetchPeers, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleViewFiles = async (peerId: string) => {
    if (selectedPeer === peerId) {
      // Toggle off
      setSelectedPeer(null);
      setPeerFiles([]);
      return;
    }

    setSelectedPeer(peerId);
    setLoadingFiles(true);

    try {
      // First try to get cached files
      const files = await window.electron.getPeerFiles(peerId);
      setPeerFiles(files || []);

      // Also request fresh files from peer
      await window.electron.requestPeerFiles(peerId);

      // Refetch after a delay to get updated list
      setTimeout(async () => {
        const freshFiles = await window.electron.getPeerFiles(peerId);
        if (freshFiles && freshFiles.length > 0) {
          setPeerFiles(freshFiles);
        }
        setLoadingFiles(false);
      }, 2000);
    } catch (error) {
      console.error('Failed to get peer files:', error);
      setLoadingFiles(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-dark-950 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Network Peers</h1>
          <p className="text-dark-400">
            {peers.length} peer{peers.length !== 1 ? 's' : ''} online
          </p>
        </div>

        {/* Network stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
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
            <div className="text-dark-400 text-sm mb-1">Online Peers</div>
            <div className="text-2xl font-bold text-green-400">{peers.length}</div>
          </div>
        </div>

        {/* Online peers */}
        {peers.length > 0 && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full status-online" />
              Connected Peers
            </h2>
            <div className="space-y-4">
              {peers.map(peer => (
                <div key={peer.peerId}>
                  <PeerCard
                    peer={peer}
                    isExpanded={selectedPeer === peer.peerId}
                    onViewFiles={() => handleViewFiles(peer.peerId)}
                  />
                  {selectedPeer === peer.peerId && (
                    <PeerFilesPanel
                      files={peerFiles}
                      loading={loadingFiles}
                      peerName={peer.displayName}
                      peerId={peer.peerId}
                      streamingDestination={(peer as any).streamingDestination}
                    />
                  )}
                </div>
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
                ? 'Waiting for peers to connect via the tracker...'
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
    b32Address?: string;
    streamingDestination?: string; // For I2P Streaming file transfers
  };
  isExpanded: boolean;
  onViewFiles: () => void;
}

function PeerCard({ peer, isExpanded, onViewFiles }: PeerCardProps) {
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
    <div className={`card p-4 border-green-500/20 ${isExpanded ? 'border-primary-500/50' : ''}`}>
      <div className="flex items-start gap-4">
        {/* Avatar */}
        <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${gradientClass} flex items-center justify-center text-white font-bold text-lg`}>
          {peer.displayName.charAt(0).toUpperCase()}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-white truncate">{peer.displayName}</h3>
            <div className="w-2 h-2 rounded-full status-online" />
          </div>
          <div className="text-sm text-dark-400 mt-1">
            {peer.filesCount.toLocaleString()} files ({formatBytes(peer.totalSize)})
          </div>
          {peer.b32Address && (
            <div className="text-xs text-dark-500 mt-1 font-mono truncate">
              {peer.b32Address.substring(0, 24)}...
            </div>
          )}
        </div>

        {/* Actions */}
        <button
          onClick={onViewFiles}
          className={`btn ${isExpanded ? 'btn-primary' : 'btn-ghost'} p-2`}
          title="Browse files"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

interface PeerFilesPanelProps {
  files: PeerFile[];
  loading: boolean;
  peerName: string;
  peerId: string;
  streamingDestination?: string; // For I2P Streaming file transfers
}

function PeerFilesPanel({ files, loading, peerName, peerId, streamingDestination }: PeerFilesPanelProps) {
  const { startDownload } = useStore();

  const handleDownload = (file: PeerFile) => {
    startDownload({
      filename: file.filename,
      fileHash: file.hash,
      size: file.size,
      mimeType: file.mimeType || 'application/octet-stream',
      peerId: peerId,
      peerDisplayName: peerName,
      addedAt: Date.now(),
      streamingDestination: streamingDestination // For I2P Streaming file transfers
    });
  };

  return (
    <div className="mt-2 ml-16 card p-4 bg-dark-900/50">
      <h4 className="text-sm font-medium text-dark-300 mb-3">
        {peerName}'s Files
      </h4>

      {loading && (
        <div className="flex items-center justify-center py-8">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-primary-500 border-t-transparent" />
          <span className="ml-2 text-dark-400 text-sm">Loading files...</span>
        </div>
      )}

      {!loading && files.length === 0 && (
        <div className="text-center py-8 text-dark-500 text-sm">
          No files found. The peer may not have responded yet.
        </div>
      )}

      {!loading && files.length > 0 && (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {files.map((file, index) => (
            <div
              key={`${file.hash}-${index}`}
              className="flex items-center justify-between p-2 rounded-lg hover:bg-dark-800/50 group"
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <FileIcon mimeType={file.mimeType} />
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">{file.filename}</div>
                  <div className="text-xs text-dark-500">{formatBytes(file.size)}</div>
                </div>
              </div>
              <button
                onClick={() => handleDownload(file)}
                className="btn btn-ghost p-1.5 opacity-0 group-hover:opacity-100 transition-opacity"
                title="Download"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FileIcon({ mimeType }: { mimeType?: string }) {
  const type = mimeType?.split('/')[0] || 'file';

  const icons: Record<string, JSX.Element> = {
    image: (
      <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
    video: (
      <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
    ),
    audio: (
      <svg className="w-5 h-5 text-pink-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
      </svg>
    ),
    text: (
      <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
    application: (
      <svg className="w-5 h-5 text-orange-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
      </svg>
    ),
  };

  return icons[type] || icons.application;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}
