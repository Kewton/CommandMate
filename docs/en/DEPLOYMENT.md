[日本語版](../DEPLOYMENT.md)

# CommandMate Deployment Guide

This document explains the procedures for deploying CommandMate to a production environment.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Setup Procedure](#setup-procedure)
3. [Development Environment Setup](#development-environment-setup)
4. [Environment Variable Configuration](#environment-variable-configuration)
5. [Build and Deploy](#build-and-deploy)
6. [Process Management](#process-management)
7. [Security](#security)
8. [Troubleshooting](#troubleshooting)

## Prerequisites

The following tools must be installed:

| Tool | Version | Required | Check Command |
|------|---------|----------|---------------|
| Node.js | v20+ | ✓ | `node -v` |
| npm | - | ✓ | `npm -v` |
| Git | - | ✓ | `git --version` |
| tmux | - | ✓ | `tmux -V` |
| openssl | - | ✓ | `openssl version` |
| Claude CLI | - | △ | `claude --version` |

## Setup Procedure

### npm Global Install (Recommended)

The simplest method.

```bash
# Install
npm install -g commandmate

# Initial setup (interactive)
commandmate init

# Start server
commandmate start --daemon
```

Access http://localhost:3000 in your browser.

### CLI Commands

| Command | Description |
|---------|-------------|
| `commandmate init` | Initial setup (interactive) |
| `commandmate init --defaults` | Initial setup (default values) |
| `commandmate start --daemon` | Start in background |
| `commandmate start --port 3001` | Start on a specific port |
| `commandmate stop` | Stop server |
| `commandmate status` | Check status |

For details, see the [CLI Setup Guide](./user-guide/cli-setup-guide.md).

---

## Development Environment Setup

> **Note**: The following is for developers and contributors. For general use, the npm global install above is recommended.

### Automated Setup

```bash
git clone https://github.com/kewton/CommandMate.git
cd CommandMate
./scripts/setup.sh  # Automated: dependency check, env config, build, and start
```

`setup.sh` automatically executes:
1. Dependency check (`preflight-check.sh`)
2. npm dependency installation
3. Interactive environment configuration (`setup-env.sh`)
4. Database initialization, build, and start (`build-and-start.sh --daemon`)

### Manual Setup

For customization, you can set up manually:

#### 1. Clone the Repository

```bash
git clone https://github.com/kewton/CommandMate.git
cd CommandMate
```

#### 2. Check Dependencies

```bash
./scripts/preflight-check.sh
```

#### 3. Install npm Dependencies

```bash
npm install
```

#### 4. Configure Environment Variables

**Interactive Setup (Recommended)**:

```bash
./scripts/setup-env.sh
```

Interactively configures:
- `CM_ROOT_DIR`: Worktree root directory
- `CM_PORT`: Server port (default: 3000)
- `CM_BIND`: Bind address (0.0.0.0 when external access is enabled)

**Manual Setup**:

```bash
cp .env.production.example .env
# Edit .env
```

> **Note**: Legacy environment variable names (`MCBD_*`) are still supported for backward compatibility, but using the new names (`CM_*`) is recommended.
>
> **Important**: When exposing externally with `CM_BIND=0.0.0.0`, setting up reverse proxy authentication is recommended. See the [Security Guide](../security-guide.md) for details.

#### 5. Initialize the Database

```bash
npm run db:init
```

#### 6. Build

```bash
npm run build
```

> **Note**: `./scripts/*` scripts are only available in the development environment (git clone). For global installations, use the `commandmate` CLI.

## Environment Variable Configuration

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `CM_ROOT_DIR` | Worktree root directory | `/home/user/projects` |
| `CM_BIND` | Bind address (use `0.0.0.0` for production) | `0.0.0.0` |

### Optional Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CM_PORT` | Server port | `3000` |
| `CM_DB_PATH` | SQLite database path | Global: `~/.commandmate/data/cm.db`, Local: `./data/cm.db` |
| `CM_LOG_LEVEL` | Log level | `info` |
| `CM_LOG_FORMAT` | Log format | `json` |

> **Note**: Legacy names (`MCBD_*`) are also supported for backward compatibility. See `.env.example` for details.

## Build and Deploy

### Production Build

```bash
# Build
npm run build

# Verify the build
npm run start
```

### Process Management (PM2 Recommended)

PM2 deployment example:

```bash
# Install PM2
npm install -g pm2

# Start the application
pm2 start npm --name "commandmate" -- start

# Configure auto-startup
pm2 startup
pm2 save

# Check status
pm2 status

# View logs
pm2 logs commandmate

# Restart
pm2 restart commandmate

# Stop
pm2 stop commandmate
```

### Systemd Service (Optional)

`/etc/systemd/system/commandmate.service`:

```ini
[Unit]
Description=CommandMate
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/CommandMate
Environment=NODE_ENV=production
ExecStart=/usr/bin/npm start
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Start:

```bash
sudo systemctl enable commandmate
sudo systemctl start commandmate
sudo systemctl status commandmate
```

## Security

### Reverse Proxy Authentication (Recommended)

When exposing externally with `CM_BIND=0.0.0.0`, set up reverse proxy authentication. See the [Security Guide](../security-guide.md) for details.

### Firewall Configuration

Open only the required ports:

```bash
# UFW (Ubuntu/Debian)
sudo ufw allow 3000/tcp

# firewalld (RHEL/CentOS)
sudo firewall-cmd --permanent --add-port=3000/tcp
sudo firewall-cmd --reload
```

### Reverse Proxy (Nginx)

Nginx configuration example:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket support
    location /ws {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_set_header Host $host;
    }
}
```

### HTTPS Configuration (Let's Encrypt)

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

## Troubleshooting

### WebSocket Errors in Development Mode (Mobile Access)

When accessing from a mobile browser in development mode (`npm run dev`), you may see errors like:

```
⨯ uncaughtException: RangeError: Invalid WebSocket frame: invalid status code XXXXX
```

**Cause**: Next.js HMR (Hot Module Replacement) WebSocket receives an invalid close frame from the mobile browser.

**Solution**: Use **production mode** when accessing from mobile:

```bash
npm run build
npm start
```

> **Note**: This error does not affect server operation (no crash).
> In development mode, HMR is enabled, so this type of error log cannot be fully suppressed.

### Server Won't Stop with Ctrl+C

When WebSocket connections are active, graceful shutdown may take time.

**Solution**:
- First Ctrl+C initiates shutdown (completes within 3 seconds)
- Second Ctrl+C forces termination
- Or forcefully terminate with:

```bash
lsof -ti:3000 | xargs kill -9
```

### Port Already in Use

```bash
# Check port usage
lsof -ti:3000

# Kill the process
kill -9 $(lsof -ti:3000)
```

### Database Errors

```bash
# Reset the database
npm run db:reset
```

### Checking Logs

```bash
# When using PM2
pm2 logs commandmate

# When using Systemd
sudo journalctl -u commandmate -f
```

### Permission Errors

```bash
# Set data directory permissions
chmod 755 data
chmod 644 data/db.sqlite
```

## Update Procedure

### npm Global Install

```bash
# Stop server
commandmate stop

# Upgrade to latest version
npm install -g commandmate@latest

# Restart server
commandmate start --daemon
```

### Development Environment (git clone)

```bash
# Get latest code
git pull origin main

# Update dependencies
npm install

# Build
npm run build

# When using PM2
pm2 restart commandmate

# When using Systemd
sudo systemctl restart commandmate
```

## Backup

Regular backups are recommended:

```bash
# Database backup
cp data/db.sqlite data/db.sqlite.backup.$(date +%Y%m%d)

# Environment variable backup
cp .env .env.backup
```

## Monitoring

### Health Check

```bash
curl http://localhost:3000/
```

### PM2 Monitoring

```bash
pm2 monit
```

## Support

If you encounter issues:

1. [GitHub Issues](https://github.com/kewton/CommandMate/issues)
2. Check log files
3. Verify environment variables

---

**Note**: When exposing to external networks in production, always configure reverse proxy authentication and HTTPS. See the [Security Guide](../security-guide.md) for details.
