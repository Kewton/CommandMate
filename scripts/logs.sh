#!/bin/bash
#
# CommandMate - Logs Script
# View application logs
#

APP_NAME="commandmate"

# Check if using PM2
if command -v pm2 &> /dev/null; then
  if pm2 list | grep -q "$APP_NAME"; then
    echo "Showing PM2 logs (Ctrl+C to exit)..."
    echo ""
    pm2 logs "$APP_NAME" --lines 100
    exit 0
  fi
fi

# Check if using systemd
if systemctl is-active --quiet commandmate 2>/dev/null; then
  echo "Showing systemd logs (Ctrl+C to exit)..."
  echo ""
  sudo journalctl -u commandmate -f
  exit 0
fi

echo "No logs found. Application may not be running with PM2 or systemd."
echo ""
echo "If running directly with npm start, logs are in the terminal."
