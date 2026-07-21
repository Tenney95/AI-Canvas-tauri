#!/usr/bin/env bash
# 单独启动 3D 导演台（一般不必手动跑：npm run tauri dev 会自动拉起）
set -euo pipefail
cd "$(dirname "$0")/.."
exec node scripts/ensure-director-desk.mjs
