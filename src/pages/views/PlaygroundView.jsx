/**
 * PlaygroundView - Layer Playground Page
 *
 * Interactive sandbox for testing AOCL layer behavior in isolation.
 * Part of AOCL Developer Kit (Free — LICENSE-LAUNCH #3081)
 */

import { LayerPlayground } from '../../components/playground'
import LLMAuthBanner from '../../components/ui/LLMAuthBanner'

export default function PlaygroundView() {
  return (
    <div className="playground-view" style={{ height: '100%' }}>
      <LLMAuthBanner />
      <LayerPlayground />
    </div>
  )
}
