import React, { useEffect, useState } from 'react';
import { useStore } from '../store';

interface ScanProgress {
  folder: string;
  scanned: number;
  total: number;
  currentFile: string;
}

interface ActiveUpload {
  sessionId: string;
  filename: string;
  totalSize: number;
  bytesSent: number;
  speed: number;
  progress: number;
  isPaused: boolean;
}

export function MySharesPage() {
  const { sharedFolders, sharedFiles, fetchSharedFolders, fetchSharedFiles, addSharedFolder, removeSharedFolder } = useStore();
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [activeUploads, setActiveUploads] = useState<ActiveUpload[]>([]);

  useEffect(() => {
    fetchSharedFolders();
    fetchSharedFiles();

    // Poll for active uploads
    const fetchUploads = async () => {
      try {
        const uploads = await window.electron.getActiveUploads();
        setActiveUploads(uploads.filter((u: ActiveUpload) => !u.isPaused && u.progress < 100));
      } catch (error) {
        console.error('Error fetching active uploads:', error);
      }
    };
    fetchUploads();
    const uploadInterval = setInterval(fetchUploads, 1000);

    // Listen for scan events
    const unsubStart = window.electron.on('scan:start', (data: { folder: string; total: number }) => {
      setScanProgress({ folder: data.folder, scanned: 0, total: data.total, currentFile: '' });
    });

    const unsubProgress = window.electron.on('scan:progress', (data: ScanProgress) => {
      setScanProgress(data);
      // Refresh file counts periodically during scan
      if (data.scanned % 20 === 0) {
        fetchSharedFiles();
        fetchSharedFolders();
      }
    });

    const unsubComplete = window.electron.on('scan:complete', () => {
      setScanProgress(null);
      fetchSharedFolders();
      fetchSharedFiles();
    });

    return () => {
      unsubStart();
      unsubProgress();
      unsubComplete();
      clearInterval(uploadInterval);
    };
  }, []);

  const totalFiles = sharedFiles.length;
  const totalSize = sharedFiles.reduce((sum, f) => sum + (f.size || 0), 0);

  const handleAddFolder = async () => {
    await addSharedFolder();
  };

  const handleRemoveFolder = async (path: string) => {
    if (confirm(`Remove "${path}" from shared folders?`)) {
      await removeSharedFolder(path);
    }
  };

  return (
    <div className="h-full overflow-y-auto bg-dark-950 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-white mb-2">My Shares</h1>
            <p className="text-dark-400">
              Sharing {totalFiles.toLocaleString()} files ({formatBytes(totalSize)})
            </p>
          </div>
          <button onClick={handleAddFolder} className="btn btn-primary flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
            </svg>
            Add Folder
          </button>
        </div>

        {/* Stats cards */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="card p-4">
            <div className="text-dark-400 text-sm mb-1">Total Files</div>
            <div className="text-2xl font-bold text-white">{totalFiles.toLocaleString()}</div>
          </div>
          <div className="card p-4">
            <div className="text-dark-400 text-sm mb-1">Total Size</div>
            <div className="text-2xl font-bold text-white">{formatBytes(totalSize)}</div>
          </div>
          <div className="card p-4">
            <div className="text-dark-400 text-sm mb-1">Shared Folders</div>
            <div className="text-2xl font-bold text-white">{sharedFolders.length}</div>
          </div>
        </div>

        {/* Scanning progress */}
        {scanProgress && (
          <div className="card p-4 mb-8 border border-primary-500/30 bg-primary-500/5">
            <div className="flex items-center gap-3 mb-3">
              <svg className="w-5 h-5 text-primary-400 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              <div className="flex-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-medium text-white">Indexing files...</span>
                  <span className="text-sm text-dark-400">
                    {scanProgress.scanned.toLocaleString()} / {scanProgress.total.toLocaleString()}
                  </span>
                </div>
                <div className="progress-bar h-2">
                  <div
                    className="progress-fill"
                    style={{ width: `${scanProgress.total > 0 ? (scanProgress.scanned / scanProgress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>
            </div>
            <div className="text-xs text-dark-400 truncate" title={scanProgress.currentFile}>
              Hashing: {scanProgress.currentFile || '...'}
            </div>
          </div>
        )}

        {/* Active uploads */}
        {activeUploads.length > 0 && (
          <div className="card p-4 mb-8 border border-green-500/30 bg-green-500/5">
            <div className="flex items-center gap-2 mb-4">
              <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              <h3 className="text-sm font-medium text-white">
                {activeUploads.length} active upload{activeUploads.length > 1 ? 's' : ''}
              </h3>
            </div>
            <div className="space-y-3">
              {activeUploads.map((upload) => (
                <div key={upload.sessionId} className="bg-dark-800/50 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm text-white truncate flex-1 mr-4" title={upload.filename}>
                      {upload.filename}
                    </span>
                    <span className="text-xs text-dark-400 whitespace-nowrap">
                      {formatBytes(upload.bytesSent)} / {formatBytes(upload.totalSize)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex-1 progress-bar h-2">
                      <div
                        className="progress-fill bg-green-500"
                        style={{ width: `${upload.progress}%` }}
                      />
                    </div>
                    <span className="text-xs text-green-400 whitespace-nowrap">
                      {upload.speed > 0 ? `${formatBytes(upload.speed)}/s` : '—'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Shared folders */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4">Shared Folders</h2>

          {sharedFolders.length === 0 ? (
            <div className="card p-8 text-center">
              <div className="w-16 h-16 rounded-full bg-dark-800 flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-dark-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">No Folders Shared</h3>
              <p className="text-dark-400 mb-4">Add folders to share files with the network</p>
              <button onClick={handleAddFolder} className="btn btn-primary">
                Add Your First Folder
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {sharedFolders.map((folder: any) => (
                <div key={folder.path} className="card p-4">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary-500/20 to-purple-500/20 flex items-center justify-center">
                      <svg className="w-6 h-6 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-white truncate" title={folder.path}>
                        {folder.path}
                      </h3>
                      <p className="text-sm text-dark-400">
                        {folder.filesCount?.toLocaleString() || 0} files ({formatBytes(folder.totalSize || 0)})
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {scanProgress && scanProgress.folder === folder.path && (
                        <span className="flex items-center gap-2 text-sm text-primary-400">
                          <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                          </svg>
                          Scanning...
                        </span>
                      )}
                      <button
                        onClick={() => handleRemoveFolder(folder.path)}
                        className="btn btn-ghost p-2 text-red-400 hover:text-red-300"
                        title="Remove folder"
                      >
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Recent files */}
        {sharedFiles.length > 0 && (
          <section>
            <h2 className="text-lg font-semibold text-white mb-4">Recently Indexed Files</h2>
            <div className="card overflow-hidden">
              <div className="max-h-96 overflow-y-auto">
                <table className="w-full">
                  <thead className="bg-dark-800 sticky top-0">
                    <tr>
                      <th className="text-left text-xs font-medium text-dark-400 uppercase tracking-wider px-4 py-3">File</th>
                      <th className="text-left text-xs font-medium text-dark-400 uppercase tracking-wider px-4 py-3">Type</th>
                      <th className="text-right text-xs font-medium text-dark-400 uppercase tracking-wider px-4 py-3">Size</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-dark-700">
                    {sharedFiles.slice(0, 50).map((file: any) => (
                      <tr key={file.hash} className="hover:bg-dark-800/50 transition-colors">
                        <td className="px-4 py-3">
                          <span className="text-white truncate block max-w-md" title={file.filename}>
                            {file.filename}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <span className="text-dark-400 text-sm">{file.mimeType}</span>
                        </td>
                        <td className="px-4 py-3 text-right">
                          <span className="text-dark-400 text-sm">{formatBytes(file.size)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
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
