/**
 * CalendarQChatSidebar — thin AgentChatSidebar wrapper for the Calendar-Q
 * agent. Cloned from InboxQChatSidebar's binding pattern (same chassis,
 * AgentChatSidebar), but read-only: Calendar-Q has no execute tool in this
 * phase (see agentRegistry.js's calendar-q entry), so there is no undo
 * affordance and no post-turn refresh beyond handing the agent the current
 * view state as context.
 */
import { useCallback } from 'react';
import { AgentChatSidebar } from '../chat/AgentChatSidebar';

const CALENDARQ_SUGGESTIONS = [
  'What does my agenda look like this week?',
  'Is anything clashing right now?',
  'What layers are connected and how fresh is each?',
  "What's on today across all my schedules?",
];

export function CalendarQChatSidebar({
  tab,
  layers,
  clashCount,
  coverageSummary,
  collapsed,
  onToggle,
}) {
  const contextBuilder = useCallback(async () => {
    const summary = [
      { label: 'Current tab', value: tab || 'calendar' },
      { label: 'Layers', value: Array.isArray(layers) && layers.length ? layers.map((l) => `${l.displayName} (${l.coverage?.state || 'unknown'})`).join(', ') : 'none yet' },
      { label: 'Clashes in window', value: String(clashCount ?? 0) },
    ];

    const evidence = [];
    if (coverageSummary) {
      evidence.push({ label: 'Coverage checked', text: coverageSummary });
    }

    return {
      surface: 'calendarq',
      page: '/calendarq',
      panel: 'Calendar-Q',
      focus: { type: 'Calendar-Q view', label: `Tab: ${tab || 'calendar'}` },
      summary,
      evidenceTitle: 'Calendar-Q state',
      evidence,
      instructions: [
        'You are talking to the authenticated owner of this calendar. Every tool you have is read-only and has no effect on any calendar.',
        'Read tools: calendar_layers_list, calendar_agenda, calendar_coverage_status, calendar_event_get, calendar_changes, calendar_overlay, calendar_clashes, calendar_schedules_overview.',
        'Quote coverage.state back rather than assuming completeness, and never say "you have nothing on" unless the state is complete or empty.',
        'When reporting a clash, quote the windowCoverageStatement that bounds the claim. A cron job firing during a meeting is never a clash.',
        'You have no tool to create, move, or cancel an event, and you do not offer to; event creation arrives with approvals in a later phase.',
      ],
    };
  }, [tab, layers, clashCount, coverageSummary]);

  return (
    <AgentChatSidebar
      /* The dock wrapper in CalendarQView already carries .qx-surface--backed
         (opaque undercoat), so the sidebar must not paint its own glass panel
         on top of it — same reasoning as InboxQChatSidebar's panel={false}. */
      panel={false}
      agentId="calendar-q"
      agentName="CALENDAR-Q"
      agentColor="#a855f7"
      agentRole="Scheduling Specialist"
      contextBuilder={contextBuilder}
      suggestions={CALENDARQ_SUGGESTIONS}
      sessionPrefix="CALENDARQ"
      collapsed={collapsed}
      onToggle={onToggle}
      placeholder="Ask CALENDAR-Q about your agenda..."
      emptyText="Ask CALENDAR-Q about your calendar..."
    />
  );
}

export default CalendarQChatSidebar;
