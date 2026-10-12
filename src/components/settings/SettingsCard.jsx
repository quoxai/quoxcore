/**
 * SettingsCard - Consistent card styling for settings groups
 *
 * Features:
 * - Glass-morphism effect option
 * - Header with title and status indicator
 * - Body content area
 * - Footer with actions
 *
 * @example
 * <SettingsCard
 *   title="Notifications"
 *   status="enabled"
 *   glass
 * >
 *   <SettingItem label="Enable alerts" checked={true} />
 * </SettingsCard>
 */

import './settings.css';

/**
 * SettingsCard Component
 *
 * @param {string} title - Card header title
 * @param {string} subtitle - Optional subtitle
 * @param {React.ReactNode} icon - Optional icon for the title
 * @param {string} status - Status indicator: 'success', 'warning', 'error', 'neutral'
 * @param {string} statusText - Text to show with status indicator
 * @param {boolean} glass - Enable glass-morphism effect
 * @param {boolean} compact - Use compact padding
 * @param {string} variant - 'default', 'danger' for danger zone styling
 * @param {React.ReactNode} headerActions - Actions to show in header
 * @param {React.ReactNode} footer - Footer content
 * @param {React.ReactNode} children - Card body content
 * @param {string} className - Additional CSS classes
 */
export default function SettingsCard({
    title,
    subtitle,
    icon,
    status,
    statusText,
    glass = false,
    compact = false,
    variant = 'default',
    headerActions,
    footer,
    children,
    className = ''
}) {
    const cardClasses = [
        'settings-card',
        glass && 'settings-card--glass',
        variant === 'danger' && 'settings-card--danger',
        className
    ].filter(Boolean).join(' ');

    const bodyClasses = [
        'settings-card__body',
        compact && 'settings-card__body--compact'
    ].filter(Boolean).join(' ');

    const hasHeader = title || headerActions || status;

    return (
        <div className={cardClasses}>
            {hasHeader && (
                <div className="settings-card__header">
                    <div className="settings-card__header-left">
                        {icon && (
                            <span className="settings-card__icon">{icon}</span>
                        )}
                        <div className="settings-card__title-group">
                            {title && (
                                <h3 className="settings-card__title">{title}</h3>
                            )}
                            {subtitle && (
                                <p className="settings-card__subtitle">{subtitle}</p>
                            )}
                        </div>
                    </div>
                    <div className="settings-card__header-right">
                        {status && (
                            <span className="settings-status">
                                <span className={`settings-status__dot settings-status__dot--${status}`} />
                                {statusText || status}
                            </span>
                        )}
                        {headerActions}
                    </div>
                </div>
            )}
            {children && (
                <div className={bodyClasses}>
                    {children}
                </div>
            )}
            {footer && (
                <div className="settings-card__footer">
                    {footer}
                </div>
            )}
        </div>
    );
}

/**
 * SettingsCardGroup - Container for multiple related cards
 */
export function SettingsCardGroup({
    columns = 1,
    children,
    className = ''
}) {
    const gridClass = columns > 1 ? `settings-grid settings-grid--${columns}` : '';

    return (
        <div className={`settings-card-group ${gridClass} ${className}`.trim()}>
            {children}
        </div>
    );
}

/**
 * SettingsGroup - Container for related settings items within a card
 */
export function SettingsGroup({
    divider = false,
    children,
    className = ''
}) {
    const groupClasses = [
        'settings-group',
        divider && 'settings-group--divider',
        className
    ].filter(Boolean).join(' ');

    return (
        <div className={groupClasses}>
            {children}
        </div>
    );
}
