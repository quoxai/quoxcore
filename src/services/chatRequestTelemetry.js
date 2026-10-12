export function getCollectorResponseStep(response, durationMs, payload = null) {
  const elapsed = Math.max(0, Math.round(durationMs || 0))

  if (response?.ok && payload?.success === false) {
    return {
      label: `Collector returned ${payload.error || 'application_error'} (${elapsed}ms)`,
      kind: 'error',
    }
  }

  if (response?.ok) {
    return {
      label: `Response received (${elapsed}ms)`,
      kind: 'streaming',
    }
  }

  return {
    label: `Backend returned ${response?.status || 'error'} (${elapsed}ms)`,
    kind: 'error',
  }
}
