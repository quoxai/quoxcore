/**
 * HowToUseView: adoption guide for the RepoBrain surface.
 *
 * Not a feature panel: this is the "get your agents to actually use it" tab.
 * Covers the trinity: install the skill, add the rules, use the CLI/MCP.
 * Renders inside RepoBrainProvider but does not touch the query engine.
 */
import { useCallback, useState } from 'react'

const RULES_SNIPPET = `## RepoBrain, code intelligence, use before grep
- Run \`repobrain query "your question"\` BEFORE grep/glob/read for any "where is X", "how does Y work", "what depends on Z" question. It returns targeted snippets (~240 tokens) with file:line citations instead of whole files, about 42x cheaper.
- Announce it: print a REPOBRAIN line before each query and the result count after.
- Two-step: query for file:line, then read only that section.
- Before editing a hub file, run \`repobrain query "what imports <file>?"\` for blast radius.
- Trust the live index. If a result disagrees with the file on disk (you just edited it), reindex, do not guess around it.`

const INSTALL_SNIPPET = `# Claude Code marketplace
/plugin marketplace add quoxai/quoxpert
# then enable the quoxpert plugin

# or via curl
curl -sSL https://quox.ai/quoxpert/install.sh | bash

# once installed, run in a session
/quoxpert repobrain`

const USAGE_SNIPPET = `# default repo
repobrain query "how does auth mount order work"

# blast radius, what imports this file
repobrain query "what imports AuthContext"

# a specific repo
repobrain query "..." -t quoxflow

# cross-repo
repobrain query "..." -x quox-dashboard,quoxflow,aee`

function CopyBlock({ code, label }) {
  const [copied, setCopied] = useState(false)

  const copy = useCallback(() => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }, [code])

  return (
    <div style={{ position: 'relative' }}>
      <div className="qx-row qx-row--apart" style={{ marginBottom: 8, alignItems: 'center' }}>
        {label ? <span className="qx-hint qx-hint--sm">{label}</span> : <span />}
        <button
          type="button"
          className={`qx-btn qx-btn--ghost qx-btn--sm${copied ? ' qx-btn--success' : ''}`}
          onClick={copy}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="qx-code-block">{code}</pre>
    </div>
  )
}

function StepCard({ n, title, children }) {
  return (
    <div className="qx-card qx-stack">
      <div className="qx-section-title">
        <span className="qx-chip qx-chip--brand">Step {n}</span>
        {title}
      </div>
      {children}
    </div>
  )
}

export default function HowToUseView() {
  return (
    <div className="qx-view">
      <div className="qx-stack">
        <div className="qx-card qx-stack">
          <h2 style={{ margin: 0 }}>Get your agents using RepoBrain</h2>
          <p style={{ margin: 0, color: 'rgba(255,255,255,0.7)' }}>
            RepoBrain answers code questions with file and line citations, roughly 240 tokens of the right
            code instead of a whole file, about 42x cheaper than reading files. Here is how to make your
            Claude sessions reach for it automatically.
          </p>
        </div>

        <StepCard n={1} title="Install the skill">
          <p style={{ margin: 0 }}>
            The <code className="qx-code">quoxpert-repobrain</code> Claude skill makes any Claude fluent at
            RepoBrain: structure search, file:line citations, connecting repos, and the usage discipline.
          </p>
          <CopyBlock code={INSTALL_SNIPPET} label="Install (pick one), then run the slash command" />
        </StepCard>

        <StepCard n={2} title="Add the rules">
          <p style={{ margin: 0 }}>
            Paste this into your project's <code className="qx-code">CLAUDE.md</code> or your global rules so
            agents reach for RepoBrain on their own. Getting it used is as important as installing it.
          </p>
          <CopyBlock code={RULES_SNIPPET} label="CLAUDE.md rule block" />
        </StepCard>

        <StepCard n={3} title="Use it">
          <CopyBlock code={USAGE_SNIPPET} label="CLI examples" />
          <p style={{ margin: 0 }}>
            Inside Claude, the same power is available through QuoxMCP tools once connected, no copy-paste.
          </p>
        </StepCard>

        <div className="qx-card qx-row qx-row--tight">
          <a
            href="https://quox.ai/docs/plugins/repobrain"
            target="_blank"
            rel="noreferrer"
            className="qx-btn qx-btn--ghost"
          >
            Full docs
          </a>
          <a
            href="https://quox.ai/solutions/repobrain"
            target="_blank"
            rel="noreferrer"
            className="qx-btn qx-btn--ghost"
          >
            RepoBrain product
          </a>
        </div>
      </div>
    </div>
  )
}
