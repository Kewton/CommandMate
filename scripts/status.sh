#!/bin/bash
#
# CommandMate - Status Script
# Shows application status and health
#

APP_NAME="commandmate"

echo "CommandMate Status"
echo "=================="
echo ""

# Check PM2 status
if command -v pm2 &> /dev/null; then
  if pm2 list | grep -q "$APP_NAME"; then
    echo "PM2 Status:"
    pm2 status "$APP_NAME"
    echo ""
  else
    echo "PM2: Not running"
    echo ""
  fi
fi

# Check port
# Support both CM_PORT and legacy MCBD_PORT
PORT=${CM_PORT:-${MCBD_PORT:-3000}}
if lsof -ti:$PORT &> /dev/null; then
  PID=$(lsof -ti:$PORT)
  echo "Process:"
  echo "  Port: $PORT"
  echo "  PID: $PID"
  echo ""
else
  echo "Process: Not running on port $PORT"
  echo ""
fi

# Check health endpoint
echo "Health Check:"
if command -v curl &> /dev/null; then
  HEALTH_URL="http://localhost:$PORT/"
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "  ✓ Application is healthy (HTTP $HTTP_CODE)"
  elif [ "$HTTP_CODE" = "000" ]; then
    echo "  ✗ Cannot connect to application"
  else
    echo "  ! Unexpected response (HTTP $HTTP_CODE)"
  fi
else
  echo "  ! curl not available, cannot check health"
fi
echo ""

# Check database
# Issue #135: Support CM_DB_PATH with fallback to DATABASE_PATH
DB_PATH="${CM_DB_PATH:-${DATABASE_PATH:-./data/cm.db}}"
if [ -f "$DB_PATH" ]; then
  DB_SIZE=$(du -h "$DB_PATH" | cut -f1)
  echo "Database:"
  echo "  Path: $DB_PATH"
  echo "  Size: $DB_SIZE"
else
  echo "Database: Not found"
fi
echo ""
