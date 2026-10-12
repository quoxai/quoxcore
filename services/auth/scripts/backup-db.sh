#!/bin/bash
# QuoxCORE Database Backup Script
# Creates timestamped backup of SQLite database before migrations

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB_DIR="$(dirname "$SCRIPT_DIR")/db"
DB_FILE="$DB_DIR/quoxcore.db"
BACKUP_DIR="/opt/quoxcore/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/quoxcore_$TIMESTAMP.db"

# Create backup directory if it doesn't exist
mkdir -p "$BACKUP_DIR"

# Check if database exists
if [ ! -f "$DB_FILE" ]; then
    echo "Error: Database file not found at $DB_FILE"
    exit 1
fi

# Create backup
echo "Creating backup of $DB_FILE..."
cp "$DB_FILE" "$BACKUP_FILE"

# Verify backup was created
if [ -f "$BACKUP_FILE" ]; then
    BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "Backup created successfully!"
    echo "  Location: $BACKUP_FILE"
    echo "  Size: $BACKUP_SIZE"

    # List recent backups
    echo ""
    echo "Recent backups:"
    ls -lht "$BACKUP_DIR" | head -6
else
    echo "Error: Backup failed"
    exit 1
fi

# Optional: Remove backups older than 30 days
# find "$BACKUP_DIR" -name "quoxcore_*.db" -mtime +30 -delete
