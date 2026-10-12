/**
 * Tab components for the assistant editor.
 * Each tab receives a uniform interface: { draft, updateField, validationErrors, ... }
 * Extracted from AssistantEditor.jsx monolith (AUX-1).
 */

export { default as IdentityTab } from './IdentityTab'
export { default as SystemPromptTab } from './SystemPromptTab'
export { default as VoiceTab } from './VoiceTab'
export { default as LLMConfigTab } from './LLMConfigTab'
export { default as PersonalityTab } from './PersonalityTab'
export { default as RulesTab } from './RulesTab'
export { default as SafetyTab } from './SafetyTab'
export { default as UISettingsTab } from './UISettingsTab'
export { default as DelegationTab } from './DelegationTab'
export { default as QuickActionsTab } from './QuickActionsTab'
export { default as ToolBuilderTab } from './ToolBuilderTab'
