# Landing page media — how these files are generated

The landing page ships **no video**. This directory holds only this note; the images the page
does serve live in `website/assets/img/` and are generated with the commands below.

## Why there is no demo video (Issue #1272)

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

Rather than re-record, the page now uses the screenshots from Issue #1221, which were captured in an
isolated environment against CommandMate's own repository. `og:image` points at
`screenshot-desktop.webp` for the same reason.

**If you ever add a video back**, re-record it in an isolated environment first — never re-encode
from `docs/images/`. Those originals stay in the repository only because the README GIFs reference
them; they are not a clean source.

## Gallery images (webp)

```bash
for n in screenshot-desktop screenshot-mobile screenshot-worktree-desktop \
         screenshot-worktree-mobile screenshot-worktree-mobile-terminal; do
  cwebp -q 82 "docs/images/$n.png" -o "website/assets/img/$n.webp"
done
```

Budget: **each image < 100KB**, except `screenshot-worktree-desktop.webp`. `screenshot-desktop.webp`
is both the hero and the `og:image`, so it is what Lighthouse measures as LCP.
`tests/unit/website/landing-page.test.ts` enforces the budget and the no-video rule.
