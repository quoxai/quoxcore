import MarkdownPage from './MarkdownPage'
import content from '../../../docs/AOCL.md?raw'

export default function AOCLPage() {
  return (
    <MarkdownPage
      content={content}
      title="AOCL - Agent Orchestration Control Layers"
      lead="OSI-model inspired audit layer protocol for transparent, compliant AI orchestration."
    />
  )
}
