[日本語版](../migration-to-commandmate.md)

# CommandMate Migration Guide

This document explains the migration procedure from MyCodeBranchDesk to CommandMate.

## Overview

MyCodeBranchDesk has been renamed to **CommandMate**. This is a branding update only and does not include functional changes.

### Key Changes

- Project name: `MyCodeBranchDesk` → `CommandMate`
- Environment variable prefix: `MCBD_*` → `CM_*`
- package.json name: `mycodebranch-desk` → `commandmate`

### Backward Compatibility

Thanks to the fallback mechanism, legacy environment variable names (`MCBD_*`) continue to work. However, deprecation warnings will be output in the logs at startup.

---

## Environment Variable Changes

Environment variable names have been changed from `MCBD_*` to `CM_*`.

> **Note**: For the official definition of environment variable mappings, refer to `ENV_MAPPING` in `src/lib/env.ts`.

### Server Base Settings (7 types)

| Old Name | New Name | Purpose | Default |
|----------|----------|---------|---------|
| `MCBD_ROOT_DIR` | `CM_ROOT_DIR` | Worktree root directory | Current directory |
| `MCBD_PORT` | `CM_PORT` | Server port | `3000` |
| `MCBD_BIND` | `CM_BIND` | Bind address | `127.0.0.1` |
| `MCBD_LOG_LEVEL` | `CM_LOG_LEVEL` | Log level | `info` (production) / `debug` (development) |
| `MCBD_LOG_FORMAT` | `CM_LOG_FORMAT` | Log format | `text` |
| `MCBD_LOG_DIR` | `CM_LOG_DIR` | Log directory | `./data/logs` |
| `MCBD_DB_PATH` | `CM_DB_PATH` | DB file path | `./data/cm.db` |

> **Note**: `CM_AUTH_TOKEN` / `MCBD_AUTH_TOKEN` / `NEXT_PUBLIC_CM_AUTH_TOKEN` were deprecated in Issue #179. Reverse proxy authentication is recommended for external access. See the [Security Guide](../security-guide.md) for details.

---

## Migration Steps

### 1. Migrate Environment Variables

Update your `.env` file to use the new environment variable names.

```bash
# Option 1: Bulk replace with sed
sed -i '' 's/MCBD_/CM_/g' .env

# Option 2: Edit manually
# Open .env file and change MCBD_ prefix to CM_
```

**Example:**
```bash
# Before
MCBD_ROOT_DIR=/path/to/repos
MCBD_PORT=3000
MCBD_BIND=127.0.0.1

# After
CM_ROOT_DIR=/path/to/repos
CM_PORT=3000
CM_BIND=127.0.0.1
```

> **Note**: Thanks to the fallback mechanism, legacy names will continue to work, but deprecation warnings will be output.

### 2. Update Git Remote (After Issue #80 Completion)

> **Important**: Execute this step after Issue #80 (GitHub repository name change) is completed.

```bash
# For HTTPS
git remote set-url origin https://github.com/Kewton/CommandMate.git

# For SSH
git remote set-url origin git@github.com:Kewton/CommandMate.git

# Verify
git remote -v
```

### 3. Update Local Directory Name (Optional)

If you want to rename the directory:

```bash
# Move to parent directory
cd ..

# Rename directory
mv MyCodeBranchDesk commandmate

# Move to new directory
cd commandmate
```

> **Note**: This step is optional. The application will work correctly without renaming the directory.

### 4. Update Docker Environment (If Applicable)

If using Docker, update the environment variables in `docker-compose.yml`.

```yaml
# Before
environment:
  - MCBD_ROOT_DIR=/app/repos
  - MCBD_PORT=3000

# After
environment:
  - CM_ROOT_DIR=/app/repos
  - CM_PORT=3000
```

---

## systemd Service Migration

If using systemd in a production environment, follow these steps to migrate the service name.

> **Note**: Service names may vary by environment. The examples below use `mycodebranch-desk`, but replace with your actual service name.

### 1. Stop Current Service

```bash
sudo systemctl stop mycodebranch-desk
sudo systemctl disable mycodebranch-desk
```

### 2. Rename Service File

```bash
sudo mv /etc/systemd/system/mycodebranch-desk.service \
        /etc/systemd/system/commandmate.service
```

### 3. Update Service File Configuration

Edit `/etc/systemd/system/commandmate.service` and update:

- `Description=`: `MyCodeBranchDesk` → `CommandMate`
- `WorkingDirectory=`: Update if directory name was changed
- `Environment=`: `MCBD_*` → `CM_*` (optional, fallback available)

**Security Recommendations:**

When exposing externally, set up reverse proxy authentication. See the [Security Guide](../security-guide.md) for details.

### 4. Reload systemd and Start New Service

```bash
sudo systemctl daemon-reload
sudo systemctl enable commandmate
sudo systemctl start commandmate
sudo systemctl status commandmate
```

### 5. Remove Old Service File (Optional)

```bash
# If old file remains
sudo rm /etc/systemd/system/mycodebranch-desk.service
sudo systemctl daemon-reload
```

---

## Claude Code Settings Update

> **Note**: If you did not change the directory name, no Claude Code settings update is needed.

If `.claude/settings.local.json` contains project paths, updating is required:

```bash
# Only run if directory name was changed
sed -i '' 's/MyCodeBranchDesk/commandmate/g' .claude/settings.local.json
```

**Update needed when:**
- You changed the project directory name from `MyCodeBranchDesk` to `commandmate`, etc.

**No update needed when:**
- You kept the directory name as-is
- `.claude/settings.local.json` does not exist

> **Note**: Absolute paths are environment-dependent, so each developer should verify individually.

---

## Backward Compatibility Support

### Fallback Mechanism

Legacy environment variable names (`MCBD_*`) continue to work through the fallback mechanism.

- When new name (`CM_*`) is set: Uses the new name's value
- When new name is not set but old name is set: Uses the old name's value (with warning)
- When neither is set: Uses default value

### Deprecation Warnings

When using legacy names, warnings like the following are output in logs:

```
[DEPRECATED] MCBD_ROOT_DIR is deprecated, use CM_ROOT_DIR instead
```

> **Note**: Warnings for the same key are output only once at application startup (to prevent log pollution).

### End of Support Schedule

| Item | Details |
|------|---------|
| Current support | `MCBD_*` environment variables work via fallback |
| **End of support** | **Next major version (v2.0.0)** will end legacy name support |
| Fallback period | Support continues for 1 major version after official release |

> **Important**: From v2.0.0 onwards, if you continue using legacy names (`MCBD_*`), the application will treat them as unset and use default values. Be sure to complete migration to `CM_*` before upgrading to v2.0.0.

### DATABASE_PATH Deprecation

The `DATABASE_PATH` environment variable has been deprecated and unified to `CM_DB_PATH`.

**Migration Steps**:

1. Change `DATABASE_PATH` to `CM_DB_PATH` in your `.env` file
2. The old DB file (`db.sqlite`) will be automatically migrated to the new path (`cm.db`)
3. Re-running `commandmate init` will set `CM_DB_PATH` with an absolute path

**Example:**
```bash
# Before
DATABASE_PATH=./data/db.sqlite

# After (global install)
CM_DB_PATH=~/.commandmate/data/cm.db

# After (local install)
CM_DB_PATH=/path/to/project/data/cm.db
```

> **Note**: Using `DATABASE_PATH` will output deprecation warnings. It will be completely removed in v2.0.0.

---

## Troubleshooting

### Common Issues

#### 1. Application Won't Start

**Cause**: Required environment variables may not be set.

**Solution**:
```bash
# Check environment variables
env | grep -E '^(CM_|MCBD_)'

# Check .env file contents
cat .env
```

#### 2. Excessive Deprecation Warnings

**Cause**: Multiple legacy environment variables are set.

**Solution**: Update `.env` file to `CM_*`.

```bash
sed -i '' 's/MCBD_/CM_/g' .env
```

#### 3. External Access Security

When exposing externally with `CM_BIND=0.0.0.0`, set up reverse proxy authentication.

**Solution**:
- Use Nginx + Basic Auth, Cloudflare Access, Tailscale, etc.
- See the [Security Guide](../security-guide.md) for details

### Checking Logs

```bash
# Check application logs
tail -f data/logs/app.log

# When using systemd
journalctl -u commandmate -f
```

---

## Related Links

- [CHANGELOG](../../CHANGELOG.md) - Change history
- [README](../../README.md) - Project overview
- [Architecture](./architecture.md) - System design
- [Deployment Guide](./DEPLOYMENT.md) - Production deployment
