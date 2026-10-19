/** The restart countdown line, fitted to the width: full text when it fits, shorter forms below, never wrapped. */
export function countdownLine(secs, cols) {
  const room = Math.max(20, (cols || 80) - 4); // paddingLeft 2 plus a margin
  const forms = [
    `↻ New version ready. Restarting in ${secs}s · Esc to stay on this version · Enter to restart now`,
    `↻ New version · restarting in ${secs}s · Esc stay · Enter now`,
    `↻ Restarting in ${secs}s · Esc stay · Enter now`,
    `↻ Restart in ${secs}s · Esc stay`,
  ];
  return forms.find(f => f.length <= room) || forms[forms.length - 1];
}
