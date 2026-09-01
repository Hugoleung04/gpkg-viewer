#!/usr/bin/env bash
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then
  exec python3 start.py "$@"
elif command -v python >/dev/null 2>&1; then
  exec python start.py "$@"
else
  echo "Python 3 is required to start the local viewer."
  exit 1
fi
