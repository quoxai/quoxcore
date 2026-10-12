/**
 * InputArea — Glass-styled wrapper around ChatInput
 *
 * Wraps the existing ChatInput component with glass design system chrome.
 * Does NOT rewrite ChatInput — delegates all input logic to it.
 */

import { memo } from 'react';
import { ChatInput } from '../input/ChatInput';

export const InputArea = memo(function InputArea({
    variant = 'full',
    onSend,
    placeholder,
    isProcessing = false,
    disabled = false,
    enableVoice = true,
    enableFileUpload = false,
    voiceKeyboard = true,
    onFilesSelected,
    pendingFiles = [],
    maxRows,
    hints,
    onStop,
}) {
    const resolvedMaxRows = maxRows ?? (variant === 'compact' ? 3 : 6);
    const resolvedHints = hints ?? (variant !== 'compact');

    return (
        <div className={`gcp-input gcp-input--${variant}`}>
            <ChatInput
                onSend={onSend}
                onStop={onStop}
                placeholder={placeholder}
                isProcessing={isProcessing}
                disabled={disabled}
                enableVoice={enableVoice}
                enableFileUpload={variant === 'compact' ? false : enableFileUpload}
                voiceKeyboard={voiceKeyboard}
                onFilesSelected={onFilesSelected}
                pendingFiles={pendingFiles}
                maxRows={resolvedMaxRows}
                hints={resolvedHints}
            />
        </div>
    );
});

export default InputArea;
