/**
 * NotificationFailedBanner: persistent admin warning when lead/handoff
 * notifications could not be delivered to the inbox (widget.notification_failed_count
 * from the widget list/get response).
 */
export default function NotificationFailedBanner({ widget }) {
  const n = Number(widget?.notification_failed_count) || 0
  if (n <= 0) return null
  return (
    <div
      role="alert"
      className="wr-notify-failed"
      style={{ margin: '8px 0', padding: '10px 14px', borderRadius: 8, border: '1px solid #ff5c5c', background: 'rgba(255,92,92,0.12)', color: '#ff8a8a', fontSize: 13 }}
    >
      {n} lead/handoff {n === 1 ? 'notification' : 'notifications'} failed to reach the inbox. Check the Logs and Leads for these visitors and follow up by hand.
    </div>
  )
}
