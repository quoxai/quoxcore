/** React side of the frame source: a context plus a hook that re-renders the caller on every clock frame. */
import React from 'react';

export const FrameContext = React.createContext(null);
const noop = () => () => {};
/**
 * Re-render the caller on every clock frame and return the current time (ms). The wall clock, not the frame
 * stamp, so a render caused by anything else is never stale. Outside a provider it returns `fallback`.
 */
export function useFrame(fallback) {
  const frames = React.useContext(FrameContext);
  React.useSyncExternalStore(frames ? frames.subscribe : noop, frames ? frames.get : () => 0);
  return frames ? Date.now() : (fallback ?? Date.now());
}
