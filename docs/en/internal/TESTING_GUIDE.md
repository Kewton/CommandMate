[日本語版](../../internal/TESTING_GUIDE.md)

# CommandMate Testing and Verification Guide

This guide describes how to verify CommandMate's operation.

## Table of Contents

1. [Environment Preparation](#environment-preparation)
2. [Starting the Development Server](#starting-the-development-server)
3. [Basic Operation Verification](#basic-operation-verification)
4. [API Endpoint Testing](#api-endpoint-testing)
5. [WebSocket Testing](#websocket-testing)
6. [UI Verification](#ui-verification)
7. [Troubleshooting](#troubleshooting)

## Environment Preparation

### 1. Environment Variable Configuration

Create a `.env` file for the development environment:

```bash
# Create .env file
cat > .env << 'EOF'
# Development environment settings
CM_ROOT_DIR=/Users/yourname/projects
CM_PORT=3000
CM_BIND=127.0.0.1
CM_DB_PATH=./data/cm.db
NODE_ENV=development
EOF
```

**Important**: Change `CM_ROOT_DIR` to the actual directory where your git worktrees are located.

> **Note**: Legacy environment variable names (`MCBD_*`) are still supported for backward compatibility, but using the new names (`CM_*`) is recommended.

### 2. Database Initialization

```bash
# Create data directory
mkdir -p data

# Initialize database
npm run db:init
```

### 3. Dependency Verification

```bash
# Check if dependencies are installed
npm list --depth=0
```

## Starting the Development Server

### Method 1: Normal Start (Foreground)

```bash
# Start development server
npm run dev
```

After starting, the following message will appear:
```
WebSocket server initialized
> Ready on http://localhost:3000
> WebSocket server ready
```

### Method 2: Background Start

```bash
# Start in background
npm run dev > dev.log 2>&1 &

# Check logs
tail -f dev.log
```

### Server Verification

```bash
# Check if the port is in use
lsof -i:3000

# Check the process
ps aux | grep "tsx server.ts"
```

## Basic Operation Verification

### 1. HTTP Endpoint Check

```bash
# Access the homepage
curl http://localhost:3000/

# Check status code only
curl -I http://localhost:3000/
```

HTTP 200 is returned on success.

### 2. Health Check

```bash
# Basic health check
curl -s http://localhost:3000/ | grep -q "<!DOCTYPE html" && echo "OK: Server is healthy" || echo "ERROR: Server error"
```

## API Endpoint Testing

### 1. Get Worktree List

```bash
# Get worktree list
curl -s http://localhost:3000/api/worktrees | jq .
```

**Expected output**:
```json
[
  {
    "id": "worktree-id",
    "path": "/path/to/worktree",
    "branch": "main",
    "sessionId": null,
    "lastActivity": "2025-01-17T12:00:00.000Z"
  }
]
```

### 2. Get Messages

```bash
# Get messages for a specific worktree
WORKTREE_ID="your-worktree-id"
curl -s "http://localhost:3000/api/worktrees/${WORKTREE_ID}/messages" | jq .
```

### 3. Send a Message

```bash
# Send a message
WORKTREE_ID="your-worktree-id"
curl -X POST http://localhost:3000/api/worktrees/${WORKTREE_ID}/send \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Hello, Claude!",
    "summary": "Test message"
  }' | jq .
```

### 4. Get Log File List

```bash
# Get log file list
WORKTREE_ID="your-worktree-id"
curl -s "http://localhost:3000/api/worktrees/${WORKTREE_ID}/logs" | jq .
```

## WebSocket Testing

### Using a Node.js Script

Create a file called `test-websocket.js`:

```javascript
const WebSocket = require('ws');

const ws = new WebSocket('ws://localhost:3000');

ws.on('open', () => {
  console.log('OK: WebSocket connected');

  // Subscribe to worktree
  ws.send(JSON.stringify({
    type: 'subscribe',
    worktreeIds: ['your-worktree-id']
  }));

  console.log('OK: Subscribed to worktree');
});

ws.on('message', (data) => {
  console.log('OK: Received message:', JSON.parse(data.toString()));
});

ws.on('error', (error) => {
  console.error('ERROR: WebSocket error:', error);
});

ws.on('close', () => {
  console.log('WebSocket closed');
});

// Close connection after 10 seconds
setTimeout(() => {
  ws.close();
  process.exit(0);
}, 10000);
```

Run:

```bash
node test-websocket.js
```

### Using wscat (Optional)

```bash
# Install wscat
npm install -g wscat

# Connect to WebSocket
wscat -c ws://localhost:3000

# After connecting, send:
{"type":"subscribe","worktreeIds":["your-worktree-id"]}
```

## UI Verification

### 1. Browser Access

Access the following URL in a browser:

```
http://localhost:3000
```

### 2. Worktree List Page Verification

Verify the following:

- [ ] Page header is displayed
- [ ] "CommandMate" title is displayed
- [ ] Worktree list is displayed (when data exists)
- [ ] Search box is displayed
- [ ] Sort buttons (Name, Updated, Path) are displayed
- [ ] Refresh button is displayed

### 3. Worktree Detail Page Verification

Click a worktree card to navigate to the detail page:

```
http://localhost:3000/worktrees/[worktree-id]
```

Verify the following:

- [ ] Back button is displayed
- [ ] Tabs (Messages, Log Files) are displayed
- [ ] Message input form is displayed
- [ ] Sidebar information is displayed
- [ ] Quick Actions are displayed

### 4. Message Sending Test

1. Enter "Hello, Claude!" in the message input field
2. Click the [Send Message] button
3. Verify the message is sent and displayed in the chat screen

### 5. Log Viewer Test

1. Click the [Log Files] tab
2. Verify the log file list is displayed
3. Click a log file and verify its contents are displayed

## Automated Test Execution

### Unit Tests

```bash
# Run unit tests
npm run test:unit

# Run with coverage
npm run test:coverage
```

**Expected results**:
- 75 tests pass
- Coverage: 80% or higher

### Integration Tests

```bash
# Run integration tests
npm run test:integration
```

**Expected results**:
- 40+ tests pass
- API endpoints work correctly

### E2E Tests

```bash
# Run E2E tests
npm run test:e2e

# Run with a specific browser
npm run test:e2e -- --project=chromium
npm run test:e2e -- --project=webkit
```

**Expected results**:
- 24 tests pass
- UI displays correctly

## Troubleshooting

### Server Won't Start

```bash
# If the port is in use
lsof -ti:3000 | xargs kill -9

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install

# Clean up the build
rm -rf .next
npm run build
```

### Database Errors

```bash
# Reset the database
rm -f data/db.sqlite
npm run db:init
```

### Worktrees Not Detected

Verify that `CM_ROOT_DIR` is correctly set:

```bash
# Check environment variable
cat .env | grep CM_ROOT_DIR

# Check if the directory exists
ls -la $CM_ROOT_DIR

# Check if git worktrees exist
cd $CM_ROOT_DIR && git worktree list
```

### WebSocket Connection Errors

```bash
# Check if the WebSocket server is running
curl -I \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  http://localhost:3000/

# Check errors in the browser console
# Developer Tools > Console tab
```

### External Access Security

When making externally accessible, configure reverse proxy authentication.
See the [Security Guide](../../docs/security-guide.md) for details.

## Performance Checks

### Page Load Time

Check using browser developer tools:

1. Press F12 to open developer tools
2. Open the Network tab
3. Reload the page
4. Check DOMContentLoaded and Load times

**Goals**:
- DOMContentLoaded: < 1 second
- Load: < 2 seconds

### Memory Usage

```bash
# Check Node.js process memory usage
ps aux | grep "tsx server.ts" | awk '{print $6}'
```

**Goal**: < 500MB

### Database Size

```bash
# Check database size
du -h data/db.sqlite
```

## Completion Checklist

After completing all verifications, check the following:

- [ ] Development server starts
- [ ] HTTP endpoints are accessible
- [ ] Worktree list can be retrieved
- [ ] Messages can be sent and received
- [ ] WebSocket connection works
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] E2E tests pass
- [ ] UI displays correctly
- [ ] No errors in browser console

## Next Steps

After verification is complete:

1. **Deploy to Production**
   - See the [Deployment Guide](../DEPLOYMENT.md)
   - Check the [Production Checklist](./PRODUCTION_CHECKLIST.md)

2. **Customization**
   - Customize UI components
   - Adjust Claude CLI settings
   - Customize tmux settings

3. **Monitoring**
   - Monitor logs
   - Track performance
   - Monitor errors

---

If issues occur, please report them on [GitHub Issues](https://github.com/kewton/CommandMate/issues).
