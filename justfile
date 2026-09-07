dev:
    #!/usr/bin/env bash
    set -euo pipefail

    COMPOSER_DATA_DIR="${COMPOSER_DATA_DIR:-$PWD/.composer-dev-data}" pnpm --filter @composer/server dev &
    server_pid=$!
    pnpm --filter @composer/desktop start &
    desktop_pid=$!

    cleanup() {
        kill "$server_pid" "$desktop_pid" 2>/dev/null || true
        wait "$server_pid" "$desktop_pid" 2>/dev/null || true
    }
    trap cleanup EXIT INT TERM

    wait -n "$server_pid" "$desktop_pid"
