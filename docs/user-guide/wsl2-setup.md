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

### Install Node.js (v20+)

We recommend using [nvm](https://github.com/nvm-sh/nvm) for Node.js version management:

```bash
# Install nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Reload shell
source ~/.bashrc

# Install Node.js 20
nvm install 20
nvm use 20

# Verify
node -v   # v20.x.x
npm -v
```

---

## 3. Clone & Build

```bash
# Clone the repository
git clone https://github.com/Kewton/CommandMate.git
cd CommandMate

# Install dependencies
npm install

# Build
npm run build:all
```

---

## 4. Initialize & Start

```bash
# Initialize (interactive setup)
npx commandmate init

# Start the server
npx commandmate start --daemon
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
CM_BIND=0.0.0.0 npx commandmate start --daemon
```

---

## 6. Development Mode

For development with hot-reload:

```bash
cd CommandMate

# Start dev server
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
nvm install 20
nvm use 20
node -v
```

### Port already in use

```bash
# Check what is using the port
ss -tlnp | grep :3000

# Stop the existing server
npx commandmate stop
```

### Cannot access from Windows browser

1. Check the server is running: `npx commandmate status`
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
