/**
 * Brain2PrivacyPanel: BRAIN2-V3 B4 "What leaves this instance".
 *
 * Renders quoxbrain's GET /brain/egress: facts read from live config (the
 * collector's embedding-provider probe, the stored org settings, env), never
 * prose. Also shows the effective value + SOURCE (org setting / env / default)
 * of the Qortex tuning knobs. The controls themselves are the platform-flag
 * rows rendered above this panel (PlatformFlagsPanel group "brain2").
 *
 * Best-effort: a quoxbrain outage shows an honest "unavailable", it never
 * fails the cockpit.
 */

import { useEffect, useState } from 'react'
import SettingsCard, { SettingsGroup } from './SettingsCard'
import Badge from '../ui/Badge'

const SOURCE_LABEL = { setting: 'Org setting', env: 'Env', default: 'Default' }

const EFFECTIVE_LABELS = [
    ['QUOXBRAIN_MIN_COVERAGE', 'Minimum term coverage'],
    ['QUOXBRAIN_MIN_DENSE_COSINE', 'Minimum semantic match'],
    ['QUOXBRAIN_MIN_DENSE_FLOOR', 'Semantic floor'],
    ['QUOXBRAIN_QUERY_EMBED_TIMEOUT_MS', 'Query embed timeout (ms)'],
    ['QUOXDREAM_ALLOW_LLM_TEXT', 'Consolidation may send note text to the LLM'],
    ['BRAIN_RERANK_ENABLED', 'AI reranking of search results'],
    ['BRAIN_EXPAND_ENABLED', 'AI query expansion'],
]

function Row({ label, children, testId }) {
    return (
        <div className="ui-setting-item" style={{ marginBottom: 4 }} data-testid={testId}>
            {/* Fixed label column: without it the label wrapped one word per
                line beside long values (screenshot 2026-10-05). */}
            <div className="ui-setting-info" style={{ flex: '0 0 38%', minWidth: 160 }}>
                <span className="ui-setting-label">{label}</span>
            </div>
            <div style={{ fontSize: 13, textAlign: 'right', flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' }}>{children}</div>
        </div>
    )
}

// BRAIN2-W5 130: this panel shows the EFFECTIVE privacy state, so it must not go
// stale after a switch above is flipped or the org changes. Refetch on an
// interval, on window focus, and whenever the parent bumps refreshKey.
const REFRESH_MS = 30000

export default function Brain2PrivacyPanel({ client, refreshKey }) {
    const [data, setData] = useState(undefined) // undefined = loading, null = unavailable
    useEffect(() => {
        let alive = true
        const load = async () => {
            try {
                const d = await client.getEgress()
                if (alive) setData(d)
            } catch {
                if (alive) setData(null)
            }
        }
        load()
        const timer = setInterval(load, REFRESH_MS)
        const onFocus = () => { load() }
        window.addEventListener('focus', onFocus)
        return () => {
            alive = false
            clearInterval(timer)
            window.removeEventListener('focus', onFocus)
        }
    }, [client, refreshKey])

    if (data === undefined) return null
    if (data === null) {
        return (
            <SettingsCard title="What leaves this instance" glass>
                <p style={{ margin: 0, fontSize: 13, color: 'var(--ui-text-muted)' }} data-testid="brain2-egress-unavailable">
                    The Qortex service did not answer, so the data-flow facts cannot be shown right now.
                </p>
            </SettingsCard>
        )
    }

    const { egress, effective = {} } = data
    const emb = egress.embedding
    const excluded = emb.excludedVaults || []

    return (
        <SettingsCard
            title="What leaves this instance"
            subtitle="Read from live configuration. Change these with the switches above."
            glass
        >
            <SettingsGroup>
                <Row label="Embedding provider and model" testId="brain2-egress-embedding">
                    {!emb.known
                        ? 'Unknown (the collector could not be asked)'
                        : emb.provider
                            ? <>Chunk text is sent to <strong>{emb.provider}</strong> ({emb.model || 'default model'}) via {emb.route}</>
                            : 'No embedding provider connected: nothing is sent, search is keyword only'}
                </Row>
                <Row label="Excluded from embedding" testId="brain2-egress-excluded">
                    {excluded.length === 0
                        ? 'No vaults excluded'
                        : excluded.map((v) => v.name).join(', ')}
                </Row>
                <Row label="QuoxDream consolidation" testId="brain2-egress-dream">
                    {egress.dream.sendsNoteText
                        ? <>Sends note text to the chat model ({egress.dream.route})</>
                        : 'Off for this org: note text is not sent to the LLM and consolidation is skipped'}
                </Row>
                {egress.rerank && (
                    <Row label="AI reranker" testId="brain2-egress-rerank">
                        {!egress.rerank.known
                            ? 'Unknown (the setting could not be read), so reranking is treated as off'
                            : egress.rerank.enabled
                                ? <>On: the top search results (up to 30 passages, about 400 characters each) are sent to OpenAI {egress.rerank.model || 'gpt-4o-mini'} (passage text sent) to be re-ordered. Results are marked AI-reranked.</>
                                : 'Off: search results are never sent to the chat model for reranking'}
                    </Row>
                )}
                {egress.expand && (
                    <Row label="AI query expansion" testId="brain2-egress-expand">
                        {!egress.expand.known
                            ? 'Unknown (the setting could not be read), so expansion is treated as off'
                            : egress.expand.enabled
                                ? 'On: your search query text is sent to OpenAI, which writes a few paraphrases and a short guessed answer that are searched alongside it'
                                : 'Off: your search query is never sent to the chat model for expansion'}
                    </Row>
                )}
                <Row label="Agents and Cortex" testId="brain2-egress-agents">
                    {egress.agents.sendsPassagesToChatModel
                        ? <>Retrieved passages are sent to the chat model ({egress.agents.route}) when an agent uses Qortex</>
                        : 'Passages are not sent to the chat model'}
                </Row>
            </SettingsGroup>
            <div style={{ marginTop: 12 }} data-testid="brain2-effective">
                <SettingsGroup>
                    {EFFECTIVE_LABELS.filter(([k]) => effective[k]).map(([k, label]) => (
                        <Row key={k} label={label} testId={`brain2-effective-${k}`}>
                            <span style={{ marginRight: 8, fontVariantNumeric: 'tabular-nums' }}>{effective[k].value}</span>
                            <Badge color={effective[k].source === 'setting' ? 'green' : 'default'} pill>
                                {SOURCE_LABEL[effective[k].source] || effective[k].source}
                            </Badge>
                        </Row>
                    ))}
                </SettingsGroup>
            </div>
        </SettingsCard>
    )
}
