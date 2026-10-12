#!/bin/bash
# Quox Tool Runner
# Executes tool commands with proper environment setup

set -e

# Parse arguments
TOOL_COMMAND="$1"
TOOL_PARAMS="$2"

# Log start
echo "[runner] Starting tool execution"
echo "[runner] Tool: $QUOX_TOOL_ID"
echo "[runner] Invocation: $QUOX_INVOCATION_ID"

# Set up environment
export PYTHONPATH="/sandbox:$PYTHONPATH"
export NODE_PATH="/sandbox:$NODE_PATH"

# Create temp directory for this execution
EXEC_TMP="/tmp/sandbox/$QUOX_INVOCATION_ID"
mkdir -p "$EXEC_TMP"
cd "$EXEC_TMP"

# Execute the tool command
if [ -n "$TOOL_COMMAND" ]; then
    echo "[runner] Executing: $TOOL_COMMAND"

    # Run with timeout from environment (default 60s)
    TIMEOUT=${QUOX_TIMEOUT:-60}

    if command -v timeout &> /dev/null; then
        timeout "$TIMEOUT" bash -c "$TOOL_COMMAND"
        EXIT_CODE=$?
    else
        bash -c "$TOOL_COMMAND"
        EXIT_CODE=$?
    fi

    echo "[runner] Exit code: $EXIT_CODE"
else
    echo "[runner] No command specified"
    EXIT_CODE=1
fi

# Cleanup
rm -rf "$EXEC_TMP" 2>/dev/null || true

exit $EXIT_CODE
