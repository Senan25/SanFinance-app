#!/usr/bin/env sh
# Run without Docker on Linux/macOS: ./start.sh
set -e
cd "$(dirname "$0")"
[ -f .env ] || { echo "Create .env first: cp .env.example .env"; exit 1; }
[ -d .venv ] || python3 -m venv .venv
. .venv/bin/activate
pip install -q -r requirements.txt
exec python run.py
