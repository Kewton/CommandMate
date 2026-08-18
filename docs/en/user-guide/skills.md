[日本語版](../../user-guide/skills.md)

# Agent Skills Distribution (Phase 1 / MVP)

CommandMate fetches Agent Skills from the official Catalog and installs or removes them,
byte-identically, into the chosen worktree's **install root set** (both `.agents/skills/<skill-id>/`
and `.claude/skills/<skill-id>/`). Agents read different directories, so installing into only one of
them leaves the Skill invisible to some agents (#1460). This document covers the support matrix,
the known constraints, and the rollback procedure **as of Phase 1 (MVP)**.

The definition of the install root set has a single source of truth,
`SKILL_INSTALL_ROOT_PREFIXES` (`src/lib/skills/constants.ts`), and it is also recorded in the
receipt's `install_roots` and in the database's `skill_installations.install_roots`.

For the design decisions themselves see
[docs/design/agent-skills-distribution.md](../../design/agent-skills-distribution.md); for
per-module responsibilities see [docs/module-reference.md](../module-reference.md).

---

## 1. What Actually Happens

| Stage | Performed by | What it does |
|-------|--------------|--------------|
| Catalog fetch | server | Validates and caches the Catalog from a fixed endpoint |
| download | server | Accepts only an artifact whose SHA-256 and size match the Catalog declaration exactly |
| inspection | server | Parses every archive entry without extracting it, and cross-checks it against the manifest in both directions |
| plan | server | Issues an expiring plan that pins the live branch / HEAD and the files to be written |
| install | server | Writes to staging, then commits into each install root with an atomic rename (primary = `.agents/skills/<id>/`) |
| agent discovery | agent CLI | Each agent reads its own discovery root at startup (**a session restart is required**, §2-2) |

**Neither download, install, nor uninstall executes any script or hook inside the package.**
`declared_permissions` is the *claim* of the provider, not something CommandMate enforces.

---

## 2. Support Matrix (as of Phase 1)

### 2-1. Operation Routes

| Operation | Web UI | CLI (`commandmate skill`) | Notes |
|-----------|--------|---------------------------|-------|
| Browse / search the Catalog | Yes, `/skills` | Yes, `list` | |
| Show details, risk, compatibility | Yes, `/skills/[id]` | Yes, `info` | |
| Preview the install plan | Yes, `/skills/[id]` (§3-1) | Yes, `plan` / `install --dry-run` | |
| install | Yes, `/skills/[id]` and the Skills pane of the worktree detail | Yes, `install` | **The CLI requires `--version`** (§3-6) |
| uninstall | Yes, same as above | Yes, `uninstall` | |
| List what is installed | Yes, the Skills pane of the worktree detail (#1440) | Partial: `status` queries one Skill at a time (§3-2) | |
| update | Yes, the update dialog's apply button in the Skills pane | Yes, `update-plan` (preview) / `update` (apply) | Refused with zero writes if there are local changes (§3-3) |
| rollback | No | No | The old version is kept as a verified backup. The restore operation is #1245 |

### 2-2. Agent Support

An install places the same payload in both `.agents/skills/<id>/` and `.claude/skills/<id>/`.
Which one an agent reads is up to that agent's implementation; the table below is
**what was measured on real CLIs on 2026-07-26** (#1513 G4). What CommandMate guarantees stops at
"the payload was placed in both roots" — the discovery implementation of an agent CLI is outside
that guarantee.

| Agent | Measured version | Discovery root | Exposed as a slash command | Measured on |
|-------|------------------|----------------|----------------------------|-------------|
| Claude Code | 2.1.220 | Reads `.claude/skills`. Does not read `.agents/skills` | Yes, it appears in the palette | 2026-07-26 |
| Codex CLI | 0.145.0 | Reads `.agents/skills` | No (a CLI-side constraint) | 2026-07-26 |
| Gemini / OpenCode / vibe-local | — | **Not measured (unknown)** | Not measured | — |

Unmeasured agents are left as `unknown`. CommandMate never displays an unmeasured agent as
`unsupported` or as `commandmate_runtime` — the first would assert a measurement that was never
taken, the second would assert a feature that does not exist in Phase 1. This invariant is pinned by
`tests/unit/lib/skills/compatibility.test.ts` and `tests/e2e/skills-catalog.spec.ts`.

A manifest's `native` declaration is **the provider's claim**, not a per-version verification by
CommandMate. Directly beneath the agent support badge, the UI (`SkillDetailView`) shows the claim and
the raw `evidence` alongside **the measured results in the table above** (discovery and invocation as
two separate axes, the measured version, the measurement date, the evidence, and the reload
procedure) (#1246). Where the claim exceeds the measurement it is displayed clamped to the
measurement; where it falls short it is displayed as claimed, marked as a claim that has not caught
up. The matrix itself lives in `src/lib/skills/compatibility-matrix.ts`; for details see
[skill-agent-compatibility.md](../../reference/skill-agent-compatibility.md).

What CI guarantees stops at **the `SKILL.md` in both roots being visible from the discovery paths**
(`loadAgentsSkills()` / `loadSkills()`) and **the discovery root in the table above actually being
wired to that path** (`tests/unit/lib/skills/agent-discovery-regression.test.ts`). It does not
guarantee that a real agent CLI presents or runs the Skill. Re-measuring the real CLIs is an opt-in
probe that runs only with `CM_SKILL_DISCOVERY_PROBE=1`, and it detects version drift only.

### 2-3. What the Change Scope Guarantees

| Scope | Guarantee |
|-------|-----------|
| Inside the target worktree | Only under the install root set (`.agents/skills/<skill-id>/` and `.claude/skills/<skill-id>/`). Nothing is created except payload files and `.commandmate-receipt.json` |
| Inside the target worktree (tracked files) | Never modified (`git diff HEAD` stays empty) |
| Outside the worktree | Only the service-owned state root (`<config>/skills/{locks,journal,package-staging}`, `<config>/data/skill-snapshots`) |
| Permissions | The state root and the snapshot root are `0700`; snapshot files are `0400` |

---

## 3. Known MVP Constraints

### 3-1. (Resolved in #1431) The install / uninstall route in the UI

> **Resolved in #1431**: `SkillTargetSelector` is mounted in production through
> `SkillDetailView` → `SkillInstallPanel`, so a browser can select a target, plan, preview, confirm,
> and install / uninstall. A high-risk Skill sends no request while its confirmation checkbox is
> unchecked.

Component tests (with a mocked fetch, using the same request/response types as the real routes) pin
the happy path, blockers, high-risk confirmation, and the typed-error display branches; on top of
that, `tests/e2e/skills-install.spec.ts` pins the full target → preview → approval run and the
approval gate in a real browser (desktop and 390px mobile). **A browser UAT against the real Catalog
with a real download has not been performed** (the e2e suite stubs the Catalog and the writing routes
on the browser side). No first-time-user UX study has been done either; it is item 3-1 of the manual
verification in #1242.

### 3-2. (Partly resolved in #1440) The CLI has no per-worktree list of what is installed

> **Resolved in #1440 (Web UI / API)**: `GET /api/worktrees/[id]/skills` is public, and the Skills
> pane of the worktree detail (`WorktreeSkillsPane`) lists the installed Skills.

**The CLI side is still missing.** `commandmate skill status <id>` is a **single-Skill query**, not a
per-worktree list, and it generates one uninstall plan internally, so it has the **side effect of
consuming one plan token**. An install audit history and an applied-state dashboard are #1248.

### 3-3. (Resolved in #1243 / #1244) No way to reinstall or update

When the destination already exists, the apply step of an install is refused with
`SKILL_INSTALL_DESTINATION_EXISTS` (409). **The same version cannot be reinstalled in place.** It has
to be uninstalled and installed again.

> **Resolved in #1243 / #1244 (update)**: updating is offered in two stages, preview (update plan)
> and apply (update apply). Run it from the update dialog in the Skills pane of the worktree detail,
> or with `commandmate skill update-plan` / `commandmate skill update`.
> The candidate resolves only to an **exact version strictly newer than the installed one**, and the
> candidate artifact goes through the same source / checksum / archive verification as an install
> (#1229 / #1230).
>
> The apply step has these properties:
>
> - **One local change is enough to refuse it with zero writes** (`SKILL_UPDATE_LOCAL_CHANGES`).
>   modified / unknown / missing / irregular all count, and neither the old nor the new version is
>   rewritten. To keep your edit, move that path aside and build the update plan again.
> - **If the world moved since the preview, it is refused** (`SKILL_PLAN_STALE`). A plan is bound to
>   the receipt digest, the tree hash, the branch, and HEAD, and it is re-checked immediately before
>   applying.
> - **The switch is a single commit point** (the rename of the primary root). A failure before it
>   leaves the worktree unchanged to the byte; a failure after it is reported as
>   "committed, reconciling" and converges forward onto the new version.
>   **The old and new versions never coexist.**
> - **Both `.agents/skills` and `.claude/skills` are switched by one operation** (#1460). If only the
>   secondary root fails to switch, startup reconciliation converges it forward.
> - An update whose effective risk goes up demands **a separate, additional confirmation** beyond the
>   normal update confirmation (an independent checkbox in the UI, `--ack-risk-increase` in the CLI).
>   A high-risk candidate's `--ack-risk <id>@<version>` is required on top of that, and `--yes` alone
>   substitutes for neither.
> - Before the switch, **the old payload is saved as a verified backup on the service side**
>   (`~/.commandmate/skills/backups/`). It is not placed inside the repository.
>   **The restore (rollback) operation is not yet available (#1245)**; what is saved today is the
>   material to restore from, and no more.

Note that at the install-plan stage a "managed and unmodified" tree looks like a zero diff and
therefore reports `installable: true`. The refusal happens at the destination re-check immediately
before the commit.

### 3-4. A plan token cannot be tied to an individual user

CommandMate's authentication is a single shared token with no per-user identity. A plan token's
binding goes as far as **the channel (cookie=`user` / bearer=`cli`) and `id: null`**, so "who
previewed this" cannot be recorded. Presenting a UI-issued token from the CLI is refused with
`SKILL_PLAN_BINDING_MISMATCH` (409).

### 3-5. uninstall does not reclaim the emptied parent directories of an install root

An uninstall reclaims, with `rmdir(2)`, only the directories the receipt derived. So
`.agents/skills/<id>/` and `.claude/skills/<id>/` disappear, but
**`.agents/skills/`, `.agents/`, `.claude/skills/`, and `.claude/` are left behind, empty**.
`.claude/` is also where a user's settings and other Skills live, so this is deliberate: it avoids
sweeping up directories created by the user or by other tools.

### 3-6. The CLI's `install` requires `--version`

`commandmate skill install <id> --worktree <id>` alone is refused with exit 2; an explicit
`--version <exact>` is required (the API and the UI default to the Catalog's recommended version).
The design makes a CLI user conscious of the version being installed.

### 3-7. (Resolved in #1429) TTL reclamation of verified snapshots

> **Resolved in #1429**: `plan-sweeper` now sweeps both plan caches and the snapshot store every
> 60 seconds (and whenever a plan token is accessed). A snapshot pinned by an abandoned plan token
> also returns to refcount 0 after its TTL and is evicted automatically.

The verified snapshot of a downloaded artifact stays in `<config>/data/skill-snapshots` as a
**cache with a 30-minute TTL** (`0700` / `0400`) so a retry does not download it again. There used to
be no reclamation path other than "the next time a plan is built", so an abandoned token pinned a
snapshot until the process exited; it is now reclaimed automatically by a low-frequency timer (which
is `unref()`ed).

### 3-8. (Resolved in #1428) Startup reconciliation

> **Resolved in #1428**: `server.ts` runs `runSkillStartupReconciliation()` after the migrations
> finish. An operation that ended in `committed_reconciling` converges from its receipt to SUCCEEDED
> at startup, and an orphan lock whose owner has been confirmed is released. The manual check (§4-3)
> is normally unnecessary now.

Reconciliation is fail-open (it never blocks startup), and the operation journal is pruned
automatically by retention (7 days). The manual procedure in §4-3 remains as a reference for checking
immediately, without waiting for a restart.

### 3-9. The release approver for the official Skill repository is the maintainer

`Kewton/commandmate-skills` is a personal repository, so GitHub Actions cannot be named as a bypass
actor in a ruleset. Protection on the main branch stops at forbidding force pushes and deletion, and
the approver for the release environment is the maintainer themselves.

---

## 4. Rollback Procedure

### 4-1. The normal undo (when the install succeeded)

```bash
commandmate skill uninstall <skill-id> --worktree <worktree-id> --yes
```

An uninstall checks every file digest in the receipt and **deletes nothing and stops if even one is
modified / unknown / missing / unmanaged / irregular** (zero-delete, fail closed). That is why a
hand-edited Skill is never silently deleted.

If you did edit something locally, either revert the edit and uninstall, or delete it by hand as in
§4-2.

### 4-2. Undoing by hand

To revert without going through CommandMate, delete **both members of the install root set** in the
target worktree. **The CommandMate-internal state outside the worktree does not need deleting** (the
journal is an append-only record; locks and snapshots are reclaimed on their own).

```bash
rm -rf <worktree>/.agents/skills/<skill-id> <worktree>/.claude/skills/<skill-id>
```

Deleting only one of them leaves agents discovering the Skill from the surviving root, while a
reinstall is refused with `SKILL_INSTALL_DESTINATION_EXISTS` (409) because that root's destination
still exists. The exact list of roots can be read from `install_roots` in
`<worktree>/.agents/skills/<skill-id>/.commandmate-receipt.json`.

In this case a row is left behind in the database's `skill_installations`. Installing the same Skill
again succeeds, because the destination is gone, and the row is updated by upsert.

### 4-3. When an operation ended in `committed_reconciling`

The rename into the primary root (`.agents/skills/<id>/`) completed, but placing the payload in the
secondary root, or writing the index / audit record, failed. **The contents of the primary root are
correctly in place.**

1. Confirm that `.agents/skills/<skill-id>/.commandmate-receipt.json` exists.
2. If it does, the install is committed. What is missing is either the `skill_installations` row or
   the secondary root (`.claude/skills/<skill-id>/`).
3. While the secondary root is missing, the Skill is invisible to agents that read it (Claude Code,
   as measured on 2026-07-26). Startup reconciliation (§3-8) completes the secondary root placement.
4. To undo it, delete by hand as in §4-2 (both roots).
5. To keep it, leave it as is (a missing index row affects only the listing feature in §3-2).

CommandMate never disguises a post-commit failure as a rollback. "Nothing changed" is reported only
for a failure that happened before the rename.

### 4-4. Leftovers

None of the following remain, in success or in failure. If one is there, that is abnormal, and it is
safe to delete.

| path | Meaning |
|------|---------|
| `<worktree>/.agents/skills/.commandmate-staging/` | Mid-install staging (primary root) |
| `<worktree>/.claude/skills/.commandmate-staging/` | Mid-install staging (secondary root) |
| `<config>/skills/locks/*.lock` | The exclusion lock of an operation in flight |
| `<config>/skills/package-staging/` | Staging used for package inspection |

`<config>` is `~/.commandmate` for a global install.

### 4-5. When an installed Skill is invisible after deleting and recreating a worktree

**This stopped happening automatically once #1430 (migration v46) was applied.** In v46,
`skill_installations` follows the worktree via `ON DELETE CASCADE`, so deleting a worktree deletes its
install rows too, and after recreating it at the same path the install starts correctly from
"not installed".

Rows left dangling before v46 (the worktree deletion produced a new UUID, the receipt was still on
disk, the database said "not installed", and a reinstall was refused with
`SKILL_INSTALL_DESTINATION_EXISTS`) are cleared automatically at startup, because the v46 migration
sweeps out the existing dangling rows. To fix one by hand, delete both install roots as in §4-2 and
install again.

---

## 5. Scope of Automated Verification

As the Phase 1 MVP gate, the following run on every CI pass (all of them **network independent**).

| suite | Contents |
|-------|----------|
| `tests/integration/skills-mvp-install-flow.test.ts` | Catalog → install → receipt → discovery → uninstall for 3 Skills; the change-scope allowlist; zero leftovers; UI and CLI agreeing through the same routes |
| `tests/integration/skills-mvp-security-regression.test.ts` | A corpus of 59 malicious archives; unmanaged / local change / drift / plan expiry / single use / concurrent install / unacknowledged high risk |
| `tests/integration/skills-mvp-source-integrity.test.ts` | The allowlist; re-verification on every redirect; content type; the size cap; checksums; an offline or stale Catalog |
| `tests/e2e/skills-catalog.spec.ts` | Catalog listing, search, and detail in a real browser; the stale display; unmeasured agents not being shown; readability on mobile (390px) |
| `tests/e2e/skills-install.spec.ts` | target → preview → approval in a real browser; both install roots being shown; the high-risk acknowledgement gate; blocker display; uninstall; a full run on mobile |

The integration suites drive the route handlers directly, while the e2e suites stub the Catalog and
the writing routes on the browser side and verify **the rendered product**. The former answers "is
the server fail closed?", the latter "what does a user see before approving", and they are split so
their scopes do not overlap.

Verification against the real Catalog and real releases is opt-in: it runs only with
`CM_SKILLS_E2E_REAL_CATALOG=1` set, and is skipped with a reason otherwise.

What is not automated is the first-time-user UX study (it needs participants) and invocation
measurement driving a real agent CLI's interactive TUI (#1246 automated an opt-in version-drift probe;
re-measuring palette exposure remains manual work in an isolated environment). For the current status
see [docs/qa/skills-mvp-uat-report.md](../../qa/skills-mvp-uat-report.md).
