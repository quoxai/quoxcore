/**
 * SchemaInput — dispatcher that picks the right input renderer based on a
 * field's spec.input value. Falls back to TextInput for unknown kinds so
 * a schema typo does not blow up the drawer.
 */

import {
  TextInput,
  NumberInput,
  ToggleInput,
  TextAreaInput,
  SegmentedControl,
  DropdownInput,
  TagInput,
  URLInput,
  ExpressionInput,
} from './inputs/BasicInputs'
import {
  CronInput,
  TimezonePicker,
  ModelDropdown,
  AgentDropdown,
  ToolMultiSelect,
  WorkflowPicker,
  LLMProviderInput,
  LLMModelInput,
  CredentialInput,
} from './inputs/RichInputs'

const REGISTRY = {
  text: TextInput,
  number: NumberInput,
  toggle: ToggleInput,
  textarea: TextAreaInput,
  segmented: SegmentedControl,
  dropdown: DropdownInput,
  tag: TagInput,
  url: URLInput,
  expression: ExpressionInput,
  cron: CronInput,
  timezone: TimezonePicker,
  model: ModelDropdown,
  agent: AgentDropdown,
  tools: ToolMultiSelect,
  workflowPicker: WorkflowPicker,
  llmProvider: LLMProviderInput,
  llmModel: LLMModelInput,
  credential: CredentialInput,
}

export default function SchemaInput({ spec, value, onChange, disabled, autoFocus, siblingConfig, commitMulti }) {
  const kind = spec?.input || 'text'
  const Renderer = REGISTRY[kind] || TextInput

  return (
    <Renderer
      value={value}
      onChange={onChange}
      disabled={disabled}
      autoFocus={autoFocus}
      options={spec?.options}
      placeholder={spec?.placeholder}
      siblingConfig={siblingConfig}
      commitMulti={commitMulti}
    />
  )
}

export { REGISTRY as INPUT_REGISTRY }
