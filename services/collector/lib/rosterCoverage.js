'use strict';

/**
 * rosterCoverage.js — LOOP-CONVERGENCE P4: QUARTERMASTER's roster coverage view.
 *
 * QUARTERMASTER is the agent matchmaker/steward, and it could not answer the one
 * question that this whole stream started from: which agents are thin, which are
 * bloated, and where does the roster diverge from the 5-15 tools doctrine. This
 * gives it that view, from the authoritative resolved grant (getToolsForAgent,
 * which drops granted-but-undefined names), not a static parse.
 *
 * Bands (owner doctrine, spec §7): 5-15 tools is the healthy band. Below is thin
 * (under-equipped), above is bloated. The bloated tail is the real doctrine
 * violation, and the honest fix is often loop mode: open-ended work belongs on a
 * witnessed loop (LOOP-CONVERGENCE), not in an ever-wider single grant. This
 * module is PURE; the tool feeds it {agent,count} rows.
 */

const THIN_MAX = 4;      // <= 4 is thin
const HEALTHY_MAX = 15;  // 5..15 is healthy; > 15 is bloated

// Agents that are thin BY DESIGN, so the report does not nag about them.
// qloop is a loop's minimal skill-authoring identity, not a chat persona.
const THIN_BY_DESIGN = new Set(['qloop']);

function bandFor(count) {
  if (count <= THIN_MAX) return 'thin';
  if (count <= HEALTHY_MAX) return 'healthy';
  return 'bloated';
}

function adviceFor(agent, band) {
  if (band === 'bloated') {
    return 'Bloated: candidate to move open-ended work onto a witnessed loop (LOOP-CONVERGENCE) rather than widening the grant further.';
  }
  if (band === 'thin') {
    return THIN_BY_DESIGN.has(agent)
      ? 'Thin by design (not a chat persona) — leave it.'
      : 'Under-equipped: consider a targeted capability that fits its domain (avoid over-squeezing).';
  }
  return 'Healthy (5-15).';
}

/**
 * Build the roster coverage report from resolved {agent, count} rows.
 *
 * @param {object} args
 * @param {Array<{agent:string,count:number}>} args.rows
 * @param {'thin'|'healthy'|'bloated'|'all'} [args.band='all']
 * @returns {{success:true, doctrine:string, summary:object, agents:Array}}
 */
function buildRosterReport({ rows = [], band = 'all' } = {}) {
  const enriched = (Array.isArray(rows) ? rows : [])
    .filter((r) => r && typeof r.agent === 'string' && Number.isFinite(r.count))
    .map((r) => {
      const b = bandFor(r.count);
      return {
        agent: r.agent,
        tools: r.count,
        band: b,
        thin_by_design: b === 'thin' && THIN_BY_DESIGN.has(r.agent),
        advice: adviceFor(r.agent, b),
      };
    })
    .sort((a, b) => a.tools - b.tools || a.agent.localeCompare(b.agent));

  const summary = {
    total_agents: enriched.length,
    thin: enriched.filter((a) => a.band === 'thin').length,
    healthy: enriched.filter((a) => a.band === 'healthy').length,
    bloated: enriched.filter((a) => a.band === 'bloated').length,
    thin_under_equipped: enriched.filter((a) => a.band === 'thin' && !a.thin_by_design).map((a) => a.agent),
    bloated_tail: enriched.filter((a) => a.band === 'bloated').map((a) => `${a.agent}(${a.tools})`),
  };

  const wanted = band && band !== 'all' ? band : null;
  const agents = wanted ? enriched.filter((a) => a.band === wanted) : enriched;

  return {
    success: true,
    doctrine: '5-15 tools is the healthy band; below is thin, above is bloated. Bloated agents are the real doctrine violation and often want loop mode, not a wider grant.',
    summary,
    agents,
  };
}

module.exports = { THIN_MAX, HEALTHY_MAX, THIN_BY_DESIGN, bandFor, adviceFor, buildRosterReport };
