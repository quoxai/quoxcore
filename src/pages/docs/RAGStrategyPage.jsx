import MarkdownPage from './MarkdownPage'
import content from '../../../docs/RAG_STRATEGY.md?raw'

export default function RAGStrategyPage() {
  return (
    <MarkdownPage
      content={content}
      title="RAG Strategy"
      lead="Retrieval-Augmented Generation strategy for memory search and context injection."
    />
  )
}
