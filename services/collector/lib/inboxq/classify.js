'use strict';

/**
 * InboxQ classifier — assign a zone + flags to a message.
 *
 * DETERMINISTIC-FIRST (cost invariant): rules decide the zone for the vast
 * majority of mail with zero LLM calls. The model is consulted ONLY when the
 * rules are genuinely uncertain (a plain human-looking sender with no automated
 * markers, where focus-vs-fyi is a judgement call) AND an llm function is
 * provided AND the per-tick budget allows. Empty polls therefore cost nothing,
 * and a mailbox of newsletters/receipts costs nothing either. This is the
 * "model only on changed content needing judgment" rule from the AQ v4 plan.
 *
 * Zones:
 *   focus    — a real person/business wanting something from a human
 *   fyi      — newsletters, digests, marketing, low-priority updates
 *   auto     — machine mail: receipts, notifications, no-reply, delivery reports
 *   screened — spam-likely (in a Spam/Junk folder, or strong spam markers)
 *
 * Flags (independent of zone):
 *   needs_action — the message asks the reader to do something
 *   has_deadline — a time constraint is present
 *   review       — classified low-priority but carries an action signal, so a
 *                  human should double-check it did not get mis-filed. This is
 *                  the signal the daily report surfaces as a "misfiling gotcha".
 */

const AUTO_LOCALPART = /^(no-?reply|do-?not-?reply|donotreply|noreply|notifications?|notify|mailer-daemon|postmaster|bounce[sd]?|automated?|auto|system|alerts?|team|hello|info|support|billing|receipts?|orders?)$/i;
const AUTO_ANYWHERE = /(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster)/i;
const FYI_MARKERS = /\b(newsletter|digest|weekly|monthly|unsubscribe|promo(tion)?|sale|% ?off|deal|bulletin|roundup|update from|new post|blog)\b/i;
const SPAM_MARKERS = /\b(viagra|casino|crypto giveaway|you('| ha)ve won|claim your prize|nigerian prince|wire transfer urgent|bitcoin doubl)/i;
const ACTION_MARKERS = /\b(action required|please (?:reply|respond|confirm|review|complete|sign|pay|send|provide|advise|let me know)|can you|could you|would you|urgent|asap|respond|reply by|confirm|approve|approval needed|sign(?:ature)? (?:required|needed)|payment (?:due|required)|overdue|invoice attached|awaiting your)\b/i;
const DEADLINE_MARKERS = /\b(deadline|due (?:date|by|on)?|by (?:mon|tue|wed|thu|fri|sat|sun|today|tomorrow|\d)|expires?|expiry|expiring|before (?:mon|tue|wed|thu|fri|sat|sun|the)|within \d+ (?:day|hour|week)|closes? (?:on|at)|last chance|final (?:notice|reminder)|ends (?:today|tonight|soon))\b/i;

// Cold-outreach / marketing-pitch detection — the modal spam this mailbox gets
// is professional SEO/web-design/ads/VA/lead-gen outreach from throwaway
// free-mail accounts, which the crude SPAM_MARKERS above never catch. Ported
// from inbox-experiment/rule_pass.py (SEO_PITCH l.19 + LEADS_SPAM l.104 +
// SKETCHY_TLD l.38 + freemail/fake-reply l.64), which reached ~82% spam recall.
const COLD_PITCH_MARKERS = /\b(seo|search engine|google ranking|rank higher|higher (?:on|in) (?:google|search)|improve.{0,20}rank|(?:re)?design.{0,20}website|update.{0,20}(?:your )?website|new website|website work|web ?(?:dev|design|development)|digital marketing|social media (?:management|marketing)|social advertising|running ads|optimi[sz]ed? ads|smarter ads|ppc|meta ads|google ads|boost.{0,20}(?:traffic|sales|ranking|review|online)|beat.{0,20}competitor|(?:out)?rank.{0,20}competitor|increase.{0,20}sales|grow.{0,20}(?:your )?business|acquir\w*.{0,20}(?:new )?customers?|attract.{0,20}customers?|lead ?gen(?:eration)?|(?:qualified|sales|b2b|exclusive|targeted|more) leads|leads for your|backlink|link building|guest post|content writing|app development|outsourc|dedicated va|virtual assistant|may i send you a quote|quick question)\b/i;
const FREEMAIL_DOMAIN = /@(?:gmail|googlemail|outlook|hotmail|yahoo|ymail|aol|live|icloud|proton(?:mail)?|gmx)\.[a-z.]+$/i;
// name-ish localpart ending in 2+ digits: the auto-generated outreach account tell.
const THROWAWAY_LOCALPART = /^[a-z]+[._-]?[a-z]*\d{2,}$/i;
const FAKE_REPLY_SUBJECT = /^(?:re|fwd?|fw):\s*(?:can we (?:discuss|talk|chat)|quick (?:question|chat|call)|following up|are you (?:there|interested|available)|(?:just )?checking in)/i;
const SKETCHY_TLD = /@[^@\s]+\.(?:biz|live|online|buzz|top|xyz|work|click|pw|tk|loan|review|site|link|services|agency|shop|store|fun|icu|cyou)$/i;
const RECRUITMENT_DOMAIN = /@[a-z0-9-]+rec\.(?:co\.uk|com|net|io|uk)$/i;

function norm(s) {
  return (s || '').toString().toLowerCase();
}

function localPart(addr) {
  const a = norm(addr);
  const at = a.indexOf('@');
  return at > 0 ? a.slice(0, at) : a;
}

/**
 * Pure, synchronous rule engine. Returns { zone, flags, by:'rules', confidence }.
 * confidence is a rough 0..1 of how sure the rules are of the ZONE (flags are
 * always rule-derived). A low confidence is the trigger for optional LLM help.
 */
function classifyDeterministic({ folder = 'INBOX', fromAddr = '', fromName = '', subject = '', snippet = '', hasListUnsub = false } = {}) {
  const hay = `${norm(subject)} \n ${norm(snippet)}`;
  const flags = [];
  const needsAction = ACTION_MARKERS.test(hay) || /\?\s*$/.test(norm(subject).trim());
  const hasDeadline = DEADLINE_MARKERS.test(hay);
  if (needsAction) flags.push('needs_action');
  if (hasDeadline) flags.push('has_deadline');

  let zone = 'focus';
  let confidence = 0.5;

  // 1. Folder-driven: a Spam/Junk folder is the strongest signal we have.
  if (/\b(spam|junk|bulk)\b/i.test(folder)) {
    zone = 'screened';
    confidence = 0.95;
  } else if (SPAM_MARKERS.test(hay)) {
    zone = 'screened';
    confidence = 0.9;
  } else {
    const lp = localPart(fromAddr);
    const isAuto = AUTO_ANYWHERE.test(norm(fromAddr)) || AUTO_LOCALPART.test(lp);
    if (isAuto) {
      // Machine mail. Receipts/notifications/no-reply. High confidence.
      zone = 'auto';
      confidence = 0.85;
    } else {
      // Scored cold-outreach detector. Each signal is individually weak; the
      // combination is what the corpus shows to be near-certain marketing spam.
      // A genuine inbound customer names the product and the job; a cold pitch
      // leads with a benefit claim from a throwaway account. That asymmetry is
      // what this exploits.
      const addr = norm(fromAddr);
      const isFreemail = FREEMAIL_DOMAIN.test(addr);
      let spamScore = 0;
      if (COLD_PITCH_MARKERS.test(hay)) spamScore += 3;
      if (SKETCHY_TLD.test(addr)) spamScore += 3;
      if (RECRUITMENT_DOMAIN.test(addr)) spamScore += 3;
      if (isFreemail && THROWAWAY_LOCALPART.test(lp)) spamScore += 2;
      if (isFreemail && FAKE_REPLY_SUBJECT.test(norm(subject))) spamScore += 3;
      if (isFreemail && COLD_PITCH_MARKERS.test(hay)) spamScore += 1;

      if (spamScore >= 3) {
        // A single pitch match is enough: a real customer does not lead with
        // "Rank higher than your competitors in search results".
        zone = 'screened';
        confidence = spamScore >= 5 ? 0.95 : 0.85;
      } else if (spamScore === 2) {
        // Suggestive not conclusive (e.g. throwaway free-mail localpart alone):
        // route to fyi at < AMBIGUOUS_THRESHOLD so the LLM tie-break can rescue.
        zone = 'fyi';
        confidence = 0.55;
      } else if (FYI_MARKERS.test(hay) || FYI_MARKERS.test(norm(fromName))) {
        zone = 'fyi';
        confidence = 0.8;
      } else if (hasListUnsub) {
        // §1a: a List-Unsubscribe header is the old classifier's single most
        // reliable signal (rule_pass.py:121) — present => legitimate bulk mail.
        zone = 'fyi';
        confidence = 0.75;
      } else {
        // A plain human-looking sender with no automated/bulk/pitch markers.
        // Default to focus; low confidence so the LLM pass can refine focus-vs-fyi.
        // Do NOT let a bare "?" raise confidence when any spam signal is present.
        zone = 'focus';
        confidence = (needsAction || hasDeadline) && spamScore === 0 ? 0.75 : 0.5;
      }
    }
  }

  // review flag: a low-priority zone that nonetheless carries an action signal
  // is exactly the message a human loses. Surface it as a check.
  if ((zone === 'auto' || zone === 'fyi' || zone === 'screened') && needsAction) {
    flags.push('review');
  }

  return { zone, flags, by: 'rules', confidence };
}

const AMBIGUOUS_THRESHOLD = 0.6;

/**
 * Full classify: rules first, LLM only on genuine ambiguity when a budget
 * allows. `llm` is an async fn (message) -> 'focus'|'fyi'|null. It is invoked
 * at most once per message and never for messages the rules are confident
 * about. Callers pass a budget object { remaining: n } to cap LLM spend per
 * tick; when exhausted, the rule verdict stands.
 *
 * @returns {Promise<{zone, flags, by, confidence}>}
 */
async function classify(msg, { llm = null, budget = null } = {}) {
  const rules = classifyDeterministic(msg);

  const ambiguous = rules.confidence < AMBIGUOUS_THRESHOLD && (rules.zone === 'focus' || rules.zone === 'fyi');
  const haveBudget = !budget || (budget.remaining && budget.remaining > 0);
  if (!ambiguous || typeof llm !== 'function' || !haveBudget) {
    return rules;
  }

  try {
    if (budget) budget.remaining -= 1;
    const verdict = await llm(msg);
    if (verdict === 'focus' || verdict === 'fyi') {
      return { zone: verdict, flags: rules.flags, by: 'llm', confidence: 0.7 };
    }
  } catch {
    // LLM failure must never break ingestion — fall back to the rule verdict.
  }
  return rules;
}

module.exports = {
  classifyDeterministic,
  classify,
  AMBIGUOUS_THRESHOLD,
  ZONES: ['focus', 'fyi', 'auto', 'screened'],
};
