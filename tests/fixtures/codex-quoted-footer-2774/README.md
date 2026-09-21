# codex: 引用されたフッタ文言でフレームが切れる（Issue 2774）

`idle-after-quoted-picker-footer.txt` は **合成**である。2026-09-20 に
`mcbd-codex-mycodebranchdesk` で実際に起きた事象（1002 行のキャプチャ、誤認行は L39 の 1 行、
composer は L330）を、同じ構造のまま 32 行に縮めたもの。実キャプチャは私有の会話本文を含むため置かない。

再現に必要な条件は 3 つで、この fixture はそのすべてを満たす:

1. 会話本文のどこかに `Enter to select … navigate` を含む行がある（`CLAUDE_PICKER_FOOTER_PATTERN` に一致）
2. その行より下に、`CLAUDE_LOWER_INTERACTIVE_ANCHOR` が拾える行が**無い**
   （codex の composer は `›` U+203A で、修正前の `[>❯]` に含まれない）
3. 切り落とし後の 15 行窓に codex の `promptPattern`（`/^›\s*/m`）が現れない
   — このため誤認行の**上に 15 行以上**の本文を置いている

条件 3 が無いと、切り落とされた側に `›` 行が残って `ready` と判定され、再現しない。
