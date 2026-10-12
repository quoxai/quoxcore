import MarkdownPage from './MarkdownPage'
import content from '../../../docs/ARCHITECTURE_OPTIONS_REPORT.md?raw'

export default function ArchitectureOptionsPage() {
  return (
    <MarkdownPage
      content={content}
      title="Architecture Options Report"
      lead="Analysis of deployment models, admin areas, API key management, team permissions, and multi-tenancy strategy for Quox's enterprise features."
    />
  )
}
