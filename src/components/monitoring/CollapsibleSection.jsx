/**
 * CollapsibleSection - A reusable collapsible wrapper component
 *
 * Usage:
 * <CollapsibleSection
 *   title="Section Title"
 *   icon={<SvgIcon />}
 *   badge="3 items"
 *   badgeVariant="warning"
 *   defaultCollapsed={false}
 *   onToggle={(collapsed) => console.log(collapsed)}
 * >
 *   <YourContent />
 * </CollapsibleSection>
 */

import React, { useState, useCallback, memo } from 'react';
import '../core/monitoring/monitoring.css';

const ChevronIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 2L8.5 6L4.5 10"/>
  </svg>
);

const CollapsibleSection = memo(function CollapsibleSection({
  title,
  icon,
  badge,
  badgeVariant = 'default', // 'default' | 'warning' | 'error'
  defaultCollapsed = false,
  onToggle,
  children,
  className = ''
}) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const handleToggle = useCallback(() => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    onToggle?.(newState);
  }, [isCollapsed, onToggle]);

  return (
    <div className={`collapsible-section ${isCollapsed ? 'collapsed' : ''} ${className}`}>
      <div className="collapsible-header" onClick={handleToggle}>
        <div className="collapsible-header-left">
          <div className="collapsible-header-title">
            {icon}
            {title}
          </div>
          {badge && (
            <span className={`collapsible-header-badge ${badgeVariant}`}>
              {badge}
            </span>
          )}
        </div>
        <div className="collapsible-toggle">
          <ChevronIcon />
        </div>
      </div>
      <div className="collapsible-content">
        <div className="collapsible-inner">
          {children}
        </div>
      </div>
    </div>
  );
});

export default CollapsibleSection;
