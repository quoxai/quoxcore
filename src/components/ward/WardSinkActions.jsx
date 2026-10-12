/**
 * WARD-EXT-4: WardSinkActions — publish unpublished tips + external verify link
 */

export default function WardSinkActions({ unpublishedCount, onPublishAll, chainId, publishing = false }) {
  const verifyUrl = chainId
    ? `/collector/public/verify/ward/${encodeURIComponent(chainId)}`
    : null

  return (
    <div className="ward-sink-actions">
      {/* Publish unpublished tips */}
      {unpublishedCount > 0 && (
        <button
          className="ward-sink-actions__publish-btn"
          onClick={onPublishAll}
          disabled={publishing}
        >
          {publishing ? 'Publishing...' : `Publish ${unpublishedCount} Unpublished`}
        </button>
      )}

      {/* External verification link */}
      {verifyUrl && (
        <a
          href={verifyUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ward-sink-actions__verify-link"
        >
          Verify Externally
        </a>
      )}
    </div>
  )
}
