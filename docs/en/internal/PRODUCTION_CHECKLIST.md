[日本語版](../../internal/PRODUCTION_CHECKLIST.md)

# CommandMate Production Environment Checklist

Please review this checklist before deploying to a production environment.

## Installation Method Selection

### npm Global Install (Recommended)

```bash
npm install -g commandmate
commandmate init
commandmate start --daemon
```

For details, see the [CLI Setup Guide](../user-guide/cli-setup-guide.md).

### Development Environment (git clone)

For contributors or self-building, see the [Deployment Guide](../DEPLOYMENT.md#development-environment-setup).

---

## Pre-Deployment Checklist

### 1. Environment Configuration

- [ ] `.env` file is created with appropriate values
- [ ] `CM_ROOT_DIR` correctly points to the worktree root directory
- [ ] `CM_BIND=0.0.0.0` is set (if allowing external access)
- [ ] Reverse proxy authentication is configured for external access (recommended, details: `docs/security-guide.md`)
- [ ] `CM_DB_PATH` points to an appropriate location
- [ ] `NODE_ENV=production` is set
- [ ] `.env` file is included in `.gitignore` (security)

### 2. System Requirements

- [ ] Dependency check succeeds
  ```bash
  # For npm global install
  commandmate init  # Automatically checks dependencies

  # For development environment (git clone) only
  ./scripts/preflight-check.sh
  ```
- [ ] Node.js 20.x or later is installed
  ```bash
  node -v
  ```
- [ ] npm is installed
- [ ] Git is installed
- [ ] tmux is installed
- [ ] openssl is installed
- [ ] Claude CLI (Claude Code) is installed (optional)
  ```bash
  claude --version
  ```

### 3. Dependencies and Build

- [ ] Dependencies are installed
  ```bash
  npm install
  ```
- [ ] Production build succeeds
  ```bash
  npm run build
  ```
- [ ] No TypeScript compilation errors
- [ ] No ESLint warnings or errors
  ```bash
  npm run lint
  ```

### 4. Database

- [ ] Data directory is created
  ```bash
  mkdir -p data
  ```
- [ ] Database is initialized
  ```bash
  npm run db:init
  ```
- [ ] Database file permissions are appropriate
  ```bash
  chmod 755 data
  chmod 644 data/db.sqlite
  ```
- [ ] Database backup strategy is determined

### 5. Tests

- [ ] All unit tests pass
  ```bash
  npm run test:unit
  ```
- [ ] Integration tests pass
  ```bash
  npm run test:integration
  ```
- [ ] E2E tests pass (optional)
  ```bash
  npm run test:e2e
  ```

### 6. Security

- [ ] Reverse proxy authentication is configured for external access (details: `docs/security-guide.md`)
- [ ] Firewall is properly configured
  ```bash
  # UFW (Ubuntu/Debian)
  sudo ufw allow 3000/tcp

  # firewalld (RHEL/CentOS)
  sudo firewall-cmd --permanent --add-port=3000/tcp
  sudo firewall-cmd --reload
  ```
- [ ] SSL certificate is configured if using HTTPS
- [ ] Reverse proxy such as Nginx is configured (recommended)

### 7. Process Management

#### Using PM2

- [ ] PM2 is installed
  ```bash
  npm install -g pm2
  ```
- [ ] Application starts with PM2
  ```bash
  ./scripts/start.sh
  ```
- [ ] PM2 auto-start is configured
  ```bash
  pm2 startup
  pm2 save
  ```

#### Using Systemd

- [ ] Systemd service file is created
- [ ] Service is enabled
  ```bash
  sudo systemctl enable commandmate
  sudo systemctl start commandmate
  ```

### 8. Monitoring and Logs

- [ ] Log output destination is confirmed
  ```bash
  ./scripts/logs.sh
  ```
- [ ] Health check is working
  ```bash
  ./scripts/health-check.sh
  ```
- [ ] Status check is working
  ```bash
  ./scripts/status.sh
  ```
- [ ] Log rotation is configured (optional)

### 9. Backup

- [ ] Database backup script is configured
  ```bash
  # Example: crontab
  0 2 * * * cp /path/to/data/db.sqlite /path/to/backup/db.sqlite.$(date +\%Y\%m\%d)
  ```
- [ ] `.env` file backup exists
- [ ] Backup restoration procedure is documented

### 10. Network and Access

- [ ] Application starts on localhost
  ```bash
  curl http://localhost:3000
  ```
- [ ] Accessible from external sources (if required)
  ```bash
  curl http://<your-ip>:3000
  ```
- [ ] WebSocket connections work
- [ ] Accessible from mobile devices (if required)

### 11. Documentation

- [ ] README.md is up to date
- [ ] Deployment guide (`docs/DEPLOYMENT.md`) reviewed
- [ ] Architecture document (`docs/architecture.md`) reviewed
- [ ] Operations manual is prepared

### 12. Performance

- [ ] Build size is appropriate (First Load JS < 300kB)
- [ ] Page loading is fast
- [ ] WebSocket connections are stable
- [ ] Memory usage is appropriate

## Deployment Procedure

After completing the checklist, deploy using the following procedure:

### npm Global Install (Recommended)

#### Initial Deployment

```bash
# Install
npm install -g commandmate

# Initial setup (interactive)
commandmate init

# Start server
commandmate start --daemon

# Check status
commandmate status
```

#### Update Deployment

```bash
# Stop server
commandmate stop

# Upgrade
npm install -g commandmate@latest

# Start server
commandmate start --daemon
```

---

### Development Environment (git clone)

> **Note**: The following is for developers. `./scripts/*` scripts are only available in git clone environments.

#### Initial Deployment

1. **Run the setup script**
   ```bash
   ./scripts/setup.sh
   ```

2. **Configure environment variables**
   ```bash
   vi .env
   # Set required values
   ```

3. **Start the application**
   ```bash
   ./scripts/start.sh
   ```

4. **Check status**
   ```bash
   ./scripts/status.sh
   ```

5. **Health check**
   ```bash
   ./scripts/health-check.sh
   ```

#### Update Deployment

1. **Pull the latest code**
   ```bash
   git pull origin main
   ```

2. **Update dependencies**
   ```bash
   npm install
   ```

3. **Build**
   ```bash
   npm run build
   ```

4. **Restart**
   ```bash
   ./scripts/restart.sh
   ```

5. **Check status**
   ```bash
   ./scripts/status.sh
   ```

## Troubleshooting

### Application Won't Start

- [ ] Check the logs
  ```bash
  ./scripts/logs.sh
  ```
- [ ] Check if the port is in use
  ```bash
  lsof -ti:3000
  ```
- [ ] Verify environment variables are correctly set
  ```bash
  cat .env
  ```

### Database Errors

- [ ] Check if the database file exists
- [ ] Verify permissions are correct
- [ ] Re-initialize the database (caution: data will be deleted)
  ```bash
  npm run db:reset
  ```

### External Access Issues

- [ ] Verify reverse proxy authentication is configured (for external access)
- [ ] Check firewall settings

## Production Monitoring

### Items to Check Regularly

- [ ] **Daily**
  - Application status
  - Disk usage
  - Error logs

- [ ] **Weekly**
  - Database backup
  - Security updates
  - Performance metrics

- [ ] **Monthly**
  - Log cleanup
  - Dependency updates
  - Backup restoration test

## Post-Deployment Verification

After completing all checks, verify the following:

- [ ] Application is running normally
- [ ] Health check succeeds
- [ ] Accessible from a browser
- [ ] WebSocket connections work
- [ ] Authentication is functioning
- [ ] Worktree list is displayed
- [ ] Message sending and receiving works
- [ ] Log files are saved correctly

## Support

If issues occur:

1. Check the [Troubleshooting Guide](../DEPLOYMENT.md#troubleshooting)
2. Report on [GitHub Issues](https://github.com/kewton/CommandMate/issues)
3. Attach log files when asking questions

---

**Important**: In production environments, prioritize security. Always configure authentication tokens and strongly recommend using HTTPS.
