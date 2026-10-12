import MarkdownPage from './MarkdownPage'
import content from '../../../docs/DEVELOPMENT.md?raw'

export default function DevelopmentPage() {
  return (
    <MarkdownPage
      content={content}
      title="Development Guide"
      lead="Development commands, setup instructions, testing, and project status for QuoxCORE contributors."
    />
  )
}
