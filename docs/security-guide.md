# CommandMate Security Guide

This guide describes security best practices for deploying CommandMate,
especially when exposing it to external networks.

---

## Threat Model

### Default Configuration (localhost only)

By default, CommandMate binds to `127.0.0.1` (localhost). In this mode:

- Only the local machine can access the server
- No authentication is required
- This is the recommended configuration for single-user development

### External Access (LAN / Internet)

When `CM_BIND=0.0.0.0` is set, the server becomes accessible from external networks.
**Without authentication, this exposes dangerous capabilities to anyone on the network:**

| Risk | Description |
|------|-------------|
| File read/write/delete | Arbitrary file operations within the worktree |
| Command execution | Execute commands via Claude CLI / tmux sessions |
| Source code exposure | Read any file in the managed repositories |
| Data manipulation | Modify database, delete worktrees |

**You MUST configure reverse proxy authentication before exposing CommandMate externally.**

---

## Quick Start: Built-in Token Authentication + HTTPS

CommandMate includes a built-in token authentication system that does not require
a reverse proxy. This is the simplest option for personal or small-team use.

### Step 1: Generate a TLS Certificate with mkcert

mkcert creates locally-trusted certificates for development and LAN use.

#### macOS

```bash
brew install mkcert
mkcert -install
mkcert localhost 192.168.x.x
```

Replace `192.168.x.x` with your actual LAN IP address. This generates
`localhost+1.pem` (certificate) and `localhost+1-key.pem` (private key).

#### Linux

Install mkcert using one of the following methods:

```bash
# Option A: apt (Debian/Ubuntu, if available in your distro)
sudo apt install mkcert

# Option B: Go install
go install filippo.io/mkcert@latest

# Option C: Download binary from GitHub Releases
curl -L https://github.com/FiloSottile/mkcert/releases/latest/download/mkcert-v1.4.4-linux-amd64 \
  -o /usr/local/bin/mkcert
chmod +x /usr/local/bin/mkcert
```

After installation, set up the local CA and generate a certificate:

```bash
mkcert -install
mkcert localhost <サーバーIP>
```

Replace `<サーバーIP>` with your server's LAN IP (e.g., `192.168.1.10`).

#### Distributing the CA Certificate to Client Devices (Linux)

Clients must trust the mkcert root CA to avoid browser warnings.

1. Find the CA file path on the server:

```bash
mkcert -CAROOT
# Example output: /root/.local/share/mkcert
```

2. Transfer `rootCA.pem` to each client device:

```bash
# From the server, copy to a client
scp "$(mkcert -CAROOT)/rootCA.pem" user@client-device:/tmp/commandmate-rootCA.pem
```

3. Install the CA on the client:

```bash
# Ubuntu/Debian
sudo cp /tmp/commandmate-rootCA.pem /usr/local/share/ca-certificates/commandmate-rootCA.crt
sudo update-ca-certificates

# RHEL/CentOS/Fedora
sudo cp /tmp/commandmate-rootCA.pem /etc/pki/ca-trust/source/anchors/commandmate-rootCA.pem
sudo update-ca-trust

# For browsers that use their own trust store (Firefox, Chrome on some distros),
# import rootCA.pem via the browser's certificate settings.
```

### Step 2: Start CommandMate with Token Authentication and HTTPS

```bash
commandmate start --auth --cert ./localhost+1.pem --key ./localhost+1-key.pem
```

- `--auth` enables the built-in token authentication
- `--cert` and `--key` specify the TLS certificate and private key

The server will print a one-time token URL to the console on first start.
Open the URL in your browser to authenticate and receive a session cookie.

---

## Recommended Authentication Methods

### Option 1: Nginx + Basic Auth (Recommended for LAN)

Simple and effective for home/office LAN access.

#### Setup Steps

1. Install Nginx:

```bash
# Ubuntu/Debian
sudo apt install nginx apache2-utils

# macOS
brew install nginx
```

2. Create a password file:

```bash
sudo htpasswd -c /etc/nginx/.htpasswd your_username
```

3. Configure Nginx:

```nginx
server {
    listen 443 ssl;
    server_name commandmate.local;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        auth_basic "CommandMate";
        auth_basic_user_file /etc/nginx/.htpasswd;

        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

4. Test and reload Nginx:

```bash
sudo nginx -t
sudo systemctl reload nginx
```

> **Note**: The `proxy_set_header Upgrade` and `Connection "upgrade"` directives
> are required for WebSocket support.

### Option 2: Cloudflare Access (Recommended for Internet)

Zero-trust access control without exposing ports.

1. Set up a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
2. Configure [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) policies
3. Point the tunnel to `http://localhost:3000`

Benefits:
- No open ports on your firewall
- SSO integration (Google, GitHub, etc.)
- Access logging and audit trail

### Option 3: Tailscale (Recommended for Personal Use)

Mesh VPN that creates a private network.

1. Install [Tailscale](https://tailscale.com/) on your server and devices
2. Access CommandMate via your Tailscale IP (e.g., `http://100.x.y.z:3000`)

Benefits:
- No configuration needed on CommandMate
- Encrypted end-to-end
- Works across NAT and firewalls

---

## Migration from CM_AUTH_TOKEN

The `CM_AUTH_TOKEN` authentication mechanism was removed in Issue #179 because
the token was exposed in client-side JavaScript (`NEXT_PUBLIC_CM_AUTH_TOKEN`),
making it visible in browser DevTools and build artifacts. This rendered the
authentication ineffective (security theater).

### Migration Steps

1. **Remove AUTH_TOKEN from .env**:

```bash
# Remove these lines from your .env file:
# CM_AUTH_TOKEN=...
# NEXT_PUBLIC_CM_AUTH_TOKEN=...
# MCBD_AUTH_TOKEN=...
# NEXT_PUBLIC_MCBD_AUTH_TOKEN=...
```

2. **If using localhost only** (`CM_BIND=127.0.0.1`):
   - No further action needed
   - CommandMate is only accessible from the local machine

3. **If exposing externally** (`CM_BIND=0.0.0.0`):
   - Set up one of the authentication methods described above
   - Built-in token authentication (`--auth`) is the simplest option for personal/LAN use
   - Nginx + Basic Auth is the recommended option when a reverse proxy is already in place

> **Note**: When using `--auth`, if an old `CM_AUTH_TOKEN` (or `NEXT_PUBLIC_CM_AUTH_TOKEN`)
> variable is detected in the environment or `.env` file, CommandMate will display a
> **warning** at startup reminding you to remove the obsolete variable.
> Existing `CM_AUTH_TOKEN` settings otherwise have no effect on the new authentication system.

---

## Security Checklist

Before exposing CommandMate to external networks:

- [ ] Authentication is configured — choose one:
  - [ ] Built-in token authentication (`commandmate start --auth --cert ... --key ...`)
  - [ ] Reverse proxy authentication (Nginx/Cloudflare/Tailscale)
- [ ] HTTPS is enabled — choose one:
  - [ ] Built-in TLS (`--cert` / `--key` flags with mkcert-generated certificate)
  - [ ] Reverse proxy SSL termination
- [ ] Firewall rules are properly configured
- [ ] WebSocket upgrade headers are configured in proxy (if using reverse proxy)
- [ ] Access logs are enabled on the reverse proxy (if using reverse proxy)
- [ ] `CM_ROOT_DIR` points only to intended repositories

---

## Additional Security Measures

### Firewall Configuration

```bash
# UFW (Ubuntu/Debian) - only allow HTTPS
sudo ufw allow 443/tcp
sudo ufw deny 3000/tcp  # Block direct access to CommandMate

# firewalld (RHEL/CentOS)
sudo firewall-cmd --permanent --add-port=443/tcp
sudo firewall-cmd --permanent --remove-port=3000/tcp
sudo firewall-cmd --reload
```

### Network Segmentation

For additional security, run CommandMate on a separate VLAN or network segment
and restrict access through firewall rules.

---

## Reporting Security Issues

If you discover a security vulnerability, please report it via
[GitHub Security Advisories](https://github.com/Kewton/CommandMate/security/advisories)
rather than a public issue.

---

## Related Documentation

- [Deployment Guide](./DEPLOYMENT.md) - Production deployment instructions
- [Trust and Safety](./TRUST_AND_SAFETY.md) - Trust and safety policies
- [Production Checklist](./internal/PRODUCTION_CHECKLIST.md) - Pre-deployment checklist

---

*Last updated: 2026-02-21 (Issue #331: mkcert certificate generation, built-in token auth + HTTPS quick start)*
