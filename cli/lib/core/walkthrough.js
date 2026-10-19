/**
 * WALKTHROUGH for a plain terminal (`quox approvals walkthrough`, `quox inbox walkthrough`): the waiting decisions one
 * card at a time, using the same card and reply rules as the TUI (quoxon/approvalsView.js). Identity is the decision id.
 * io = { readLine(prompt) -> Promise<string|null>, write(line), answer(item, key, note) -> Promise<void> }.
 */
import { isDecision, walkCard, walkReply, walkNotYesNo, walkNoCatch, walkSummary } from '../quoxon/approvalsView.js';

export async function runWalkthrough(items, io) {
  const decs = (items || []).filter(isDecision);
  if (!decs.length) { io.write('No question is waiting for you.'); return { answered: [], skipped: [], left: [] }; }
  const st = { answered: [], skipped: [], left: [] };
  io.write(`${decs.length} question${decs.length === 1 ? '' : 's'} waiting for you. One at a time: a choice, then an optional note.`);
  for (let i = 0; i < decs.length; i++) {
    const it = decs[i]; const card = walkCard(it, i + 1, decs.length);
    io.write(''); card.lines.forEach((l) => io.write(l));
    for (;;) {
      const line = await io.readLine('Your choice? ');
      if (line == null) { for (let j = i; j < decs.length; j++) st.left.push(decs[j].title || decs[j].id); io.write(''); walkSummary(st).forEach((l) => io.write(l)); return st; }
      const rep = walkReply(it, line);
      if (!rep) { io.write(walkNoCatch(it)); continue; }
      if (rep.notYesNo) { io.write(walkNotYesNo(it)); continue; }
      if (rep.defer) { st.skipped.push(it.title || it.id); break; }
      if (rep.ask) { io.write(`  Asked by ${it.payload.session || 'a session'} (id ${it.id}). ${it.payload.why || 'No further reason was given.'}`); continue; }
      if (it.payload.high_risk === true && rep.key !== 'n') { io.write('  High risk: a yes needs your PIN, which this plain terminal cannot take. Answer it in `quox` with /approvals walkthrough, or skip it here.'); continue; }
      try { await io.answer(it, rep.key, rep.note || null); }
      catch (e) { io.write(`  Not answered (${e.message}). The question stays open.`); continue; }
      const label = it.payload.options.find((o) => o.key === rep.key).label;
      io.write(`✔ ${it.title || it.id}: ${label}`);
      st.answered.push({ title: it.title || it.id, word: label });
      break;
    }
  }
  io.write(''); walkSummary(st).forEach((l) => io.write(l));
  return st;
}
