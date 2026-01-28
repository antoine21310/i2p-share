import React, { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { SearchPage } from './pages/Search';
import { DownloadsPage } from './pages/Downloads';
import { MySharesPage } from './pages/MyShares';
import { PeersPage } from './pages/Peers';
import { SettingsPage } from './pages/Settings';
import { useStore } from './store';

type Page = 'search' | 'downloads' | 'shares' | 'peers' | 'settings';

export function App() {
  const [currentPage, setCurrentPage] = useState<Page>('search');
  const { fetchNetworkStatus, fetchDownloads } = useStore();

  useEffect(() => {
    // Initial data fetch
    fetchNetworkStatus();
    fetchDownloads();

    // Set up polling for updates
    const interval = setInterval(() => {
      fetchNetworkStatus();
      fetchDownloads();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const renderPage = () => {
    switch (currentPage) {
      case 'search':
        return <SearchPage />;
      case 'downloads':
        return <DownloadsPage />;
      case 'shares':
        return <MySharesPage />;
      case 'peers':
        return <PeersPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <SearchPage />;
    }
  };

  return (
    <div className="flex flex-col h-screen bg-dark-950">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} />
        <main className="flex-1 overflow-hidden">
          {renderPage()}
        </main>
      </div>
    </div>
  );
}
