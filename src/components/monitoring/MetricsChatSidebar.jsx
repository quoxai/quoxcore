/**
 * MetricsChatSidebar — METRICS agent chat for Prometheus context.
 *
 * Thin wrapper around AgentChatSidebar. Single fixed agent (no dropdown).
 * Context builder injects Prometheus state: targets, alerts, active tab context.
 */

import { useCallback } from 'react'
import { AgentChatSidebar } from '../chat/AgentChatSidebar'
import './metrics-chat.css'

const METRICS_SUGGESTIONS = [
  'Which hosts have CPU above 80%?',
  'Show memory trend for the last hour',
  'Are any scrape targets down?',
  'What alerts are currently firing?',
  'Compare disk usage across all hosts',
]

export function MetricsChatSidebar({ targets, alerts, activeTab, selectedHost }) {
  const buildMetricsContext = useCallback(async () => {
    const summary = [
      { label: 'Targets', value: `${targets?.summary?.up ?? '?'}/${targets?.summary?.total ?? '?'} up` },
      { label: 'Down targets', value: targets?.summary?.down ?? 0 },
      { label: 'Alerts', value: `${alerts?.summary?.firing ?? 0} firing • ${alerts?.summary?.critical ?? 0} critical • ${alerts?.summary?.warning ?? 0} warning` },
      { label: 'Active tab', value: activeTab || 'heatmap' },
    ]
    const evidence = []

    if (selectedHost) {
      evidence.push({
        label: `Focused host ${selectedHost.instance || selectedHost.name}`,
        text: [
          selectedHost.cpu != null ? `CPU ${selectedHost.cpu}%` : null,
          selectedHost.memory != null ? `memory ${selectedHost.memory}%` : null,
          selectedHost.disk != null ? `disk ${selectedHost.disk}%` : null,
          selectedHost.status || null,
        ].filter(Boolean).join(' • ')
      })
    }

    if (alerts?.firing?.length > 0) {
      alerts.firing.slice(0, 6).forEach((alert) => {
        const name = alert.labels?.alertname || 'Unknown'
        const sev = alert.labels?.severity || 'info'
        const inst = alert.labels?.instance || ''
        evidence.push({
          label: `[${String(sev).toUpperCase()}] ${name}`,
          text: inst || 'no instance'
        })
      })
    }

    return {
      surface: 'sidebar',
      page: 'Prometheus',
      panel: 'METRICS sidebar',
      focus: selectedHost
        ? {
            type: 'Host metric focus',
            label: selectedHost.instance || selectedHost.name,
            id: selectedHost.instance || selectedHost.name,
            detail: selectedHost.status || 'metrics focus'
          }
        : {
            type: 'Monitoring overview',
            label: activeTab || 'heatmap',
            detail: `${alerts?.summary?.firing ?? 0} firing alerts`
          },
      summary,
      evidenceTitle: selectedHost ? 'Focused host and firing alerts' : 'Firing alerts',
      evidence,
      instructions: ['You are METRICS, the Prometheus monitoring specialist. You have metrics_query and alerts_manage tools. Translate natural language to PromQL, run queries, and interpret results with context. Be data-driven and precise.'],
    }
  }, [targets, alerts, activeTab, selectedHost])

  return (
    <AgentChatSidebar
      agentId="metrics"
      agentName="METRICS"
      agentColor="#e6522c"
      agentRole="Prometheus"
      contextBuilder={buildMetricsContext}
      suggestions={METRICS_SUGGESTIONS}
      sessionPrefix="PROM_CHAT"
      vizStorageKey="metrics-viz-collapsed"
      placeholder={selectedHost ? `Ask about ${selectedHost.name || selectedHost.instance}...` : 'Ask METRICS...'}
      emptyText="Ask METRICS about your infrastructure..."
    />
  )
}

export default MetricsChatSidebar
