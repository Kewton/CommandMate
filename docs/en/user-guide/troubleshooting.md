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

## The History opens with a codex / vibe-local startup-screen bubble?

Earlier versions saved codex's and vibe-local's startup screen (`>_ OpenAI Codex (v…)`, the vibe-local banner) as a reply row in History (stopped in Issue #3293). Rows that were already saved are not removed automatically. To remove them, run the following from a clone of the repository (after `npm install`). It uses the `sqlite3` command (preinstalled on macOS).

**Stop the server first.** The database runs in WAL mode, so part of what was written is in `cm.db-wal`. A `cp` of `cm.db` alone leaves that out: its count can differ from the real database, and restoring it can lose History. Back up and restore with SQLite's backup feature (`.backup`), which writes one self-contained, consistent file that includes the WAL's contents.

```bash
# 1. Stop the server
commandmate stop

# 2. Back up the database (global install: ~/.commandmate/data/cm.db,
#    or the value of CM_DB_PATH if you set one)
DB=~/.commandmate/data/cm.db
sqlite3 "$DB" ".backup '$DB.bak-3335'"

# 3. Try it on a copy: make a trial copy from the backup, and run the dry run and --apply on it
sqlite3 "$DB.bak-3335" ".backup '/tmp/cm-3335-try.db'"
node scripts/cleanup-startup-banner-rows.mjs --db /tmp/cm-3335-try.db
node scripts/cleanup-startup-banner-rows.mjs --db /tmp/cm-3335-try.db --apply

# 4. Dry run on the real database (the default). Opens it read-only and prints the
#    candidate count and ids only. Check they are the same as in step 3
node scripts/cleanup-startup-banner-rows.mjs --db "$DB"

# 5. --apply on the real database: deletes the candidates only
node scripts/cleanup-startup-banner-rows.mjs --db "$DB" --apply

# 6. Start the server
commandmate start --daemon
```

- A candidate is a codex / vibe-local `assistant` row that meets all of these: no `request_id` (the transcript writer sets one on every row it writes) / no echoed user message in it / nothing but startup-screen rows, no reply body / the shape of the path that saved it (colour escapes still in it, or a timestamp exactly 1 ms before the next message)
- Rows with the startup-screen text that do not meet those conditions are printed as "left", with the id and the reason (`keyed-row`, `holds-echo`, `has-body`, `no-path-match`), and never deleted. Look at them yourself if needed
- To undo, stop the server and restore the backup into the database: `sqlite3 "$DB" ".restore '$DB.bak-3335'"`

## Roll the database back to before a migration after an update?

When the database still has one or more migrations (schema updates) to apply at startup, CommandMate takes a copy of it **before the first migration** (Issue #3985). An older CommandMate cannot open a database at a newer schema version, so to roll back an update, restore this copy together with the older executable.

- **When it is taken:** only when there is a pending migration. Never for a database that is already at the latest version, or for a brand-new database (no tables yet)
- **Where:** `db-backups/` in the same directory as the database (global install: `~/.commandmate/data/db-backups/`; next to `CM_DB_PATH` if you set one). The directory is 0700, the files are 0600
- **Name:** `<database file name>.v<from>-to-v<target>.<UTC time>.<short id>.sqlite` (e.g. `cm.db.v61-to-v62.20261029T010203456Z.1a2b3c4d.sqlite`). A file still being written ends in `.partial` and never counts as a completed copy
- **Generations:** up to 3 completed copies are kept. Older ones are deleted only after the new copy has been verified. The original restore point (the newest copy whose source version is the "last completed version", whatever its target) is never deleted and takes one of the 3 slots. The last completed version is recorded in `db-backups/<database file name>.last-complete-version` (0600) whenever every migration succeeds. When nothing is recorded (the first copy, or a `db-backups/` made by an older version), the version before the migration starts is taken as the last completed one and recorded. So if a migration fails partway (e.g. v59 → v60 succeeds, v61 fails) and every restart — or another version aiming at, say, v62 — takes a new copy from v60, the v59 copy, the one the last working CommandMate can open, is not pushed out. Once a migration run completes, the record moves forward and older copies are pruned as usual from the next update on. Failing to write the record never stops startup (it is logged, and the next run falls back to the assumption above)
- **Contents:** a single-point-in-time copy made with SQLite's `VACUUM INTO`, including committed updates still in the WAL. After writing it, CommandMate checks `integrity_check` and the schema version
- **On failure:** if the copy cannot be made or verified, startup stops before any migration runs. To start without the copy (e.g. not enough disk space), set `CM_DB_SKIP_MIGRATION_BACKUP=1` (the default is to take it)

**Restoring loses every update made after the copy was taken (conversation history, settings changes, and so on).** To restore:

```bash
# 1. Stop the server
commandmate stop

# 2. Pick the copy to restore (global install: ~/.commandmate/data/cm.db,
#    or the value of CM_DB_PATH if you set one)
DB=~/.commandmate/data/cm.db
ls -l "$(dirname "$DB")/db-backups/"

# 3. Save the current database with SQLite's backup feature (includes committed updates still in the WAL)
sqlite3 "$DB" ".backup '$DB.before-restore'"

# 4. Put the copy in its place and delete -wal and -shm
cp "$(dirname "$DB")/db-backups/cm.db.v61-to-v62.<time>.<id>.sqlite" "$DB"
chmod 600 "$DB"
rm -f "$DB-wal" "$DB-shm"

# 5. Go back to the CommandMate version that matches the copy, then start it
commandmate start --daemon
```

- Restoring with `-wal` / `-shm` left in place lays another database's WAL over the copy, which can corrupt it or mix in updates. Always delete them
- Saving the current database with `mv` or `cp` takes the main file only, and leaves out committed updates still in `-wal` (e.g. after a crash). Save it with `.backup` as in step 3
- The copy is a self-contained, consistent file, so `cp` is enough to restore it (with the server stopped)

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
