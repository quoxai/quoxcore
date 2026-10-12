/**
 * AEE-FULL Gap 4 shim for AbortSignal.any().
 *
 * Native AbortSignal.any() is in Node 19+ / 18.17+, but we ship a shim instead
 * of upgrading Node (separate change with its own blast radius). When Node
 * upgrades, swap call sites to native and delete this file.
 */
export function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const controller = new AbortController();
  for (const s of signals.filter((x): x is AbortSignal => !!x)) {
    if (s.aborted) { controller.abort(s.reason); break; }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
