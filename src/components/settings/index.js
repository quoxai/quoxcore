/**
 * Settings Components Index
 *
 * Export all settings-related components
 */

// Layout components
export { default as SettingsLayout, DEFAULT_SECTIONS } from './SettingsLayout'
export { default as SettingsSidebar, icons as settingsIcons, getIcon as getSettingsIcon } from './SettingsSidebar'
export { default as SettingsSection, SettingsSectionDivider } from './SettingsSection'
export { default as SettingsCard, SettingsCardGroup, SettingsGroup } from './SettingsCard'

// Assistant management
export { default as AssistantSettings } from './AssistantSettings'
export { default as AssistantCard } from './AssistantCard'
export { default as AssistantEditor } from '../assistant-editor/AssistantEditorV2'
export { default as AssistantHierarchy } from './AssistantHierarchy'

// Plugin management
export { default as PluginSettings } from './PluginSettings'
export { default as PluginCard } from './PluginCard'
export { default as LicenseActivation } from './LicenseActivation'
export { default as DeviceActivationPanel } from './DeviceActivationPanel'
export { default as AdvancedMemoryFeatureCard } from './AdvancedMemoryFeatureCard'

// Service administration
export { default as ServiceStatus } from './ServiceStatus'
export { default as CustomServicesPanel } from './CustomServicesPanel'
export { default as AlertRulesPanel } from './AlertRulesPanel'
export { default as CoreCommsSettings } from './CoreCommsSettings'

// Core setup
export { default as CoreIntegrations } from './CoreIntegrations'

// Quox Qortex cockpit (BRAIN2-PRODUCT Phase B)
export { default as Brain2Settings } from './Brain2Settings'
export { default as NotesQSettings } from './NotesQSettings'
export { default as Brain2Suggestions } from './Brain2Suggestions'

// Voice settings
export { default as VoiceSettings } from './VoiceSettings'

// Privacy & Data Retention (Security Issues #72, #73)
export { default as DataRetentionSettings } from './DataRetentionSettings'
export { default as PrivacySettings } from './PrivacySettings'
