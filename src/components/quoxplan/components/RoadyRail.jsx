import { useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import OctaGlyph from './OctaGlyph.jsx';
import { ChatEngine } from '../../chat/ChatEngine.jsx';
import FailoverBadge from '../../chat/FailoverBadge.jsx';
import { ChatInput } from '../../chat/input/ChatInput.jsx';
import { useAuth } from '../../../contexts/AuthContext.jsx';
import { useWorkspace } from '../../../contexts/WorkspaceContext.jsx';
import { showToast } from '../lib/toastBus.js';

/**
 * ROADY's rail — live chat (QUOXPLAN-P4 embed phase). Follows the
 * ActionQSidebar precedent exactly: ChatEngine drives the /collector/chat
 * dispatch addressed to a specific agent (agent="roady"), a contextBuilder
 * supplies a per-surface system-style prefix, and the composer/messages are
 * rendered via the shared ChatInput + a simple message list, same as every
 * other agent side-panel in the app. Only the chrome (qxp-roady-rail__*) is
 * QuoxPlan's own P2.5 identity styling.
 *
 * Conversation history lives in ChatEngine's component state for this
 * render tree; no QuoxPlan-specific storage is added here. The standalone
 * harness at /opt/quoxcore/quoxplan is untouched — ROADY only exists inside
 * the dashboard-embedded QuoxPlan view.
 */
function buildRoadyContext(roadmapId, streamId) {
  const lines = [
    '## QuoxPlan Context',
    'The user is viewing QuoxPlan, the product-management roadmap suite, embedded inside QuoxCORE.',
    roadmapId ? `- Current roadmap id: **${roadmapId}**` : '- No roadmap currently selected.',
  ];
  if (streamId) {
    lines.push(`- Current stream id: **${streamId}** (the user is on this stream's page)`);
  }
  lines.push(
    '',
    'Tool guidance: use `quoxplan_roadmaps` / `quoxplan_streams` / `quoxplan_stream_brief` for QuoxPlan\'s own product roadmaps (this demo corpus). ' +
      'Use `roadmap_list` / `roadmap_show` / `roadmap_stats` only if the user asks about the LIVE Quox strategic roadmap — a separate, unrelated dataset. Do not mix the two up.',
    'You are ROADY, embedded in the QuoxPlan rail. Answer questions about the roadmap/stream currently in view when possible.'
  );
  return lines.join('\n');
}

/** Real component (not an inline render-prop body) so hooks below follow
 * the rules of hooks correctly — it is rendered as ChatEngine's children. */
function RoadyRailBody({ chatState, onClose, roadmapId, streamId }) {
  const { messages, isProcessing, sendMessage, abortMessage, error } = chatState;
  const lastToastedError = useRef(null);

  // Surface connection/agent errors as a QuoxPlan toast (the rail's own
  // error idiom — see ToastStack), in addition to ChatEngine's inline
  // assistant-message error text.
  useEffect(() => {
    if (error && error !== lastToastedError.current) {
      lastToastedError.current = error;
      showToast({ variant: 'error', title: 'ROADY', message: error });
    }
  }, [error]);

  const handleSend = (text) => {
    if (!text || isProcessing) return;
    sendMessage(text);
  };

  return (
    <>
      <div className="qxp-roady-rail__head">
        <span className="qxp-roady-rail__avatar">
          <OctaGlyph status={isProcessing ? 'IN_PROGRESS' : 'DECISION_NEEDED'} size={16} />
        </span>
        <div className="qxp-roady-rail__title">
          <span className="qxp-roady-rail__name">ROADY</span>
          <span className="qxp-roady-rail__subtitle">
            {streamId ? `On stream ${streamId}` : roadmapId ? `Roadmap ${roadmapId}` : 'Roadmap agent'}
          </span>
        </div>
        <button
          type="button"
          className="qx-btn qx-btn--sm qx-btn--ghost"
          style={{ marginLeft: 'auto' }}
          onClick={onClose}
          aria-label="Close ROADY"
        >
          ×
        </button>
      </div>

      <div className="qxp-roady-rail__body qxp-roady-rail__messages">
        {messages.length === 0 && (
          <p className="qx-hint" style={{ textAlign: 'center', margin: 0 }}>
            Ask ROADY about this roadmap or stream.
          </p>
        )}
        {messages.map((msg, i) => (
          <div
            key={msg.messageId || i}
            className={`qxp-roady-rail__msg qxp-roady-rail__msg--${msg.role === 'user' ? 'user' : 'assistant'}`}
          >
            {msg.role === 'user' ? (
              msg.text
            ) : (
              <div className="qxp-plan-body qxp-roady-rail__md">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text || ''}</ReactMarkdown>
                {/* LLM-FAILOVER: the rail must say when a fallback model answered.
                    ROADY ran a whole thread on an OpenAI fallback (Anthropic quota
                    exhausted) with nothing on screen to show the swap. */}
                <FailoverBadge execution={msg.execution} />
              </div>
            )}
          </div>
        ))}
        {isProcessing && (
          <div className="qxp-roady-rail__msg qxp-roady-rail__msg--assistant">
            <span className="qxp-roady-rail__typing"><span /><span /><span /></span>
          </div>
        )}
      </div>

      <div className="qxp-roady-rail__composer">
        <ChatInput
          onSend={handleSend}
          onStop={abortMessage}
          placeholder="Ask ROADY..."
          isProcessing={isProcessing}
          enableVoice={false}
          enableFileUpload={false}
          hints={false}
          maxRows={3}
        />
      </div>
    </>
  );
}

export default function RoadyRail({ onClose, roadmapId, streamId }) {
  const { authFetch } = useAuth();
  const { currentOrg } = useWorkspace();
  const orgId = currentOrg?.id;

  const buildContext = useCallback(async () => buildRoadyContext(roadmapId, streamId), [roadmapId, streamId]);

  return (
    <aside className="qxp-roady-rail">
      <ChatEngine
        agent="roady"
        contextBuilder={buildContext}
        sessionPrefix="QUOXPLAN_ROADY"
        surface="quoxplan-rail"
        enableSmartRouter={false}
        enableMemory={true}
        authFetch={authFetch}
        orgId={orgId}
        enablePersistence={!!orgId}
      >
        {(chatState) => (
          <RoadyRailBody chatState={chatState} onClose={onClose} roadmapId={roadmapId} streamId={streamId} />
        )}
      </ChatEngine>
    </aside>
  );
}
