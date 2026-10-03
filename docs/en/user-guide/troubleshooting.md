[日本語版](../../user-guide/troubleshooting.md)

# Troubleshooting & FAQ

Moved here from the README (Issue #3061). For installation errors (`command not found`, `EACCES`,
port and dependency checks) see the [CLI Setup Guide](./cli-setup-guide.md#troubleshooting); for
the exit codes and failures of the agent-facing commands see the
[CLI Operations Guide](./cli-operations-guide.md#troubleshooting).

---

## Claude CLI not found / path changed?

If you switch between npm and standalone versions of Claude CLI, the path may change. CommandMate auto-detects the new path on the next session start. To set a custom path, add `CLAUDE_PATH=/path/to/claude` to `.env`.

## Port conflict?

```bash
commandmate start -p 3001
```

## Session stuck or not responding?

Look at the session with CommandMate's own commands — they resolve the tmux session name for you:

```bash
# What every worktree's agent is doing, and the tmux session it runs in
commandmate ls
commandmate ls --json | jq -r '.[] | "\(.id)\t\(.tmuxSession)"'

# Read the transcript WITHOUT attaching
commandmate capture <worktree-id> --pane --tail 60
commandmate capture <worktree-id> --pane --follow    # follow a reply as it is generated

# Attach this terminal (detach with Ctrl+b then d)
commandmate attach <worktree-id>
commandmate attach <worktree-id> --live              # re-lay out to your terminal (claude only)
```

**Why a bare `tmux attach` looks empty.** A CommandMate session is pinned to a 200x1000 canvas so
`capture-pane` keeps enough history for status detection. Alternate-screen agents (claude / opencode /
copilot) draw their transcript at the top of that canvas and their composer at the bottom, and tmux
follows the cursor — so a normal-sized terminal sees the composer, blank rows, and not one line of the
conversation. Nothing is broken. Read it with `capture --pane` above, with `prefix + g` while
attached, or hand the window to your terminal with `attach --live`.

From tmux itself, without attaching at all:

```bash
tmux ls -F '#{session_name} #{@cm_status} #{@cm_tool}/#{@cm_instance}'

# Kill a broken session (`=name:` is an exact match; quote it — zsh eats a bare `=`)
tmux kill-session -t '=mcbd-claude-feature-123:'
```

> **Note:** When attached, avoid typing directly into the session — this can interfere with CommandMate's session management. Use `Ctrl+b` then `d` to detach and operate through the CommandMate UI instead.

## Sessions fail when launching from within Claude Code?

Claude Code sets `CLAUDECODE=1` to prevent nesting. CommandMate removes this automatically, but if it persists, run: `tmux set-environment -g -u CLAUDECODE`

## FAQ

**Q: How do I use CommandMate from my phone?**
A: Run `commandmate remote`. One command starts the server with authentication enabled, opens a tunnel, and prints a QR code in your terminal — scan it with your phone's camera and you are signed in. The pairing code inside that QR works **once** and expires after 10 minutes by default.

```bash
commandmate remote          # start + publish + pair (QR)
commandmate remote status   # provider, URL, expiry, pairing state
commandmate remote stop     # close the outside door (the server keeps running)
```

It needs [`tailscale`](https://tailscale.com/) or [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed. Because a Cloudflare Quick Tunnel puts a `https://<random>.trycloudflare.com` address on the public internet, `commandmate remote` warns you and asks before creating it; in a non-interactive shell it refuses instead of assuming yes, so pass `--yes` when you mean it. If no provider is usable it stops with a dependency error rather than falling back to something more exposed. Your `CM_BIND` setting is left alone — the server stays bound to `127.0.0.1`, and `remote` only adds a door in front of it. Details: [Web App Guide → Mobile Access](./webapp-guide.md#mobile-access).

**If you would rather not install a provider tool**, you can stay inside your LAN: run `commandmate init` and enable external access — this sets `CM_BIND=0.0.0.0` — then open `http://<your-PC-IP>:3000` from a phone on the same Wi-Fi. **Be aware of what that does: it serves CommandMate with no authentication and no encryption.** Anyone on that network can open the URL and drive your repositories, terminals and agents without being asked for anything. Use it only on a network you trust, never on shared or guest Wi-Fi, and set `CM_BIND` back to `127.0.0.1` when you are done.

**Q: Can I access it from outside my home network?**
A: Yes — `commandmate remote` (above) is the built-in way: with Tailscale the server is reachable from your own devices on your tailnet, with a Cloudflare Quick Tunnel from anywhere on the internet, and CommandMate answers either with token authentication on. A Cloudflare URL is public, so treat the pairing code, not the URL, as the thing that keeps other people out.

If you would rather run the tunnel yourself, any of these work:

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) — free, requires Cloudflare account
- [ngrok](https://ngrok.com/) — free tier available, easy setup
- [Pinggy](https://pinggy.io/) — no sign-up required, simple SSH-based tunnel

Alternatively, a VPN or an authenticated reverse proxy (Basic Auth, OIDC, etc.) also works. **Do not** expose the server directly to the internet without authentication. See the [Security Guide](../security-guide.md) for details.

**Q: Does it work on iPhone / Android?**
A: Yes. CommandMate's Web UI is responsive and works on any modern mobile browser (Safari, Chrome, etc.). No app install required. The minimum browser versions are in the [Web App Guide](./webapp-guide.md#3-supported-browsers).

**Q: Is tmux required?**
A: CommandMate uses tmux internally to manage CLI sessions. You don't need to operate tmux directly — CommandMate handles it for you.

**Q: What about Claude Code's permissions?**
A: Claude Code's own permission settings apply as-is. CommandMate does not expand permissions. See [Trust & Safety](../TRUST_AND_SAFETY.md) for details.

**Q: Can multiple people use it?**
A: Currently designed for individual use. Simultaneous multi-user access is not supported.
