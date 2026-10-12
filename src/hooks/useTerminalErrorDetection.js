/**
 * useTerminalErrorDetection — debounced error detection for terminal panes
 *
 * Listens for terminal output activity via signalActivity(), debounces 500ms,
 * then fetches recent output from the collector ring buffer and runs
 * detectTerminalError(). Shows detected errors for 15 seconds or until dismissed.
 *
 * Returns: { detectedError, dismissError, signalActivity }
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { stripAnsi } from '../services/terminalContextBuilder';
import { detectTerminalError } from '../utils/terminalErrorDetector';
import { extractEntitiesFromOutput, recordDetectedError } from '../services/terminalMemoryBridge';

const DEBOUNCE_MS = 500;
const AUTO_DISMISS_MS = 15000;
const SUPPRESS_TTL_MS = 30000;
const FETCH_CHARS = 500; // Only check most recent output to avoid stale errors

export function useTerminalErrorDetection(sessionId, mode, hostId) {
  const [detectedError, setDetectedError] = useState(null);

  const debounceTimerRef = useRef(null);
  const autoDismissTimerRef = useRef(null);
  const suppressedRef = useRef(new Map()); // errorType → expiry timestamp
  const lastErrorTypeRef = useRef(null); // Track last shown error type to avoid re-showing same
  const lastOutputHashRef = useRef(''); // Track output to detect actual changes
  const mountedRef = useRef(true);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(debounceTimerRef.current);
      clearTimeout(autoDismissTimerRef.current);
    };
  }, []);

  // Clear error when session or mode changes
  useEffect(() => {
    setDetectedError(null);
    clearTimeout(autoDismissTimerRef.current);
    lastErrorTypeRef.current = null;
    lastOutputHashRef.current = '';
  }, [sessionId, mode]);

  const dismissError = useCallback(() => {
    if (detectedError) {
      // Suppress by error type (more robust than exact line match)
      suppressedRef.current.set(detectedError.errorType, Date.now() + SUPPRESS_TTL_MS);
      lastErrorTypeRef.current = detectedError.errorType;
    }
    setDetectedError(null);
    clearTimeout(autoDismissTimerRef.current);
  }, [detectedError]);

  const checkForErrors = useCallback(async () => {
    if (!sessionId || mode === 'audit' || !mountedRef.current) return;

    try {
      const resp = await fetch(`/collector/terminal/shell/output/${sessionId}?last=${FETCH_CHARS}`, {
        signal: AbortSignal.timeout(3000)
      });
      if (!resp.ok || !mountedRef.current) return;

      const data = await resp.json();
      const rawOutput = data.output || '';
      if (!rawOutput) return;

      // Skip if output hasn't changed (same command still visible)
      const outputKey = rawOutput.slice(-100);
      if (outputKey === lastOutputHashRef.current) return;
      lastOutputHashRef.current = outputKey;

      const clean = stripAnsi(rawOutput);
      extractEntitiesFromOutput(clean);
      const error = detectTerminalError(clean);

      if (!error || !mountedRef.current) return;

      // Check suppression by error type
      const now = Date.now();
      const suppressExpiry = suppressedRef.current.get(error.errorType);
      if (suppressExpiry && suppressExpiry > now) return;

      // Clean up expired suppressions
      for (const [key, expiry] of suppressedRef.current) {
        if (expiry <= now) suppressedRef.current.delete(key);
      }

      // Skip if it's the same error type we're already showing
      if (detectedError && detectedError.errorType === error.errorType && detectedError.errorLine === error.errorLine) return;

      setDetectedError(error);
      lastErrorTypeRef.current = error.errorType;
      recordDetectedError(error, hostId);

      // Auto-dismiss after 15s
      clearTimeout(autoDismissTimerRef.current);
      autoDismissTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          setDetectedError(null);
        }
      }, AUTO_DISMISS_MS);
    } catch {
      // Silently ignore fetch errors
    }
  }, [sessionId, mode, detectedError]);

  const signalActivity = useCallback(() => {
    if (!sessionId || mode === 'audit') return;

    clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(checkForErrors, DEBOUNCE_MS);
  }, [sessionId, mode, checkForErrors]);

  return { detectedError, dismissError, signalActivity };
}
