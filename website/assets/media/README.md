# Landing page media — what may live here, and where it comes from

This directory is the **only** place the landing page may keep a moving image. Everything in it is
named explicitly in `ALLOWED_MEDIA` in `tests/unit/website/landing-page.test.ts`; adding a file
means editing that list, which is deliberately the moment a human confirms the footage is safe to
publish. The still images the page serves live in `website/assets/img/`.

## What went wrong the first time (Issue #1272)

The LP used to open on `demo-desktop.mp4` with `demo-desktop-poster.webp` as its poster, and
carried a second `demo-mobile.mp4` below the gallery. Both were re-encoded from the recordings in
`docs/images/`, which were captured on a **personal working machine**. They showed things that have
no business on a public page:

- Six private repository names (`MyCodeBranchDesk`, `CommandMate-Marketing`, `MyMLXServer`,
  `self-hosted-runner`, `locallm-test`, `vibe-local`).
- The **old product name** `MyCodeBranchDesk` in the hero breadcrumb — the very thing Issue #1221
  set out to remove, sitting in the most prominent slot on the page.
- Readable **private source code** in the mobile demo's diff view.
- Personal browser chrome and the macOS menu bar.

The desktop poster was also the `og:image`, so it was not merely "seen by people who visit the LP":
it expanded as the preview card **every time the LP was linked** in Slack, X, or anywhere else.

The guard written at the time banned `<video>` and the video file extensions. That did not defend
the property it was written for — what was wrong with the material was where it came from, not what
container it sat in, and a GIF of the identical footage passed every check
(`docs/images/demo-mobile.gif` still exists). Issue #1577 recast the rules around this directory and
the allowlist instead.

## The current demos (Issue #1577)

| File | Source | Shows |
|------|--------|-------|
| `parallel-worktrees.mp4` | `docs/images/features/cm-01-parallel-worktrees.en.mp4` | One session per worktree, in parallel |
| `status-at-a-glance.mp4` | `docs/images/features/cm-02-status-at-a-glance.en.mp4` | Running / waiting / finished, told apart |
| `approve-from-phone.mp4` | `docs/images/features/cm-06-approve-from-phone.en.mp4` | Answering an agent prompt from a phone |
| `tmux-in-browser.mp4` | `docs/images/features/cm-08-tmux-in-browser.en.mp4` | A tmux session driven from the browser |

These are byte-for-byte copies of the English feature demos added in Issue #1574, not re-encodes.
They meet the condition #1272 set out: each take was recorded in an **isolated environment** — a
throwaway seed repository (`cmdemo-app`), a dedicated port and a dedicated database — with a stubbed
agent replaying captured terminal output, so no private repository name, personal path or source
code appears in any frame. The provenance is documented in `docs/en/features/product-highlights.md`.

They are copied rather than referenced because Pages deploys `website/` only: a `../docs/` path
would 404 in production, and two tests pin that.

### Updating them

```bash
# Regenerate the feature demos first (.claude/skills/demo-video), then, from the repo root:
for pair in cm-01-parallel-worktrees:parallel-worktrees \
            cm-02-status-at-a-glance:status-at-a-glance \
            cm-06-approve-from-phone:approve-from-phone \
            cm-08-tmux-in-browser:tmux-in-browser; do
  cp "docs/images/features/${pair%%:*}.en.mp4" "website/assets/media/${pair##*:}.mp4"
  ffmpeg -v error -y -ss 1 -i "website/assets/media/${pair##*:}.mp4" \
    -frames:v 1 -c:v libwebp -q:v 80 "website/assets/media/poster-${pair##*:}.webp"
done
```

The poster is what `preload="none"` shows before playback; without one the box is black. English
only — the LP is English.

Budget: **every file under `website/` stays below 5MB**, whatever its extension. The four mp4s are
about 0.6MB each; the same twenty seconds as GIF would be about 1.3MB.

## Gallery images (webp)

```bash
for n in screenshot-desktop screenshot-mobile screenshot-worktree-desktop \
         screenshot-worktree-mobile screenshot-worktree-mobile-terminal; do
  cwebp -q 82 "docs/images/$n.png" -o "website/assets/img/$n.webp"
done
```

Budget: **each image < 100KB**, except `screenshot-worktree-desktop.webp`. `screenshot-desktop.webp`
is both the hero and the `og:image`, so it is what Lighthouse measures as LCP — and it stays the
`og:image` regardless of the demos, since a video never renders as a social preview.
