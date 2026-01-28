import React, { useState, useCallback } from 'react';
import { useStore } from '../store';
import { SearchResult } from '../components/SearchResult';

export function SearchPage() {
  const { searchQuery, searchResults, isSearching, search, clearSearch, startDownload } = useStore();
  const [inputValue, setInputValue] = useState(searchQuery);
  const [selectedType, setSelectedType] = useState<string>('all');

  const handleSearch = useCallback(() => {
    if (inputValue.trim()) {
      search(inputValue);
    }
  }, [inputValue, search]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleClear = () => {
    setInputValue('');
    clearSearch();
  };

  const filteredResults = searchResults.filter(result => {
    if (selectedType === 'all') return true;
    const category = getFileCategory(result.mimeType);
    return category === selectedType;
  });

  const fileTypes = [
    { id: 'all', label: 'All Files', icon: '📁' },
    { id: 'video', label: 'Videos', icon: '🎬' },
    { id: 'audio', label: 'Audio', icon: '🎵' },
    { id: 'image', label: 'Images', icon: '🖼️' },
    { id: 'document', label: 'Documents', icon: '📄' },
    { id: 'archive', label: 'Archives', icon: '📦' },
  ];

  return (
    <div className="h-full flex flex-col bg-dark-950">
      {/* Search header */}
      <div className="p-6 border-b border-dark-800">
        <div className="max-w-4xl mx-auto">
          {/* Search input */}
          <div className="relative">
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search for files across the network..."
              className="w-full h-14 pl-14 pr-32 text-lg rounded-2xl"
            />
            <div className="absolute left-5 top-1/2 -translate-y-1/2">
              <svg className="w-5 h-5 text-dark-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </div>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
              {inputValue && (
                <button
                  onClick={handleClear}
                  className="p-2 text-dark-400 hover:text-white transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
              <button
                onClick={handleSearch}
                disabled={!inputValue.trim() || isSearching}
                className="btn btn-primary h-10 px-6"
              >
                {isSearching ? (
                  <svg className="w-5 h-5 animate-spin" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                ) : (
                  'Search'
                )}
              </button>
            </div>
          </div>

          {/* File type filters */}
          <div className="flex gap-2 mt-4 overflow-x-auto pb-2">
            {fileTypes.map(type => (
              <button
                key={type.id}
                onClick={() => setSelectedType(type.id)}
                className={`
                  flex items-center gap-2 px-4 py-2 rounded-xl whitespace-nowrap transition-all
                  ${selectedType === type.id
                    ? 'bg-primary-500/20 text-primary-400 border border-primary-500/30'
                    : 'bg-dark-800 text-dark-400 hover:text-white border border-transparent'
                  }
                `}
              >
                <span>{type.icon}</span>
                <span className="text-sm font-medium">{type.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-4xl mx-auto">
          {/* Results header */}
          {searchResults.length > 0 && (
            <div className="flex items-center justify-between mb-4">
              <p className="text-dark-400">
                Found <span className="text-white font-semibold">{filteredResults.length}</span> results
                {selectedType !== 'all' && ` in ${selectedType}`}
              </p>
            </div>
          )}

          {/* Empty state */}
          {!isSearching && searchResults.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="w-24 h-24 rounded-full bg-dark-800 flex items-center justify-center mb-6">
                <svg className="w-12 h-12 text-dark-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-white mb-2">Search the Network</h3>
              <p className="text-dark-400 text-center max-w-md">
                Enter a search term to find files shared by peers on the I2P network.
                Your searches are completely anonymous.
              </p>
            </div>
          )}

          {/* Loading state */}
          {isSearching && (
            <div className="flex flex-col items-center justify-center py-20">
              <div className="relative w-20 h-20 mb-6">
                <div className="absolute inset-0 rounded-full border-4 border-dark-700" />
                <div className="absolute inset-0 rounded-full border-4 border-primary-500 border-t-transparent animate-spin" />
              </div>
              <h3 className="text-xl font-semibold text-white mb-2">Searching...</h3>
              <p className="text-dark-400">Querying peers across the network</p>
            </div>
          )}

          {/* Results list */}
          {!isSearching && filteredResults.length > 0 && (
            <div className="space-y-3">
              {filteredResults.map((result, index) => (
                <SearchResult
                  key={`${result.fileHash}-${index}`}
                  result={result}
                  onDownload={() => startDownload(result)}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function getFileCategory(mimeType: string): string {
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('text/') || mimeType.includes('document') || mimeType.includes('pdf')) return 'document';
  if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar') || mimeType.includes('7z')) return 'archive';
  return 'other';
}
