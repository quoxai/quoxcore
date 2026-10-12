#!/usr/bin/env python3
"""
QuoxCORE AI Agent Entrypoint

Executes AI-powered tasks in an isolated container.
Reads task from /agent/task.json, outputs to /agent/result.json
"""

import os
import json
import sys
from pathlib import Path

# Task configuration
TASK_FILE = Path("/agent/task.json")
RESULT_FILE = Path("/agent/result.json")
WORKSPACE = Path("/agent/workspace")


def load_task():
    """Load task configuration from file"""
    if not TASK_FILE.exists():
        return None
    with open(TASK_FILE) as f:
        return json.load(f)


def save_result(result):
    """Save result to output file"""
    with open(RESULT_FILE, 'w') as f:
        json.dump(result, f, indent=2)


def run_gemini_task(task):
    """Execute a Gemini-based task"""
    import google.generativeai as genai

    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return {"error": "GOOGLE_API_KEY not set"}

    genai.configure(api_key=api_key)
    model = genai.GenerativeModel(task.get("model", "gemini-pro"))

    prompt = task.get("prompt", "")
    files_content = ""

    # Read any input files
    if task.get("input_files"):
        for file_path in task["input_files"]:
            fp = WORKSPACE / file_path
            if fp.exists():
                files_content += f"\n\n=== {file_path} ===\n{fp.read_text()}"

    full_prompt = f"{prompt}\n{files_content}" if files_content else prompt

    try:
        response = model.generate_content(full_prompt)
        return {
            "status": "success",
            "response": response.text,
            "tokens": {
                "prompt": response.usage_metadata.prompt_token_count,
                "completion": response.usage_metadata.candidates_token_count
            }
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


def run_claude_task(task):
    """Execute a Claude-based task"""
    import anthropic

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {"error": "ANTHROPIC_API_KEY not set"}

    client = anthropic.Anthropic(api_key=api_key)

    prompt = task.get("prompt", "")
    system = task.get("system", "You are a helpful AI assistant.")

    # Read any input files
    files_content = ""
    if task.get("input_files"):
        for file_path in task["input_files"]:
            fp = WORKSPACE / file_path
            if fp.exists():
                files_content += f"\n\n=== {file_path} ===\n{fp.read_text()}"

    user_content = f"{prompt}\n{files_content}" if files_content else prompt

    try:
        response = client.messages.create(
            model=task.get("model", "claude-3-haiku-20240307"),
            max_tokens=task.get("max_tokens", 4096),
            system=system,
            messages=[{"role": "user", "content": user_content}]
        )
        return {
            "status": "success",
            "response": response.content[0].text,
            "tokens": {
                "input": response.usage.input_tokens,
                "output": response.usage.output_tokens
            }
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


def run_openai_task(task):
    """Execute an OpenAI-based task"""
    from openai import OpenAI

    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return {"error": "OPENAI_API_KEY not set"}

    client = OpenAI(api_key=api_key)

    prompt = task.get("prompt", "")
    system = task.get("system", "You are a helpful AI assistant.")

    # Read any input files
    files_content = ""
    if task.get("input_files"):
        for file_path in task["input_files"]:
            fp = WORKSPACE / file_path
            if fp.exists():
                files_content += f"\n\n=== {file_path} ===\n{fp.read_text()}"

    user_content = f"{prompt}\n{files_content}" if files_content else prompt

    try:
        response = client.chat.completions.create(
            model=task.get("model", "gpt-4o-mini"),
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user_content}
            ],
            max_tokens=task.get("max_tokens", 4096)
        )
        return {
            "status": "success",
            "response": response.choices[0].message.content,
            "tokens": {
                "prompt": response.usage.prompt_tokens,
                "completion": response.usage.completion_tokens
            }
        }
    except Exception as e:
        return {"status": "error", "error": str(e)}


def main():
    """Main entrypoint"""
    task = load_task()

    if not task:
        print("No task file found at /agent/task.json")
        sys.exit(1)

    task_type = task.get("type", "").lower()
    print(f"Running task: {task_type}")

    if task_type == "gemini":
        result = run_gemini_task(task)
    elif task_type == "claude":
        result = run_claude_task(task)
    elif task_type == "openai":
        result = run_openai_task(task)
    else:
        result = {"error": f"Unknown task type: {task_type}"}

    save_result(result)
    print(f"Result saved to {RESULT_FILE}")

    if result.get("status") == "error":
        sys.exit(1)


if __name__ == "__main__":
    main()
