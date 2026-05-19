#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
echo "Installing LeadOS VPS Worker dependencies..."
npm install
npx playwright install chromium
if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example. Edit .env before starting."
fi
echo "Install complete. Run: npm start"
