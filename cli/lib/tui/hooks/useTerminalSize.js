/**
 * useTerminalSize — reactive terminal dimensions
 *
 * Wraps ink's useStdout() and subscribes to the stdout 'resize' event so
 * components can adapt their layout (separators, page sizes, overlay
 * widths) to the actual terminal instead of hard-coded constants.
 *
 * Falls back to a sensible default (80x24) when stdout is unavailable
 * (e.g. non-TTY output, piped/redirected streams).
 *
 * @returns {{ columns: number, rows: number }}
 */

import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

const FALLBACK = { columns: 80, rows: 24 };

function readSize(stdout) {
  return {
    columns: stdout?.columns || FALLBACK.columns,
    rows: stdout?.rows || FALLBACK.rows,
  };
}

export function useTerminalSize() {
  const { stdout } = useStdout();
  const [size, setSize] = useState(() => readSize(stdout));

  useEffect(() => {
    if (!stdout || typeof stdout.on !== 'function') return undefined;

    const onResize = () => setSize(readSize(stdout));
    stdout.on('resize', onResize);

    return () => {
      if (typeof stdout.off === 'function') {
        stdout.off('resize', onResize);
      } else if (typeof stdout.removeListener === 'function') {
        stdout.removeListener('resize', onResize);
      }
    };
  }, [stdout]);

  return size;
}
