import MarkdownPage from './MarkdownPage'
import content from '../../../docs/SETUP.md?raw'

export default function SetupPage() {
  return (
    <MarkdownPage
      content={content}
      title="Setup Guide"
      lead="Installation and configuration instructions for setting up QuoxCORE in your environment."
    />
  )
}
