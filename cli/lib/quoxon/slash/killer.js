/**
 * /watch, /automate, /crystallize: the shared factory app.js wires (switch cases + one answer hook).
 * Each command makes ONE preview card; the next line y/n creates through an existing backend path.
 */
import { createConfirm } from './confirm.js';
import { createWatchCmd } from './watch.js';
import { createAutomateCmd } from './automate.js';
import { createCrystallizeCmd } from './crystallize.js';

export function createKillerCmds({ api, say, getState, getFields }) {
  const confirm = createConfirm({ say });
  const watch = createWatchCmd({ api, say, confirm });
  const automate = createAutomateCmd({ api, say, confirm, getState, getFields });
  const crystallize = createCrystallizeCmd({ api, say, confirm, getState, getFields });
  return {
    crystallize: (arg) => crystallize.handle(arg),
    automate: (arg) => automate.handle(arg),
    watch: (arg) => watch.handle(arg),
    /** The composer line after a preview card: true when consumed as the y/n answer. */
    answer: (text) => confirm.answer(text),
    pending: () => confirm.pending(),
    touch: () => confirm.touch()
  };
}
