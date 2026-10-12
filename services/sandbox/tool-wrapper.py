#!/usr/bin/env python3
"""
Quox Tool Wrapper

Provides a standardized way to execute tools with:
- Parameter parsing from environment
- Output formatting
- Error handling
- Resource tracking
"""

import os
import sys
import json
import time
import traceback
from typing import Any, Dict, Optional


class ToolContext:
    """Execution context for a tool."""

    def __init__(self):
        self.tool_id = os.environ.get('QUOX_TOOL_ID', 'unknown')
        self.tool_name = os.environ.get('QUOX_TOOL_NAME', 'Unknown Tool')
        self.invocation_id = os.environ.get('QUOX_INVOCATION_ID', '')
        self.org_id = os.environ.get('QUOX_ORG_ID', '')
        self.agent_id = os.environ.get('QUOX_AGENT_ID', '')
        self.user_id = os.environ.get('QUOX_USER_ID', '')

        # Parse parameters
        params_json = os.environ.get('QUOX_PARAMS', '{}')
        try:
            self.params = json.loads(params_json)
        except json.JSONDecodeError:
            self.params = {}

    def get_param(self, key: str, default: Any = None) -> Any:
        """Get a parameter value."""
        return self.params.get(key, default)

    def require_param(self, key: str) -> Any:
        """Get a required parameter, raise if missing."""
        if key not in self.params:
            raise ValueError(f"Required parameter missing: {key}")
        return self.params[key]


class ToolResult:
    """Structured result from a tool execution."""

    def __init__(self):
        self.success = False
        self.data = None
        self.error = None
        self.metadata = {}

    def set_success(self, data: Any, metadata: Optional[Dict] = None):
        """Set successful result."""
        self.success = True
        self.data = data
        self.metadata = metadata or {}

    def set_error(self, error: str, details: Optional[Dict] = None):
        """Set error result."""
        self.success = False
        self.error = error
        self.metadata = details or {}

    def to_json(self) -> str:
        """Convert to JSON output."""
        output = {
            'success': self.success,
            'data': self.data,
            'error': self.error,
            'metadata': self.metadata
        }
        return json.dumps(output, indent=2, default=str)


def run_tool(tool_func):
    """Decorator to run a tool function with standard wrapper."""

    def wrapper():
        ctx = ToolContext()
        result = ToolResult()
        start_time = time.time()

        try:
            # Run the tool
            output = tool_func(ctx)

            # Set result
            if isinstance(output, dict):
                result.set_success(output)
            else:
                result.set_success({'output': output})

        except ValueError as e:
            result.set_error(f"Invalid input: {str(e)}")
        except Exception as e:
            result.set_error(str(e), {'traceback': traceback.format_exc()})

        # Add timing
        result.metadata['duration_ms'] = int((time.time() - start_time) * 1000)
        result.metadata['tool_id'] = ctx.tool_id
        result.metadata['invocation_id'] = ctx.invocation_id

        # Output result
        print(result.to_json())

        # Exit with appropriate code
        sys.exit(0 if result.success else 1)

    return wrapper


# Example tool implementation
if __name__ == '__main__':
    @run_tool
    def echo_tool(ctx: ToolContext) -> Dict:
        """Simple echo tool for testing."""
        message = ctx.get_param('message', 'Hello from Quox Sandbox!')
        return {
            'message': message,
            'tool_id': ctx.tool_id,
            'params': ctx.params
        }

    echo_tool()
