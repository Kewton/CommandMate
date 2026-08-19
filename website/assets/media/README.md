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

## The current demos (Issue #1577, re-cut for Issue #1812)

The four are the four cards in `docs/design/public-messaging.md` §3, one demo each.

| File | Source | Shows |
|------|--------|-------|
| `contract-verify.mp4` | `docs/images/features/cm-11-contract-verify.en.mp4` | A task contract and a `verify.yaml`, then the gates running and printing `RESULT passed` |
| `never-miss-waiting.mp4` | `docs/images/features/cm-03-never-miss-waiting.en.mp4` | A session that stops for confirmation raising a pill and a toast, answered from a phone |
| `parallel-worktrees.mp4` | `docs/images/features/cm-01-parallel-worktrees.en.mp4` | One session per worktree, in parallel, including one plain `git` made outside CommandMate |
| `install-skill.mp4` | `docs/images/features/cm-12-install-skill.en.mp4` | Installing a Skill from the official Catalog, then calling it from the composer |

The three demos this replaced (`status-at-a-glance`, `approve-from-phone`, `tmux-in-browser`) were
recorded from four reused scenes; #1811 measured `cm-01` and `cm-08` at SSIM 0.970 nine seconds in,
i.e. very nearly the same frame twice. They are deleted rather than kept alongside: a file here that
nothing references is a file nobody re-checks the provenance of.

These are byte-for-byte copies of the English feature demos re-recorded in Issue #1811, not
re-encodes. They meet the condition #1272 set out: each take was recorded in an **isolated
environment** — a throwaway seed repository (`cmdemo-app`), a dedicated port and a dedicated
database — with a stubbed agent replaying captured terminal output, so no private repository name,
personal path or source code appears in any frame. `contract-verify` is the one exception to
"stubbed": its gates are executed for real, so the `GATE` lines and the exit code in the footage are
what that run actually produced. The provenance is documented in
`docs/en/features/product-highlights.md`.

They are copied rather than referenced because Pages deploys `website/` only: a `../docs/` path
would 404 in production, and two tests pin that.

### Updating them

```bash
# Regenerate the feature demos first (.claude/skills/demo-video), then, from the repo root.
# The trailing number is the poster timestamp: each demo opens on a title card, so `-ss 1` would
# poster every box with a caption slide instead of the screen the demo is about.
for triple in cm-11-contract-verify:contract-verify:16 \
              cm-03-never-miss-waiting:never-miss-waiting:12 \
              cm-01-parallel-worktrees:parallel-worktrees:16 \
              cm-12-install-skill:install-skill:8; do
  src=${triple%%:*}; rest=${triple#*:}; name=${rest%%:*}; at=${rest##*:}
  cp "docs/images/features/${src}.en.mp4" "website/assets/media/${name}.mp4"
  cmp "docs/images/features/${src}.en.mp4" "website/assets/media/${name}.mp4" || exit 1
  ffmpeg -v error -y -ss "$at" -i "website/assets/media/${name}.mp4" \
    -frames:v 1 -c:v libwebp -q:v 80 "website/assets/media/poster-${name}.webp"
done
```

The `cmp` is the point: a re-encode here would be new footage nobody vetted, and it would look
exactly like the copy. The poster is what `preload="none"` shows before playback; without one the
box is black. English only — the LP is English.

Budget: **every file under `website/` stays below 5MB**, whatever its extension. The four mp4s are
about 0.5MB each; the same twenty seconds as GIF would be about 1.3MB.

## Gallery images (webp)

Generated, not taken by hand (Issue #1810). The five screenshots come out of the same isolated
environment the demo video is filmed in, so the only repository that can appear in one is the
throwaway seed — which is what #1225 could not reproduce about the hand-taken set.

```bash
.claude/skills/demo-video/scripts/env-up.sh
npx tsx .claude/skills/demo-video/scripts/stills.ts --state "$HOME/.commandmate-demo/state.env"
.claude/skills/demo-video/scripts/env-down.sh --purge
```

It writes `docs/images/<id>.png` and `website/assets/img/<id>.webp`, starting at the `cwebp -q 82`
this procedure used to spell by hand. The budget below is enforced rather than remembered: quality
steps down to 40 and then resolution to 0.65, and if nothing fits, **nothing is written and the run
fails**. Before each shot the rendered text is read back and the run fails on a home directory, a
private LAN address, this repository's own name or the retired product name — the fix for which is
to compose the shot differently, never to mask it.

Budget: **each image < 100KB**, except `screenshot-worktree-desktop.webp`.

`screenshot-desktop.webp` is the `og:image`. Issue #1812 replaced the hero image with an inline SVG
of the loop, which changes nothing here: no browser renders an SVG — let alone an inline one — into
a social preview card, so the raster still has to exist and still has to be small. It now opens the
gallery instead of the hero, and the 100KB budget on it is enforced by
`tests/unit/website/landing-page.test.ts` rather than remembered.
