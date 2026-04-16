#!/bin/bash
# Run integration tests and capture tmux screenshots
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Ensure screenshots directory exists
mkdir -p "$SCRIPT_DIR/screenshots"

cd "$SCRIPT_DIR"

echo "Running integration tests with tmux screenshots..."
node run-screenshots.js "$SCRIPT_DIR/screenshots"

echo ""
echo "Screenshot files:"
ls -la "$SCRIPT_DIR/screenshots/"