# テスト計画レビュー（1回目）

## 網羅性チェック

| # | 受入条件 | 対応テストケース | ステータス |
|---|---------|----------------|----------|
| 1 | PC版1920pxでFiles→ファイルクリックでFilePanelがviewport内 | TC-001 | ✅ カバー済 |
| 2 | `file-panel-pane.getBoundingClientRect().right <= window.innerWidth` | TC-001 | ✅ カバー済 |
| 3 | `desktop-layout` の幅がviewport内 | TC-002 | ✅ カバー済 |
| 4 | History表示/非表示・ActivityPane幅変更でも viewport内 | TC-003, TC-004 | ✅ カバー済 |
| 5 | ターミナル/履歴の表示が壊れない（既存挙動維持） | TC-005 | ✅ カバー済 |
| 6 | モバイル変更なし | TC-006 | ✅ カバー済（静的） |
| 7 | lint/tsc/test:unit/build 全PASS | TC-006 | ✅ カバー済（静的） |

## 指摘事項

| # | 種別 | 内容 | 対応方針 |
|---|------|------|---------|
| 1 | should_fix | `file-panel-pane` の data-testid が実在するか未確認。クリック後にFilePanelSplitが描画する要素のtestidを実コードで確認すべき | Phase 5 でDOM確認。存在しない場合はFilePanel領域の可視要素を querySelector で特定 |
| 2 | should_fix | 既存 worktree が DB に無い場合 TC が実行不能。事前にworktree存在を確認し、無ければ登録手順を追加 | Phase 5 で `/api/worktrees` を確認、worktree選択 |
| 3 | should_fix | TC-001 の「任意ファイル」は、ツリー展開が必要な場合がある。ルート直下の確実に存在するファイル（例 AGENTS.md / package.json）を対象にする | テスト実行時にツリー先頭の可視ファイルをクリック |
| 4 | nice_to_have | 修正前後の対比（before=溢れ, after=収まる）を示せると説得力が上がるが、修正は既に適用済みのため after のみで受入判定可 | after のみで判定。設計方針書の実測値（before 2825px）を参照値として報告書に併記 |

## 結論
全7受入条件をカバー。must_fix なし。should_fix 3件は Phase 5 セットアップ時に解消する運用事項。
