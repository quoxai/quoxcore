/** Simulated QUOXON journey for --demo, screenshots and tests. Nothing here talks to a server. */
export const DEMO_STEPS = (turnId) => [
  { wait: 150, ev: { type: 'turn.started', turn_id: turnId, conversation_id: 'demo-conv', agent: 'CommanderQ', provider: 'demo', model: 'demo-model', hat: 'operator' } },
  { wait: 300, ev: { type: 'thinking', turn_id: turnId, stage: 'planning', message: 'Planning the steps' } },
  { wait: 400, ev: { type: 'text.delta', turn_id: turnId, content: 'I will save that note, then restart the web service. ' } },
  { wait: 300, ev: { type: 'tool.started', turn_id: turnId, call_id: 'c1', tool: 'memory_save', summary: 'save note "demo journey"' } },
  { wait: 200, ev: { type: 'trace', turn_id: turnId, protocol: 'aee', label: 'envelope opened', ref: '01K4N8QXAB' } },
  { wait: 700, ev: { type: 'tool.finished', turn_id: turnId, call_id: 'c1', tool: 'memory_save', status: 'ok', result_summary: 'saved', duration_ms: 640, envelope_id: 'env1', receipt: null } },
  { wait: 300, ev: { type: 'tool.started', turn_id: turnId, call_id: 'c2', tool: 'host_restart', summary: 'restart web on edge-02' } },
  { wait: 300, ev: { type: 'approval.requested', turn_id: turnId, call_id: 'c2', inbox_item_id: 'demo-item', approval_id: 'demo-appr', tool: 'host_restart', target: 'web on edge-02', scope: 'service restart, 1 host', risk: 'medium', dashboard_url: 'https://example.invalid/approvals/demo-item' } },
  { gate: 'approval' },
  { when: 'reject', wait: 200, ev: { type: 'approval.resolved', turn_id: turnId, call_id: 'c2', inbox_item_id: 'demo-item', decision: 'denied' } },
  { when: 'reject', wait: 200, ev: { type: 'tool.finished', turn_id: turnId, call_id: 'c2', tool: 'host_restart', status: 'denied', result_summary: 'denied by you, not run', duration_ms: 0, envelope_id: null, receipt: null } },
  { when: 'reject', wait: 300, ev: { type: 'text.delta', turn_id: turnId, content: 'Understood. The note is saved; web on edge-02 was NOT restarted because you denied it (demo data).' } },
  { when: 'reject', wait: 200, ev: { type: 'turn.finished', turn_id: turnId, status: 'completed', conversation_id: 'demo-conv' } },
  { when: 'approve', wait: 200, ev: { type: 'approval.resolved', turn_id: turnId, call_id: 'c2', inbox_item_id: 'demo-item', decision: 'approved' } },
  { when: 'approve', wait: 900, ev: { type: 'tool.finished', turn_id: turnId, call_id: 'c2', tool: 'host_restart', status: 'ok', result_summary: 'restarted', duration_ms: 2300, envelope_id: 'env2', receipt: { ward_seq: 4069513, verified: true } } },
  { when: 'approve', wait: 100, ev: { type: 'trace', turn_id: turnId, protocol: 'aocl', label: 'ingress ok identity ok policy ok' } },
  { when: 'approve', wait: 100, ev: { type: 'trace', turn_id: turnId, protocol: 'ward', label: 'witnessed', ref: '4069513' } },
  { when: 'approve', wait: 300, ev: { type: 'text.delta', turn_id: turnId, content: 'Done. The note is saved and web on edge-02 restarted (demo data, nothing real ran).' } },
  { when: 'approve', wait: 200, ev: { type: 'turn.finished', turn_id: turnId, status: 'completed', conversation_id: 'demo-conv' } }
];

export const DEMO_LABEL = 'DEMO: simulated journey, no server, nothing real runs';
