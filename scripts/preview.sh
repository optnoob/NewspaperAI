#!/bin/bash
# Quick preview script - opens the latest newspaper edition

cd "$(dirname "$0")"

LATEST=$(ls -1 editions/ | grep -E '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' | sort -r | head -1)

if [ -z "$LATEST" ]; then
  echo "No editions found. Run: npm run paper"
  exit 1
fi

EDITION_PATH="editions/$LATEST/index.html"

echo "Opening edition: $LATEST"
echo "Path: $EDITION_PATH"

# Detect OS and open appropriately
if command -v xdg-open &> /dev/null; then
  xdg-open "$EDITION_PATH"
elif command -v open &> /dev/null; then
  open "$EDITION_PATH"
elif command -v start &> /dev/null; then
  start "$EDITION_PATH"
else
  echo "Please open manually: file://$(pwd)/$EDITION_PATH"
fi
