import MarkdownPage from './MarkdownPage'
import content from '../../../docs/SESSION_CONTEXT.md?raw'

export default function SessionContextPage() {
  return (
    <MarkdownPage
      content={content}
      title="Session Context"
      lead="How QuoxCORE maintains context across conversations and sessions."
    />
  )
}
