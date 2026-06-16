#!/usr/bin/env bash
# Dated backup of the paper-trade SQLite DB to a dir OUTSIDE the repo.
set -euo pipefail
SRC="${1:-logs/trades.db}"
DEST_DIR="${PAPER_DB_BACKUP_DIR:-$HOME/paper-db-backups}"
mkdir -p "$DEST_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
# Use sqlite3 .backup if available (safe online copy), else plain cp.
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$SRC" ".backup '$DEST_DIR/trades-$STAMP.db'"
else
  cp "$SRC" "$DEST_DIR/trades-$STAMP.db"
fi
echo "backup -> $DEST_DIR/trades-$STAMP.db"
