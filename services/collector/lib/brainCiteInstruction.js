/** One shared citation instruction for every brain-material surface (implant K, quoxbrain_* B, recall R). */
function citeInstruction(prefix = 'B') {
  return `Cite every brain fact inline with its handle right after the sentence it supports, like: The launch codename is Aurora Lattice [${prefix}1].`;
}
const BRAIN_CITE_INSTRUCTION = citeInstruction('B');
module.exports = { BRAIN_CITE_INSTRUCTION, citeInstruction };
