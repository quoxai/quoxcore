'use strict';
// NotesQ tools that file an approval card under the 'propose' agent edit policy.
// Kept in its own tiny module so approvalGate and notesqWisdom share one set.
const NOTESQ_PROPOSE_TOOLS = new Set(['notesq_create', 'notesq_update', 'notesq_tag', 'notesq_restore', 'notesq_delete']);
module.exports = { NOTESQ_PROPOSE_TOOLS };
