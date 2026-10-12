import { useEffect, useMemo, useState } from 'react'
import { getVisualizationStudioAssignment, getBackgroundOpacity } from '../../services/visualizationStudioService'
import { getVisualizationStudioRenderer } from './registry/renderers'

export default function VisualizerHost({
  assistantId,
  state = 'idle',
  audioData = null,
  fallbackAssignment = null,
  refreshKey = 0
}) {
  const resolveAssignment = () => fallbackAssignment || getVisualizationStudioAssignment(assistantId)
  const [assignment, setAssignment] = useState(() => resolveAssignment())
  const [bgOpacity, setBgOpacity] = useState(() => getBackgroundOpacity())

  useEffect(() => {
    setAssignment(resolveAssignment())
    setBgOpacity(getBackgroundOpacity())

    const handleChange = (event) => {
      if (!event.detail?.assistantId || event.detail.assistantId === assistantId || event.detail.imported) {
        setAssignment(resolveAssignment())
      }
      if (event.detail?.backgroundOpacity) {
        setBgOpacity(getBackgroundOpacity())
      }
    }

    window.addEventListener('quox-viz-studio-change', handleChange)
    return () => window.removeEventListener('quox-viz-studio-change', handleChange)
  }, [assistantId, fallbackAssignment, refreshKey])

  const renderer = useMemo(
    () => getVisualizationStudioRenderer(assignment?.rendererId),
    [assignment?.rendererId]
  )

  const Component = renderer.component

  // Inject backgroundOpacity into assignment.overrides.global so renderers can read it
  const effectiveAssignment = useMemo(() => {
    if (!assignment || bgOpacity >= 1) return assignment
    return {
      ...assignment,
      overrides: {
        ...(assignment.overrides || {}),
        global: { ...(assignment.overrides?.global || {}), backgroundOpacity: bgOpacity }
      }
    }
  }, [assignment, bgOpacity])

  const config = effectiveAssignment?.overrides || {}

  return <Component rendererId={renderer.legacyRendererId || renderer.id} assignment={effectiveAssignment} state={state} audioData={audioData} config={config} />
}
