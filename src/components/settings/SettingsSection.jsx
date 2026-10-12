/**
 * SettingsSection - Wrapper component for settings content sections
 *
 * Provides consistent styling for section headers with optional actions.
 *
 * @example
 * <SettingsSection
 *   title="Preferences"
 *   description="Configure your basic settings"
 *   actions={<Button>Save</Button>}
 * >
 *   <SettingsCard>...</SettingsCard>
 * </SettingsSection>
 */

import './settings.css';

/**
 * SettingsSection Component
 *
 * @param {string} title - Section title
 * @param {string} description - Optional description text
 * @param {React.ReactNode} actions - Optional action buttons
 * @param {React.ReactNode} children - Section content
 * @param {string} className - Additional CSS classes
 */
export default function SettingsSection({
    title,
    description,
    actions,
    children,
    className = ''
}) {
    return (
        <section className={`settings-section ${className}`.trim()}>
            {(title || actions) && (
                <div className="settings-section__header">
                    <div className="settings-section__header-content">
                        {title && (
                            <h2 className="settings-section__title">{title}</h2>
                        )}
                        {description && (
                            <p className="settings-section__description">{description}</p>
                        )}
                    </div>
                    {actions && (
                        <div className="settings-section__actions">
                            {actions}
                        </div>
                    )}
                </div>
            )}
            <div className="settings-section__content">
                {children}
            </div>
        </section>
    );
}

/**
 * SettingsSectionDivider - Visual divider between sections
 */
export function SettingsSectionDivider() {
    return <div className="settings-section__divider" />;
}
