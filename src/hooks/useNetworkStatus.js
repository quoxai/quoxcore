/**
 * useNetworkStatus — Monitors browser online/offline state
 *
 * Returns { isOnline, wasOffline }.
 *   isOnline:   current navigator.onLine state
 *   wasOffline: true for 5s after an offline→online transition (trigger for auto-resume)
 */

import { useState, useEffect, useRef } from 'react';

const TRANSITION_CLEAR_MS = 5000;

export default function useNetworkStatus() {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [wasOffline, setWasOffline] = useState(false);
  const wasOfflineRef = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // Only set wasOffline if we were actually offline before
      if (wasOfflineRef.current) {
        setWasOffline(true);
        clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setWasOffline(false), TRANSITION_CLEAR_MS);
      }
      wasOfflineRef.current = false;
    };

    const handleOffline = () => {
      setIsOnline(false);
      wasOfflineRef.current = true;
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      clearTimeout(timerRef.current);
    };
  }, []);

  return { isOnline, wasOffline };
}
