# Landing page media — how these files are generated

The files here are **generated artifacts**, re-encoded from the high-resolution originals in
`docs/images/`. The originals (`demo-desktop.mp4` 22MB, `demo-mobile.mp4` 47MB) are far too large to
serve and are deliberately **not** copied into `website/`. Regenerate with the commands below rather
than editing these files by hand.

Budget: **video < 1.5MB each**, **poster < 100KB each** (the poster is what Lighthouse measures as LCP).

## Video (h264 / mp4)

```bash
# Desktop hero: 1920x1080/60fps/30s -> 1280x720/30fps  => 1.30 MB
ffmpeg -y -i docs/images/demo-desktop.mp4 \
  -vf "scale=1280:-2,fps=30" -an \
  -c:v libx264 -crf 30 -preset slow -profile:v high -pix_fmt yuv420p -movflags +faststart \
  website/assets/media/demo-desktop.mp4

# Mobile: 1080x2340/120fps/33s -> 360x780/30fps  => 1.13 MB
ffmpeg -y -i docs/images/demo-mobile.mp4 \
  -vf "scale=360:-2,fps=30" -an \
  -c:v libx264 -crf 33 -preset slow -profile:v high -pix_fmt yuv420p -movflags +faststart \
  website/assets/media/demo-mobile.mp4
```

`-an` drops audio (the demos are silent). `-movflags +faststart` moves the moov atom to the front so
playback can begin before the whole file arrives.

### Why mp4 only, and no webm

VP9/webm was encoded and measured, then dropped: on this content (dense terminal text) it was
**bigger at equivalent quality**, so a `<source>` ordering that preferred it would have served the
*larger* file.

| Encode | Size | SSIM vs. downscaled reference |
|---|---|---|
| h264 CRF 30 | **1.30 MB** | 0.9852 |
| VP9 CRF 45 | 1.40 MB | 0.9876 |
| VP9 CRF 37 | 2.04 MB | — |

+94KB for +0.0024 SSIM is not a trade worth a second artifact. h264/mp4 is supported by every browser
in the project's support matrix (Safari 16.4+ / Chrome 111+ / Firefox 128+ — see README "Browser
Support"), so the mp4 needs no companion format.

Measured with:

```bash
ffmpeg -i docs/images/demo-desktop.mp4 -vf "scale=1280:-2,fps=30" -an -c:v ffv1 /tmp/ref.mkv
ffmpeg -i website/assets/media/demo-desktop.mp4 -i /tmp/ref.mkv -lavfi "[0:v][1:v]ssim" -f null -
```

## Posters and gallery images (webp)

```bash
# Poster frames sampled at t=8s, where the UI is populated
ffmpeg -y -ss 8 -i docs/images/demo-desktop.mp4 -vf "scale=1280:-2" -frames:v 1 /tmp/poster-desktop.png
ffmpeg -y -ss 8 -i docs/images/demo-mobile.mp4  -vf "scale=360:-2"  -frames:v 1 /tmp/poster-mobile.png
cwebp -q 78 /tmp/poster-desktop.png -o website/assets/img/demo-desktop-poster.webp   # 54.9 KB
cwebp -q 80 /tmp/poster-mobile.png  -o website/assets/img/demo-mobile-poster.webp    # 21.3 KB

# Gallery: the five previously unused screenshots
for n in screenshot-desktop screenshot-mobile screenshot-worktree-desktop \
         screenshot-worktree-mobile screenshot-worktree-mobile-terminal; do
  cwebp -q 82 "docs/images/$n.png" -o "website/assets/img/$n.webp"
done
```
