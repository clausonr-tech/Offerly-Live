#!/bin/bash
export PATH="$HOME/.local/node-v24.19.0-darwin-arm64/bin:$PATH"
cd "$(dirname "$0")/.."
exec npm run dev
