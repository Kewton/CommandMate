#!/bin/bash
#
# CommandMate - Health Check Script
# Comprehensive health check for monitoring systems
#

set -e

# Support both CM_PORT and legacy MCBD_PORT
PORT=${CM_PORT:-${MCBD_PORT:-3000}}
HEALTH_URL="http://localhost:$PORT/"
EXIT_CODE=0

echo "CommandMate Health Check"
echo "=============================="
echo ""

# Check if application is running
echo -n "Checking if application is running... "
if lsof -ti:$PORT &> /dev/null; then
  echo "✓"
else
  echo "✗ (not running on port $PORT)"
  EXIT_CODE=1
fi

# Check HTTP endpoint
echo -n "Checking HTTP endpoint... "
if command -v curl &> /dev/null; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$HEALTH_URL" 2>/dev/null || echo "000")

  if [ "$HTTP_CODE" = "200" ]; then
    echo "✓ (HTTP $HTTP_CODE)"
  else
    echo "✗ (HTTP $HTTP_CODE)"
    EXIT_CODE=1
  fi
else
  echo "! (curl not available)"
fi

# Check database
echo -n "Checking database... "
DB_PATH="${DATABASE_PATH:-./data/db.sqlite}"
if [ -f "$DB_PATH" ]; then
  if [ -r "$DB_PATH" ] && [ -w "$DB_PATH" ]; then
    echo "✓ ($DB_PATH)"
  else
    echo "✗ (permission issue)"
    EXIT_CODE=1
  fi
else
  echo "✗ (not found)"
  EXIT_CODE=1
fi

# Check disk space
echo -n "Checking disk space... "
DISK_USAGE=$(df -h . | awk 'NR==2 {print $5}' | sed 's/%//')
if [ "$DISK_USAGE" -lt 90 ]; then
  echo "✓ (${DISK_USAGE}% used)"
else
  echo "! (${DISK_USAGE}% used - low space)"
  EXIT_CODE=1
fi

# Check memory (if available)
if command -v free &> /dev/null; then
  echo -n "Checking memory... "
  MEM_USAGE=$(free | grep Mem | awk '{printf("%.0f", $3/$2 * 100)}')
  if [ "$MEM_USAGE" -lt 90 ]; then
    echo "✓ (${MEM_USAGE}% used)"
  else
    echo "! (${MEM_USAGE}% used - high usage)"
  fi
fi

echo ""

if [ $EXIT_CODE -eq 0 ]; then
  echo "Overall: ✓ Healthy"
else
  echo "Overall: ✗ Unhealthy"
fi

exit $EXIT_CODE
