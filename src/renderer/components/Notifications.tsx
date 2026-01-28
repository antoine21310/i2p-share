import React, { useEffect, useState } from 'react';

export type NotificationType = 'success' | 'error' | 'warning' | 'info';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  duration?: number;
}

// Global notification store
let notifications: Notification[] = [];
let listeners: Set<() => void> = new Set();

function notifyListeners() {
  listeners.forEach(listener => listener());
}

export function addNotification(notification: Omit<Notification, 'id'>) {
  const id = Date.now().toString(36) + Math.random().toString(36).substring(2);
  const newNotification: Notification = { ...notification, id };
  notifications = [...notifications, newNotification];
  notifyListeners();

  // Auto-dismiss after duration (default 5 seconds)
  const duration = notification.duration ?? 5000;
  if (duration > 0) {
    setTimeout(() => {
      dismissNotification(id);
    }, duration);
  }

  return id;
}

export function dismissNotification(id: string) {
  notifications = notifications.filter(n => n.id !== id);
  notifyListeners();
}

export function clearAllNotifications() {
  notifications = [];
  notifyListeners();
}

// Convenience functions
export const notify = {
  success: (title: string, message: string = '', duration?: number) =>
    addNotification({ type: 'success', title, message, duration }),
  error: (title: string, message: string = '', duration?: number) =>
    addNotification({ type: 'error', title, message, duration: duration ?? 8000 }),
  warning: (title: string, message: string = '', duration?: number) =>
    addNotification({ type: 'warning', title, message, duration }),
  info: (title: string, message: string = '', duration?: number) =>
    addNotification({ type: 'info', title, message, duration }),
};

// Hook to subscribe to notifications
function useNotifications() {
  const [, forceUpdate] = useState({});

  useEffect(() => {
    const listener = () => forceUpdate({});
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  return notifications;
}

// Notification component
function NotificationItem({ notification, onDismiss }: { notification: Notification; onDismiss: () => void }) {
  const icons = {
    success: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
    error: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
    warning: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
    info: (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  };

  const colors = {
    success: 'bg-green-500/20 border-green-500/50 text-green-400',
    error: 'bg-red-500/20 border-red-500/50 text-red-400',
    warning: 'bg-yellow-500/20 border-yellow-500/50 text-yellow-400',
    info: 'bg-blue-500/20 border-blue-500/50 text-blue-400',
  };

  const iconColors = {
    success: 'text-green-400',
    error: 'text-red-400',
    warning: 'text-yellow-400',
    info: 'text-blue-400',
  };

  return (
    <div
      className={`
        flex items-start gap-3 p-4 rounded-lg border backdrop-blur-sm
        ${colors[notification.type]}
        animate-slide-in shadow-lg
      `}
      style={{
        animation: 'slideIn 0.3s ease-out',
      }}
    >
      <div className={`flex-shrink-0 ${iconColors[notification.type]}`}>
        {icons[notification.type]}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-white">{notification.title}</p>
        {notification.message && (
          <p className="mt-1 text-sm opacity-80">{notification.message}</p>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="flex-shrink-0 p-1 rounded hover:bg-white/10 transition-colors"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// Container component
export function NotificationContainer() {
  const currentNotifications = useNotifications();

  if (currentNotifications.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full pointer-events-none">
      {currentNotifications.map(notification => (
        <div key={notification.id} className="pointer-events-auto">
          <NotificationItem
            notification={notification}
            onDismiss={() => dismissNotification(notification.id)}
          />
        </div>
      ))}

      <style>{`
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}
