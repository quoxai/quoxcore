/**
 * Tiny event bus for the toast system, same pattern as paletteBus.js — any
 * component can fire a toast without prop-drilling a setter through the
 * whole app shell. `<ToastStack />` (mounted once in AppShell) is the only
 * subscriber that renders anything.
 */
import { ApiError } from './api.js';
import { formatCycleError } from './cycleError.js';

const target = new EventTarget();
let nextId = 1;

/**
 * @param {{variant?: 'error'|'warn'|'success', title?: string, message: string, timeout?: number|null}} toast
 *   `timeout` in ms; pass null for a toast that stays until dismissed.
 */
export function showToast({ variant = 'error', title, message, timeout = 6000 } = {}) {
  const toast = { id: nextId++, variant, title, message, timeout };
  target.dispatchEvent(new CustomEvent('toast', { detail: toast }));
  return toast.id;
}

export function onToast(handler) {
  const listener = (e) => handler(e.detail);
  target.addEventListener('toast', listener);
  return () => target.removeEventListener('toast', listener);
}

/**
 * Turns a caught mutation error into a toast, formatting the 422
 * dependency-cycle shape ({ error, cycle }) via formatCycleError so the
 * inline message reads "would create a cycle: A > B > A" everywhere a
 * dependency mutation can fail (stream page, Timeline drag-to-link).
 */
export function toastApiError(err, title) {
  let message = err?.message || 'Something went wrong.';
  if (err instanceof ApiError) {
    if (err.body?.cycle) {
      message = formatCycleError(err.body.cycle);
    } else if (err.body?.error) {
      message = err.body.error;
    }
  }
  showToast({ variant: 'error', title, message });
}
