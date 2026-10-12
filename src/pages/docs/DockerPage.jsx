import MarkdownPage from './MarkdownPage'
import content from '../../../docs/DOCKER_CONTAINMENT.md?raw'

export default function DockerPage() {
  return (
    <MarkdownPage
      content={content}
      title="Docker Containment"
      lead="Docker-based containment and isolation strategies for QuoxCORE services."
    />
  )
}
