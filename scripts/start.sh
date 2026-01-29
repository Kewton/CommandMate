#!/bin/bash
#
# CommandMate - Start Script
# Starts the application using PM2 or direct npm start
#

set -e

APP_NAME="commandmate"

echo "Starting CommandMate..."

# Check if PM2 is available
if command -v pm2 &> /dev/null; then
  echo "Using PM2..."

  # Check if already running
  if pm2 list | grep -q "$APP_NAME"; then
    echo "Application is already running!"
    pm2 status "$APP_NAME"
    exit 0
  fi

  # Start with PM2
  pm2 start npm --name "$APP_NAME" -- start

  echo "✓ Application started with PM2"
  echo ""
  echo "Useful commands:"
  echo "  - View logs: pm2 logs $APP_NAME"
  echo "  - Monitor: pm2 monit"
  echo "  - Status: pm2 status"
  echo "  - Stop: ./scripts/stop.sh"
  echo ""
  echo "To enable auto-restart on system boot:"
  echo "  pm2 startup"
  echo "  pm2 save"

else
  echo "PM2 not found, starting directly..."
  echo "Note: Application will run in foreground. Press Ctrl+C to stop."
  echo ""
  npm start
fi
