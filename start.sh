#!/bin/sh
set -eu
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
for interpreter in "$APP_DIR/.venv311/bin/python" "$APP_DIR/.venv/bin/python"; do
    if [ -x "$interpreter" ]; then
        exec "$interpreter" "$APP_DIR/BrowserAgent.pyw" "$@"
    fi
done
exec python3 "$APP_DIR/BrowserAgent.pyw" "$@"
