# related-split-4594

`c1-durations.json`: 試験ファイル（`tests/unit/` からのパス）ごとの所要（ms）。1430 files。

- 出どころ: 審判（claude-6）の受け入れ C1（S12、2026-11-27、cache の無い clone で verify の unit-related を流した run）の
  `C1-durations.json` から、`durations` だけを写した（パスの順に並べ替え、値はそのまま）
- 使う試験: `tests/unit/scripts/run-related-unit-tests-baseline-4594.test.ts`（T1: 記録が無いときの組の分けを、この本当の所要で測る）
- 中身は試験ファイルのパスと所要の数だけ。個人の情報（ユーザー名・ホームのパス・トークン）が無いことを確かめた
  - 確かめ方: `grep -ciE '/Users/|/home/|ghp_|[^a]sk-' c1-durations.json` と、このマシンのユーザー名の grep が 0（`sk-` の素の語は `ask-`・`task-` の試験名に当たるので外した）、`token` に当たるのは試験ファイルの名前
    （`design-tokens.test.ts` など）だけ。キーはすべて `^tests/unit/.+\.test\.tsx?$`、値はすべて数
