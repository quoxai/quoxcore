import { useEffect, useRef } from 'react'

function ActivityBar({ activity = [], onClick, onItemClick }) {
  const scrollRef = useRef(null)

  // Auto-scroll to show new items
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollLeft = 0
    }
  }, [activity.length])

  const formatTime = (timestamp) => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    return date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  }

  const handleItemClick = (e, item) => {
    e.stopPropagation()
    if (onItemClick) {
      onItemClick(item)
    }
  }

  return (
    <div className="activity-bar" onClick={onClick}>
      <div className="activity-bar-label">ACTIVITY</div>
      <div className="activity-bar-scroll" ref={scrollRef}>
        {activity.length === 0 ? (
          <div className="activity-bar-empty">No recent activity</div>
        ) : (
          activity.slice(0, 10).map((item, i) => (
            <div
              key={item.id || i}
              className={`activity-bar-item ${item.success ? 'success' : 'error'} ${item.session_id ? 'clickable' : ''}`}
              onClick={(e) => handleItemClick(e, item)}
              title={item.session_id ? 'Click to load this session' : item.prompt}
            >
              <span className="item-time">{formatTime(item.timestamp)}</span>
              <span className="item-host">{item.host}</span>
              <span className={`item-status ${item.success ? 'success' : 'error'}`}>
                {item.success ? '✓' : '✗'}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

export default ActivityBar
