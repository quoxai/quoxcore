/**
 * PreDeployWarning — soft confirm dialog shown before quoxflow deploy
 * when validateWorkflow finds missing-required or unfilled-placeholder fields.
 * Doesn't hard-block; user can deploy anyway. Polish-pass can flip later.
 */

export default function PreDeployWarning({ report, onCancel, onConfirm }) {
  if (!report || report.issueCount === 0) return null

  return (
    <div className="ncd-deploy-modal" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel?.() }}>
      <div className="ncd-deploy-modal__panel" role="alertdialog" aria-modal="true">
        <header className="ncd-deploy-modal__header">
          <span className="ncd-deploy-modal__icon" aria-hidden="true">⚠</span>
          <div>
            <h3 className="ncd-deploy-modal__title">Workflow has unfinished fields</h3>
            <p className="ncd-deploy-modal__sub">
              {report.issueCount} issue{report.issueCount === 1 ? '' : 's'} across {report.nodes.length} node{report.nodes.length === 1 ? '' : 's'}.
              You can still deploy, but the workflow may fail at runtime.
            </p>
          </div>
        </header>

        <div className="ncd-deploy-modal__body">
          {report.nodes.map((n) => (
            <div key={n.nodeId} className="ncd-deploy-modal__node">
              <div>
                <span className="ncd-deploy-modal__node-name">{n.name || n.nodeId}</span>
                <span className="ncd-deploy-modal__node-type">{n.type}</span>
              </div>
              {n.missing.length > 0 && (
                <div className="ncd-deploy-modal__issue">
                  <span className="qx-pill qx-pill--sm qx-pill--critical">required</span>
                  {' '}{n.missing.join(', ')}
                </div>
              )}
              {n.placeholders.length > 0 && (
                <div className="ncd-deploy-modal__issue">
                  <span className="qx-pill qx-pill--sm qx-pill--degraded">placeholder</span>
                  {' '}{n.placeholders.join(', ')}
                </div>
              )}
            </div>
          ))}
        </div>

        <footer className="ncd-deploy-modal__footer">
          <button type="button" className="qx-btn qx-btn--ghost qx-btn--sm" onClick={onCancel}>Go back &amp; fix</button>
          <span className="ncd__footer-spacer" />
          <button type="button" className="qx-btn qx-btn--primary qx-btn--sm" onClick={onConfirm}>Deploy anyway</button>
        </footer>
      </div>
    </div>
  )
}
