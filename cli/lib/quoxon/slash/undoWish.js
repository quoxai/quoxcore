/** /undo and /wish factory app.js wires: switch cases plus one answer hook. They share one card (one y/n at a time). */
import { createCard } from './card.js';
import { createUndoCmd } from './undoCmd.js';
import { createWishCmd } from './wishCmd.js';

export function createUndoWish({ api, say, getItems, runTurn, draft, now }) {
  const card = createCard({ say, now });
  return {
    undo: createUndoCmd({ api, say, getItems, card, now }),
    wish: createWishCmd({ api, say, card, runTurn, draft }),
    answer: (text) => card.answer(text),
    pending: () => card.pending(),
    touch: () => card.touch()
  };
}
