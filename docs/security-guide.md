[English](./en/security-guide.md)

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

### Provider Tunnel (`commandmate remote`)

`commandmate remote` is a third shape, and neither of the two modes above describes it.

The server keeps its `127.0.0.1` bind — `remote` neither reads nor writes `CM_BIND`, so a
host on the default binding stays on the default binding. What `remote` adds is an
*outward door*: a provider process that accepts connections from outside and forwards them
to the loopback listener.

| Property | Value under `commandmate remote` |
|----------|----------------------------------|
| Listening socket | Still `127.0.0.1` only — nothing new listens on your LAN interface |
| Reachability | The provider URL is reachable by anyone who learns it |
| Authentication | Always on. `remote` starts the server with token authentication enabled |
| Blast radius | The CommandMate server only, not other services on this machine |

So the exposure is "one authenticated HTTP surface, reachable by anyone who learns the
URL". It is neither the localhost case ("no authentication required") nor the
`CM_BIND=0.0.0.0` case ("every client on the network reaches this port"). The risks in the
table above still apply to anyone who *does* get past authentication.

See *Option 4: `commandmate remote`* under Recommended Authentication Methods below.

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

### Option 4: `commandmate remote` (CommandMate performs the setup)

Options 1-3 above are configurations **you build and own**: you install Nginx, you create
the Cloudflare Tunnel, you join the Tailscale network. CommandMate is unaware of any of
them and never touches them.

`commandmate remote` is the opposite arrangement. **CommandMate performs the setup on your
behalf** — it starts a server with authentication enabled, mints a session token, asks a
provider to publish that server, and prints a QR code to pair a phone with. It records
what it created so that it can later undo exactly that, and nothing else.

```bash
commandmate remote          # up (default): start the server, publish it, print a pairing QR code
commandmate remote status   # provider, URL, expiry, pairing state
commandmate remote stop     # close the outside door; the server keeps running
```

| Flag | Meaning |
|------|---------|
| `--provider <tailscale\|cloudflare>` | Override provider auto-selection |
| `--expires <duration>` | Remote session TTL (default `8h`, range `1h`-`30d`) |
| `--pairing-expires <duration>` | Pairing code TTL (default `10m`, range `1m`-`24h`) |
| `-p, --port <number>` | Port of the server to expose |
| `--yes` | Approve creating a public tunnel without prompting (required when non-interactive) |
| `--json` | JSON output |

There is deliberately **no `--token` flag**: `remote` is the side that mints the token, so
one supplied from outside would have no matching hash on the server. There is **no
`--auto-yes` flag in any form** either. Auto-Yes state is an in-memory map that is empty at
server start, so a server `remote` has just started has Auto-Yes off for every worktree —
not offering a flag to turn it on is the structural guarantee that it stays off.

Exit codes: `0` success, `1` `DEPENDENCY_ERROR` (no usable provider), `2` `CONFIG_ERROR`
(non-interactive without approval, an invalid `--expires`, or a server already running with
authentication enabled that this session cannot pair with), `3` `START_FAILED`,
`4` `STOP_FAILED`, `99` `UNEXPECTED_ERROR`.

#### Provider availability

| Provider | State |
|----------|-------|
| `cloudflare-quick` (Cloudflare Quick Tunnel) | **Implemented.** Selectable whenever `cloudflared` is installed |
| `tailscale-serve` | **Not implemented.** A stub that always reports itself unavailable, so `remote` can never select it |

> **The `tailscale-serve` provider is not Option 3.** Option 3 above is *you* using
> Tailscale yourself: it works today, it is a good choice, and it needs nothing from
> CommandMate. The `tailscale-serve` **provider** — CommandMate driving `tailscale serve`
> for you as part of `remote` — does not exist yet. Do not read Option 3's recommendation
> as saying that `commandmate remote --provider tailscale` will work.

If no provider is ready, `remote` stops with `DEPENDENCY_ERROR` (exit code `1`). It does
**not** fall through to a public tunnel on its own when Tailscale is unavailable: putting
this machine on the public internet always requires your explicit approval.

#### Cloudflare Quick Tunnel: what you are approving

A Quick Tunnel is convenient *and* disposable. Both halves matter:

- **A random, publicly reachable URL is created on the internet.** `cloudflared` allocates
  a `https://<random>.trycloudflare.com` address. Anyone who learns that address can reach
  your CommandMate server, and the traffic passes through Cloudflare.
- **The URL changes on every start.** It is not stable, so it cannot be bookmarked, put
  behind a DNS record, or added to any allow-list.
- **Do not use it for long-lived or production access.** A Quick Tunnel carries no access
  policy of its own, no audit trail you control, and no availability guarantee. For
  anything beyond an ad-hoc "reach my machine from my phone right now", use Option 2
  (Cloudflare Access) or Option 3 (Tailscale) instead.
- **CommandMate's own authentication is not optional here.** `remote` always starts the
  server with token authentication enabled; a visitor who does not redeem the pairing code
  is refused. The tunnel publishes an authenticated surface, never an open one.
- **CommandMate never creates a public tunnel without explicit approval.** Interactively
  you are shown a warning and must confirm. Non-interactively — CI, a script, a message
  sent by an agent — there is nobody to ask, so the run fails with `CONFIG_ERROR`
  (exit code `2`) unless you passed `--yes`. `--yes` *is* the approval; do not add it to a
  wrapper script by reflex.

#### Pairing code

- **Single-use**, and expires after 10 minutes by default (`--pairing-expires`)
- 26 Crockford Base32 characters, i.e. 128 bits of entropy
- **The plaintext is never persisted.** It is handed to the server through
  `~/.commandmate/remote-pairing.json`, mode `0600`, and that file is deleted the instant
  the code is redeemed. "Already used" is represented by the file's *absence*, not by a
  flag written inside it
- `remote` contributes exactly three environment variables to the server it starts:
  `CM_AUTH_TOKEN_HASH`, `CM_AUTH_EXPIRE`, and `CM_REMOTE_PAIRING_FILE`. The third is a
  **path, not a secret**. No plaintext long-lived token is placed in the environment,
  because a tmux pane CommandMate spawns inherits the server's environment wholesale —
  anything left there would be readable by the very agents CommandMate is driving

#### The session cookie carries no `Secure` attribute over a tunnel (expected)

CommandMate issues its authentication cookie with `HttpOnly` and `SameSite=Strict` always,
and with `Secure` **only when the server itself is serving HTTPS** — that is, when
`CM_HTTPS_CERT` is set. A provider tunnel terminates TLS at the provider and forwards plain
HTTP to the loopback origin, so `CM_HTTPS_CERT` is unset and the cookie is issued
**without** `Secure`.

**This is correct behaviour, not a defect**, for three reasons:

1. **`Secure` describes the origin, and the origin really is plain HTTP.** Setting it
   unconditionally would make browsers refuse the cookie over `http://localhost:3000`,
   breaking ordinary local use — the primary way CommandMate is run — in order to annotate
   a connection that is already encrypted.
2. **The exposed leg is already HTTPS.** Between the browser and the provider the traffic
   is encrypted, so the on-the-wire eavesdropping that `Secure` exists to prevent is
   already addressed. What is left in the clear is the loopback hop inside your own
   machine.
3. **The other cookie protections do not depend on transport.** `HttpOnly` (no JavaScript
   access) and `SameSite=Strict` (no cross-site submission) are set in every configuration.

If you want `Secure` set, terminate TLS at the CommandMate server itself
(`commandmate start --auth --cert ... --key ...`, see the Quick Start above) rather than
relying on a tunnel for it.

#### Expiry and cleanup

- When `--expires` elapses, **only the outside door closes — the server keeps running.**
  Shutting it down would take your local session with it, so an expiring remote session
  never costs you your work on the machine itself.
- `commandmate remote stop` closes the provider session and reverts **only what CommandMate
  recorded creating.**
- If the recorded state is missing or unreadable, `stop` does **not** guess which provider
  to tear down. It reports that it has nothing it knows how to clean up and exits
  successfully. Guessing would mean deleting provider configuration that belongs to you —
  a Tailscale Serve mapping you set up by hand, say — which CommandMate has no way to
  restore.

#### Deprecated: long-lived tokens in the URL fragment

The earlier QR sign-in flow put a long-lived token into the URL fragment
(`.../login#token=...`). The generator for those links has been **removed** from
CommandMate — nothing in the product produces such a URL any more. The receiving side still
accepts `#token=` for one more release and logs a deprecation warning when it does; it will
be removed after that. Use the pairing URL that `commandmate remote` prints instead, and
treat any surviving `#token=` link as a live credential — it is a long-lived token
sitting in a URL — rather than as a convenient bookmark.

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
- [ ] `CM_BROWSE_ROOTS` lists only directories whose folder names may be exposed to authenticated clients (unset is safest)

When using `commandmate remote`:

- [ ] You understand that a Cloudflare Quick Tunnel URL is reachable from the public internet
- [ ] The tunnel is for ad-hoc access, not long-lived or production access
- [ ] `--yes` is used only where you have consciously pre-approved creating a public tunnel, never as a default in a wrapper script
- [ ] `--expires` is set to the shortest TTL the task needs (default `8h`, range `1h`-`30d`)
- [ ] `--pairing-expires` is short and the QR code is scanned promptly (default `10m`)
- [ ] The pairing QR code / URL is not forwarded, screenshotted into a chat, or reused — it is single-use
- [ ] `commandmate remote stop` is run when remote access is no longer needed (expiry closes the door, but only after the TTL elapses)
- [ ] You accept that over a tunnel the session cookie has no `Secure` attribute (see Option 4) — use built-in TLS if you need it

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

*Last updated: 2026-08-29 (Issue #1937: `commandmate remote`, Quick Tunnel risks, cookie `Secure` over a tunnel)*
