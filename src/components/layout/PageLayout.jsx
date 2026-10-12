/**
 * PageLayout - Consistent page structure for all views
 *
 * Provides:
 * - Full-height scroll container
 * - Sticky header support
 * - Proper overflow handling
 * - Consistent spacing
 *
 * Usage:
 * <PageLayout
 *   header={<PageHeader title="Title" subtitle="Description" />}
 *   stickyHeader
 * >
 *   <PageSection title="Section 1" collapsible defaultCollapsed={false}>
 *     Content here
 *   </PageSection>
 *   <PageSection title="Section 2">
 *     More content
 *   </PageSection>
 * </PageLayout>
 */

import React, { useState, useCallback, memo } from 'react';
import './page-layout.css';

// Chevron icon for collapse/expand
const ChevronIcon = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M4.5 2L8.5 6L4.5 10"/>
  </svg>
);

/**
 * PageHeader - Standard header for pages
 */
export const PageHeader = memo(function PageHeader({
  title,
  subtitle,
  icon,
  actions,
  badge,
  badgeVariant = 'default'
}) {
  return (
    <div className="page-header">
      <div className="page-header-left">
        {icon && <div className="page-header-icon">{icon}</div>}
        <div className="page-header-text">
          <h1 className="page-header-title">{title}</h1>
          {subtitle && <p className="page-header-subtitle">{subtitle}</p>}
        </div>
        {badge && (
          <span className={`page-header-badge ${badgeVariant}`}>{badge}</span>
        )}
      </div>
      {actions && <div className="page-header-actions">{actions}</div>}
    </div>
  );
});

/**
 * PageSection - Collapsible section within a page
 */
export const PageSection = memo(function PageSection({
  title,
  icon,
  badge,
  badgeVariant = 'default',
  collapsible = false,
  defaultCollapsed = false,
  onToggle,
  actions,
  children,
  className = '',
  noPadding = false
}) {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);

  const handleToggle = useCallback(() => {
    if (!collapsible) return;
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    onToggle?.(newState);
  }, [collapsible, isCollapsed, onToggle]);

  return (
    <div className={`page-section ${collapsible ? 'collapsible' : ''} ${isCollapsed ? 'collapsed' : ''} ${className}`}>
      <div
        className={`page-section-header ${collapsible ? 'clickable' : ''}`}
        onClick={handleToggle}
      >
        <div className="page-section-header-left">
          {icon && <span className="page-section-icon">{icon}</span>}
          <h3 className="page-section-title">{title}</h3>
          {badge && (
            <span className={`page-section-badge ${badgeVariant}`}>{badge}</span>
          )}
        </div>
        <div className="page-section-header-right">
          {actions && <div className="page-section-actions">{actions}</div>}
          {collapsible && (
            <div className="page-section-toggle">
              <ChevronIcon />
            </div>
          )}
        </div>
      </div>
      <div className={`page-section-content ${noPadding ? 'no-padding' : ''}`}>
        {children}
      </div>
    </div>
  );
});

/**
 * PageGrid - Grid layout for cards/panels
 */
export const PageGrid = memo(function PageGrid({
  columns = 2,
  gap = 'md',
  children,
  className = ''
}) {
  return (
    <div
      className={`page-grid page-grid-${columns} page-grid-gap-${gap} ${className}`}
    >
      {children}
    </div>
  );
});

/**
 * PageCard - Card container with optional header
 */
export const PageCard = memo(function PageCard({
  title,
  icon,
  badge,
  actions,
  children,
  className = '',
  variant = 'default', // 'default' | 'highlight' | 'warning' | 'error'
  noPadding = false
}) {
  return (
    <div className={`page-card page-card-${variant} ${className}`}>
      {(title || icon || actions) && (
        <div className="page-card-header">
          <div className="page-card-header-left">
            {icon && <span className="page-card-icon">{icon}</span>}
            {title && <h4 className="page-card-title">{title}</h4>}
            {badge && <span className="page-card-badge">{badge}</span>}
          </div>
          {actions && <div className="page-card-actions">{actions}</div>}
        </div>
      )}
      <div className={`page-card-content ${noPadding ? 'no-padding' : ''}`}>
        {children}
      </div>
    </div>
  );
});

/**
 * PageDivider - Visual separator between sections
 */
export const PageDivider = memo(function PageDivider({ label }) {
  return (
    <div className="page-divider">
      {label && <span className="page-divider-label">{label}</span>}
    </div>
  );
});

/**
 * PageLayout - Main container component
 */
const PageLayout = memo(function PageLayout({
  header,
  stickyHeader = false,
  footer,
  children,
  className = ''
}) {
  return (
    <div className={`page-layout ${className}`}>
      {header && (
        <div className={`page-layout-header ${stickyHeader ? 'sticky' : ''}`}>
          {header}
        </div>
      )}
      <div className="page-layout-content">
        {children}
      </div>
      {footer && (
        <div className="page-layout-footer">
          {footer}
        </div>
      )}
    </div>
  );
});

export default PageLayout;
