import React, { useEffect } from 'react';
import { useStore } from '../store';

export function DownloadsPage() {
  const { downloads, fetchDownloads, pauseDownload, resumeDownload, cancelDownload } = useStore();

  useEffect(() => {
    fetchDownloads();
    const interval = setInterval(fetchDownloads, 2000);
    return () => clearInterval(interval);
  }, []);

  const activeDownloads = downloads.filter(d => ['pending', 'downloading'].includes(d.status));
  const completedDownloads = downloads.filter(d => d.status === 'completed');
  const failedDownloads = downloads.filter(d => d.status === 'failed');

  return (
    <div className="h-full overflow-y-auto bg-dark-950 p-6">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Downloads</h1>
          <p className="text-dark-400">
            {activeDownloads.length} active, {completedDownloads.length} completed
          </p>
        </div>

        {/* Active Downloads */}
        {activeDownloads.length > 0 && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-primary-500 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              Active Downloads
            </h2>
            <div className="space-y-3">
              {activeDownloads.map(download => (
                <DownloadItem
                  key={download.id}
                  download={download}
                  onPause={() => pauseDownload(download.id)}
                  onResume={() => resumeDownload(download.id)}
                  onCancel={() => cancelDownload(download.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Completed Downloads */}
        {completedDownloads.length > 0 && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Completed
            </h2>
            <div className="space-y-3">
              {completedDownloads.map(download => (
                <DownloadItem
                  key={download.id}
                  download={download}
                  onCancel={() => cancelDownload(download.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Failed Downloads */}
        {failedDownloads.length > 0 && (
          <section className="mb-8">
            <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
              <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Failed
            </h2>
            <div className="space-y-3">
              {failedDownloads.map(download => (
                <DownloadItem
                  key={download.id}
                  download={download}
                  onResume={() => resumeDownload(download.id)}
                  onCancel={() => cancelDownload(download.id)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {downloads.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-24 h-24 rounded-full bg-dark-800 flex items-center justify-center mb-6">
              <svg className="w-12 h-12 text-dark-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">No Downloads Yet</h3>
            <p className="text-dark-400 text-center max-w-md">
              Search for files and start downloading. Your downloads will appear here.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

interface DownloadItemProps {
  download: {
    id: number;
    filename: string;
    totalSize: number;
    downloadedSize: number;
    status: string;
    progress: number;
    speed: number;
    peerName: string;
  };
  onPause?: () => void;
  onResume?: () => void;
  onCancel: () => void;
}

function DownloadItem({ download, onPause, onResume, onCancel }: DownloadItemProps) {
  const isActive = download.status === 'downloading';
  const isPaused = download.status === 'paused';
  const isCompleted = download.status === 'completed';
  const isFailed = download.status === 'failed';

  const handleOpenFile = () => {
    // This would open the file location
    window.electron.showItemInFolder(download.filename);
  };

  return (
    <div className="card p-4">
      <div className="flex items-start gap-4">
        {/* Status icon */}
        <div className={`
          w-10 h-10 rounded-lg flex items-center justify-center
          ${isCompleted ? 'bg-green-500/20 text-green-400' : ''}
          ${isActive ? 'bg-primary-500/20 text-primary-400' : ''}
          ${isPaused ? 'bg-yellow-500/20 text-yellow-400' : ''}
          ${isFailed ? 'bg-red-500/20 text-red-400' : ''}
          ${download.status === 'pending' ? 'bg-dark-700 text-dark-400' : ''}
        `}>
          {isCompleted && (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          )}
          {isActive && (
            <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          )}
          {isPaused && (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
          {isFailed && (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
          {download.status === 'pending' && (
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
        </div>

        {/* File info */}
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white truncate" title={download.filename}>
            {download.filename}
          </h3>
          <div className="flex items-center gap-4 mt-1 text-sm text-dark-400">
            <span>{formatBytes(download.downloadedSize)} / {formatBytes(download.totalSize)}</span>
            {isActive && download.speed > 0 && (
              <span className="text-primary-400">{formatSpeed(download.speed)}</span>
            )}
            <span>from {download.peerName}</span>
          </div>

          {/* Progress bar */}
          {!isCompleted && (
            <div className="mt-3">
              <div className="progress-bar">
                <div
                  className={`progress-fill ${isFailed ? 'bg-red-500' : ''}`}
                  style={{ width: `${download.progress}%` }}
                />
              </div>
              <p className="text-xs text-dark-500 mt-1">{download.progress.toFixed(1)}%</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          {isActive && onPause && (
            <button
              onClick={onPause}
              className="btn btn-ghost p-2"
              title="Pause"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          )}
          {(isPaused || isFailed) && onResume && (
            <button
              onClick={onResume}
              className="btn btn-ghost p-2"
              title="Resume"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </button>
          )}
          {isCompleted && (
            <button
              onClick={handleOpenFile}
              className="btn btn-ghost p-2"
              title="Show in folder"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
              </svg>
            </button>
          )}
          <button
            onClick={onCancel}
            className="btn btn-ghost p-2 text-red-400 hover:text-red-300"
            title="Remove"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
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

function formatSpeed(bytesPerSec: number): string {
  return formatBytes(bytesPerSec) + '/s';
}
