import { Component } from 'react'

/**
 * VoicePopupErrorBoundary — the last line of defence against a blank popout.
 *
 * A render crash anywhere below (the eye, a panel, a caption) must still
 * leave the operator with a legible error card, never a black rectangle.
 * React error boundaries MUST be class components (no hook equivalent).
 */
export default class VoicePopupErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { crashed: false }
  }

  static getDerivedStateFromError() {
    return { crashed: true }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('[VisualizerPopup] render crash:', error, info)
  }

  render() {
    if (this.state.crashed) {
      return this.props.fallback || null
    }
    return this.props.children
  }
}
