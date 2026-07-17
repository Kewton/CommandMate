[日本語版](../../user-guide/wsl2-setup.md)

# WSL2 Setup Guide (Windows)

CommandMate runs on Windows via WSL2 (Windows Subsystem for Linux).
Since CommandMate depends on tmux, WSL2 is required — native Windows is not supported.

---

## Prerequisites

- Windows 10 (version 2004+) or Windows 11
- WSL2 enabled with Ubuntu 22.04 or later
- Windows Terminal (recommended)

---

## 1. WSL2 Setup

If WSL2 is not yet installed, open **PowerShell as Administrator** and run:

```powershell
wsl --install -d Ubuntu
```

Restart your PC when prompted, then launch Ubuntu from the Start menu to complete the initial setup (username/password).

Verify WSL2 is active:

```powershell
wsl --list --verbose
```

The `VERSION` column should show `2`.

---

## 2. Install Dependencies

Open your WSL2 terminal (Ubuntu) and run:

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install required packages
sudo apt install -y git tmux build-essential
```

### Install GitHub CLI (gh)

Required for CommandMate's Issue integration features:

```bash
# Add the official GitHub repository and install
(type -p wget >/dev/null || (sudo apt update && sudo apt-get install wget -y)) \
  && sudo mkdir -p -m 755 /etc/apt/keyrings \
  && out=$(mktemp) && wget -nv -O$out https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  && cat $out | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
  && sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
  && sudo apt update \
  && sudo apt install gh -y

# Verify
gh --version

# Log in to GitHub
gh auth login
```

### Install Node.js (v22+)

> **Note:** Ubuntu's default `apt` repository ships an outdated Node.js.
> If you already have an old version installed via `apt`, remove it first:
>
> ```bash
> sudo apt remove -y nodejs npm
> sudo apt autoremove -y
> sudo rm -rf /usr/local/lib/node_modules
> sudo rm -rf /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx
> ```

We recommend using [nvm](https://github.com/nvm-sh/nvm) for Node.js version management:

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Reload shell
source ~/.bashrc

# Install latest LTS
nvm install --lts
nvm use --lts

# Verify (v22.x.x or later)
node -v
npm -v
```

---

## 3. Install CommandMate

```bash
# Install globally
npm install -g commandmate

# Verify
commandmate --version
```

> **Note:** Use a global install here rather than `npx`. `npx` unpacks CommandMate into the npm
> cache, so `start --daemon` would run the background server out of that cache directory — a later
> `npx` run or a cache clean can delete it out from under the running server. If you only want to
> try CommandMate first, use `npx commandmate@latest`. Bare `npx commandmate` reuses an
> already-installed global binary without ever checking the registry, so you may silently keep
> running an old version.

---

## 4. Initialize & Start

```bash
# Initialize (interactive setup)
commandmate init

# Start the server
commandmate start --daemon
```

The server starts at `http://localhost:3000` by default.

---

## 5. Access from Windows Browser

### localhost access (default)

In most WSL2 configurations, `localhost` is automatically forwarded to WSL2.
Open your Windows browser and navigate to:

```
http://localhost:3000
```

### If localhost does not work

If `localhost` forwarding is not working, find the WSL2 IP address:

```bash
# Run inside WSL2
hostname -I
```

Then access `http://<WSL2_IP>:3000` from your Windows browser.

To bind CommandMate to all interfaces (required if using the WSL2 IP):

```bash
CM_BIND=0.0.0.0 commandmate start --daemon
```

---

## 6. Development Mode

To work on CommandMate itself, build from source instead of installing globally:

```bash
# Clone the repository
git clone https://github.com/Kewton/CommandMate.git
cd CommandMate

# Install dependencies
npm install

# Start dev server (hot-reload)
npm run dev
```

Open `http://localhost:3000` in your Windows browser.

---

## Troubleshooting

### tmux not found

```bash
sudo apt install -y tmux
tmux -V
```

### Node.js version too old

```bash
# If the apt version is installed, remove it first
sudo apt remove -y nodejs npm && sudo apt autoremove -y

# Install the latest LTS via nvm
nvm install --lts
nvm use --lts
node -v
```

### better-sqlite3: NODE_MODULE_VERSION mismatch

If the Node.js version differs between `npm install` time and runtime, the following error occurs:

```
was compiled against a different Node.js version using
NODE_MODULE_VERSION 137. This version of Node.js requires
NODE_MODULE_VERSION 115.
```

**Cause:** After switching the Node.js version with `nvm`, the native module is left built for the old version.

**This normally recovers automatically (Issue #1263):** when the database connection hits this error, CommandMate runs `npm rebuild better-sqlite3` for you and continues. Only follow the steps below if the automatic rebuild fails.

**Solution:**

```bash
# Check the current Node version
node -v

# Rebuild the native module for the current version (global install)
npm rebuild -g better-sqlite3

# Restart
commandmate start
```

> **Tip:** Whenever you switch versions with `nvm`, always run `npm rebuild -g better-sqlite3`.
> If that still does not resolve it, reinstall with `npm install -g commandmate --force`.
> If you build from source (Development Mode), run `npm rebuild better-sqlite3` inside the repository instead.

### Port already in use

```bash
# Check what is using the port
ss -tlnp | grep :3000

# Stop the existing server
commandmate stop
```

### Cannot access from Windows browser

1. Check the server is running: `commandmate status`
2. Try the WSL2 IP address: `hostname -I`
3. Start with `CM_BIND=0.0.0.0` to bind to all interfaces
4. Check Windows Firewall is not blocking the port

### File permission issues

WSL2 mounts Windows drives under `/mnt/c/`, `/mnt/d/`, etc. For best performance and compatibility, **keep the repository inside the WSL2 filesystem** (e.g., `~/CommandMate`), not on a Windows-mounted path.

```bash
# Good - WSL2 native filesystem
cd ~
git clone https://github.com/Kewton/CommandMate.git

# Avoid - Windows mounted path (slower, permission issues)
# cd /mnt/c/Users/YourName/CommandMate
```
