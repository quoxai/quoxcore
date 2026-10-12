/**
 * AgentStreamPage - Full-page Agent Activity Stream
 *
 * Standalone route at /agents/stream that wraps the existing
 * AgentStreamView component with full viewport height.
 */

import { AgentStreamView } from '../../components/agents';
import './views.css';

function AgentStreamPage() {
    return (
        <div className="agent-stream-page view-page">
            <div className="agent-stream-page__header">
                <h1 className="agent-stream-page__title">Agent Stream</h1>
                <p className="agent-stream-page__subtitle">
                    Live activity feed from remote agent sessions
                </p>
            </div>
            <div className="agent-stream-page__container">
                <AgentStreamView />
            </div>
        </div>
    );
}

export default AgentStreamPage;
