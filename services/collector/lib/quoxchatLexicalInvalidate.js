/**
 * QUOXCHAT-BRUTALOOP wave 5: knowledge mutations drop the widget's cached
 * BM25 index on success, so a deleted or replaced source stops being served
 * immediately instead of after the 60 s cache TTL.
 */
const quoxchatLexical = require('./quoxchatLexical');

function invalidateLexicalOnSuccess(collectionForWidget) {
  return function lexicalInvalidate(req, res, next) {
    res.on('finish', () => {
      if (res.statusCode < 200 || res.statusCode >= 300) return;
      const wid = (req.body && req.body.widget_id) || (req.query && req.query.widget_id);
      try {
        if (wid) quoxchatLexical.invalidate(collectionForWidget(wid));
        else quoxchatLexical.invalidate();
      } catch (err) {
        console.warn('[QuoxChat] lexical invalidate failed:', err?.message);
      }
    });
    next();
  };
}

module.exports = { invalidateLexicalOnSuccess };
