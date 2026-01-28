import { useCallback, useEffect } from 'react';

export function useIPC() {
  const invoke = useCallback(async <T>(channel: string, ...args: any[]): Promise<T> => {
    // @ts-ignore - electron is exposed via preload
    return await window.electron[channel]?.(...args);
  }, []);

  const on = useCallback((channel: string, callback: (...args: any[]) => void) => {
    return window.electron.on(channel, callback);
  }, []);

  const off = useCallback((channel: string, callback: (...args: any[]) => void) => {
    window.electron.off(channel, callback);
  }, []);

  return { invoke, on, off };
}

export function useIPCEvent(channel: string, callback: (...args: any[]) => void) {
  useEffect(() => {
    const unsubscribe = window.electron.on(channel, callback);
    return unsubscribe;
  }, [channel, callback]);
}
