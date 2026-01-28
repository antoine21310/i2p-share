import React, { useState } from 'react';
import { useStore } from '../store';

export function SettingsPage() {
  const { networkStatus } = useStore();
  const [settings, setSettings] = useState({
    maxUploadSpeed: 5,
    maxDownloadSpeed: 10,
    uploadSlots: 10,
    downloadSlots: 4,
    downloadPath: 'C:\\Users\\Downloads',
    theme: 'dark',
    notifications: true,
    autoStart: false,
    anonymousReporting: true,
  });

  const handleConnect = async () => {
    await window.electron.connect();
  };

  const handleDisconnect = async () => {
    await window.electron.disconnect();
  };

  return (
    <div className="h-full overflow-y-auto bg-dark-950 p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-white mb-2">Settings</h1>
          <p className="text-dark-400">Configure your I2P Share preferences</p>
        </div>

        {/* Network Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
            </svg>
            Network
          </h2>
          <div className="card p-6 space-y-6">
            {/* Connection status */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`w-3 h-3 rounded-full ${networkStatus.isConnected ? 'status-online' : 'status-offline'}`} />
                <div>
                  <p className="font-medium text-white">I2P Connection</p>
                  <p className="text-sm text-dark-400">
                    {networkStatus.isConnected
                      ? `Connected with ${networkStatus.activeTunnels} active tunnels`
                      : 'Not connected to I2P network'}
                  </p>
                </div>
              </div>
              <button
                onClick={networkStatus.isConnected ? handleDisconnect : handleConnect}
                className={`btn ${networkStatus.isConnected ? 'btn-secondary' : 'btn-primary'}`}
              >
                {networkStatus.isConnected ? 'Disconnect' : 'Connect'}
              </button>
            </div>

            {/* SAM Settings */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-2">SAM Host</label>
                <input
                  type="text"
                  value="127.0.0.1"
                  disabled
                  className="w-full opacity-50 cursor-not-allowed"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-2">SAM Port</label>
                <input
                  type="text"
                  value="7656"
                  disabled
                  className="w-full opacity-50 cursor-not-allowed"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Bandwidth Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Bandwidth
          </h2>
          <div className="card p-6 space-y-6">
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-2">
                  Max Upload Speed (MB/s)
                </label>
                <input
                  type="number"
                  value={settings.maxUploadSpeed}
                  onChange={(e) => setSettings({ ...settings, maxUploadSpeed: Number(e.target.value) })}
                  min="0"
                  max="100"
                  className="w-full"
                />
                <p className="text-xs text-dark-500 mt-1">0 = Unlimited</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-2">
                  Max Download Speed (MB/s)
                </label>
                <input
                  type="number"
                  value={settings.maxDownloadSpeed}
                  onChange={(e) => setSettings({ ...settings, maxDownloadSpeed: Number(e.target.value) })}
                  min="0"
                  max="100"
                  className="w-full"
                />
                <p className="text-xs text-dark-500 mt-1">0 = Unlimited</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-2">
                  Upload Slots
                </label>
                <input
                  type="number"
                  value={settings.uploadSlots}
                  onChange={(e) => setSettings({ ...settings, uploadSlots: Number(e.target.value) })}
                  min="1"
                  max="50"
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-dark-300 mb-2">
                  Parallel Downloads
                </label>
                <input
                  type="number"
                  value={settings.downloadSlots}
                  onChange={(e) => setSettings({ ...settings, downloadSlots: Number(e.target.value) })}
                  min="1"
                  max="10"
                  className="w-full"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Downloads Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Downloads
          </h2>
          <div className="card p-6">
            <div>
              <label className="block text-sm font-medium text-dark-300 mb-2">
                Download Location
              </label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={settings.downloadPath}
                  onChange={(e) => setSettings({ ...settings, downloadPath: e.target.value })}
                  className="flex-1"
                />
                <button className="btn btn-secondary">Browse</button>
              </div>
            </div>
          </div>
        </section>

        {/* Privacy Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            Privacy
          </h2>
          <div className="card p-6 space-y-4">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <p className="font-medium text-white">Anonymous Crash Reports</p>
                <p className="text-sm text-dark-400">Help improve I2P Share by sending anonymous error reports</p>
              </div>
              <Toggle
                checked={settings.anonymousReporting}
                onChange={(checked) => setSettings({ ...settings, anonymousReporting: checked })}
              />
            </label>
          </div>
        </section>

        {/* General Section */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            General
          </h2>
          <div className="card p-6 space-y-4">
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <p className="font-medium text-white">Desktop Notifications</p>
                <p className="text-sm text-dark-400">Show notifications for completed downloads</p>
              </div>
              <Toggle
                checked={settings.notifications}
                onChange={(checked) => setSettings({ ...settings, notifications: checked })}
              />
            </label>
            <label className="flex items-center justify-between cursor-pointer">
              <div>
                <p className="font-medium text-white">Start on System Boot</p>
                <p className="text-sm text-dark-400">Launch I2P Share when your computer starts</p>
              </div>
              <Toggle
                checked={settings.autoStart}
                onChange={(checked) => setSettings({ ...settings, autoStart: checked })}
              />
            </label>
          </div>
        </section>

        {/* About Section */}
        <section>
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            About
          </h2>
          <div className="card p-6">
            <div className="flex items-center gap-4 mb-4">
              <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary-500 to-purple-600 flex items-center justify-center">
                <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
                </svg>
              </div>
              <div>
                <h3 className="text-xl font-bold gradient-text">I2P Share</h3>
                <p className="text-dark-400">Version 1.0.0</p>
              </div>
            </div>
            <p className="text-dark-400 text-sm">
              Anonymous, decentralized file sharing over the I2P network.
              Your privacy is protected by end-to-end encryption and onion routing.
            </p>
            <div className="mt-4 pt-4 border-t border-dark-700">
              <p className="text-xs text-dark-500">
                Built with Electron, React, and TypeScript.
                Using I2P SAM protocol for anonymous communication.
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function Toggle({ checked, onChange }: ToggleProps) {
  return (
    <button
      onClick={() => onChange(!checked)}
      className={`
        relative inline-flex h-6 w-11 items-center rounded-full transition-colors
        ${checked ? 'bg-primary-500' : 'bg-dark-600'}
      `}
    >
      <span
        className={`
          inline-block h-4 w-4 transform rounded-full bg-white transition-transform
          ${checked ? 'translate-x-6' : 'translate-x-1'}
        `}
      />
    </button>
  );
}
