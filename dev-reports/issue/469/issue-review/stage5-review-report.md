# Issue #469 レビューレポート - Stage 5

**レビュー日**: 2026-03-11
**フォーカス**: 通常レビュー（2回目）
**ステージ**: 5/6

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

**総合評価**: good

Stage 1（通常レビュー1回目）で指摘した7件、Stage 3（影響範囲レビュー1回目）で指摘した8件のうち、本Issueに反映すべき全ての指摘が適切に対応されている。Issue本文は技術的に正確で、設計の詳細度も実装に着手できるレベルに達している。2回目通常レビューでは、前回では検出されなかった設計思想の不統一や、エッジケースに関する2件のshould_fixを新たに検出した。

---

## 前回指摘の反映状況

### Stage 1 指摘（全7件: 反映済み）

| ID | タイトル | 反映 | 備考 |
|----|---------|:----:|------|
| SF-1 | ポーリング間隔が曖昧 | 済 | 定数名と値（5000ms）を明示 |
| SF-2 | 差分検知方法が不明確 | 済 | クライアント側JSONハッシュ比較を採用 |
| SF-3 | 編集中保護の判定方法が未記載 | 済 | isDirty/onDirtyChange/SET_DIRTYの完全なデータフローを記載 |
| SF-4 | mtime/sizeチェックがオプション扱い | 済 | 基本設計として必須実装に格上げ |
| NTH-1 | FileViewer.tsxのスコープ不明 | 済 | スコープ外と明記 |
| NTH-2 | ポーリングライフサイクル詳細なし | 済 | visibilitychange停止をパフォーマンス要件に追加 |
| NTH-3 | FilePanelSplit/Tabsが関連ファイルに未記載 | 済 | 関連ファイルに追加 |

### Stage 3 指摘（全8件: 反映済み）

| ID | タイトル | 反映 | 備考 |
|----|---------|:----:|------|
| F1 | refreshTriggerとポーリングの排他制御 | 済 | refreshTriggerインクリメント統合方式を推奨として記載 |
| F2 | バックグラウンドタブのポーリング停止 | 済 | パフォーマンス要件に追加、複数ワークツリー対応も記載 |
| F3 | FileTab型isDirty追加の影響範囲 | 済 | 変更対象更新、isDirtyデータフロー詳述 |
| F4 | 304応答のクライアント側ハンドリング | 済 | fetch分離設計、response.ok注意点、スコープ外明記 |
| F5 | テスト計画未記載 | 済 | テスト要件4項目を受け入れ条件に追加 |
| F6 | WorktreeDetailRefactored統合設計 | 済 | FileTreeView内ポーリング、isActive prop伝搬を記載 |
| F7 | CLAUDE.mdの更新（nice_to_have） | - | 実装後対応のため現時点では未対応で問題なし |
| F8 | APIロギングへの影響（nice_to_have） | - | スコープ外として別Issue候補。現時点では未対応で問題なし |

---

## 新規指摘事項

### Should Fix

#### F1: 案Aと案Bでポーリング設計パターンが不統一

**カテゴリ**: 整合性

**問題**:
案Aでは「refreshTriggerをインクリメントする形にし、既存のuseEffectにフローを統一する」方式を推奨している。これはポーリング専用のuseEffectを持たないシンプルな設計である。一方、案Bでは「ポーリング用は別のuseEffectまたはカスタムフックとして分離する」と記載している。

案C（A+Bの組み合わせ）が推奨とされているが、2つの異なるポーリングパターンが混在する。特に、visibilitychangeによるポーリング停止を一元管理する場合に、2系統のポーリングを統括する設計が複雑になる可能性がある。

**推奨対応**:
案Cの実装指針として、ポーリング管理の統一方針を追記する。選択肢としては:
1. 各コンポーネント（FileTreeView/FilePanelContent）が独立してvisibilitychange対応を行う（WorktreeDetailRefactoredの既存パターンを参照）
2. ポーリング管理をWorktreeDetailRefactored側で一括制御し、isPollingActive propとして各コンポーネントに伝搬する

---

#### F2: isDirty中に外部変更が発生した場合のユーザー通知が未設計

**カテゴリ**: 完全性

**問題**:
受け入れ条件では「isDirty === trueのファイルは自動更新で上書きされない」と定義されている。しかし、ユーザーが編集中にCLIツールが同じファイルを更新した場合、ポーリングはisDirtyのためスキップするが、ユーザーは外部変更の発生を知る手段がない。結果として、保存時に外部変更を上書きするリスクがある。

**推奨対応**:
本Issueのスコープとして対応するか、将来Issueとするかを明記する。
- スコープ内の場合: isDirtyかつサーバー側変更ありの場合にタブにコンフリクト警告を表示
- スコープ外の場合: 「isDirty中の外部変更通知は将来Issueで対応。現時点では最後の保存が優先される」と受け入れ条件に補足

---

### Nice to Have

#### F3: FilePanelTabs.tsxでのisDirty表示仕様が未具体化

**カテゴリ**: 明確性

変更対象に「isDirty状態に応じたタブ表示（未保存インジケーター等）」と記載されているが、具体的なUI仕様が未定義。MarkdownEditor内にも既存のisDirty表示（行697付近）があるため、表示重複の可能性もある。UIの詳細は実装時判断でも問題ないが、明記があると実装者の判断が容易になる。

---

#### F4: JSON.stringifyハッシュ比較のパフォーマンス前提が未記載

**カテゴリ**: 技術的妥当性

クライアント側JSON.stringify(rootItems)ハッシュ比較を採用しているが、大規模ツリーでのコストについて言及がない。実用上、ルートレベルのアイテム数は数十程度であり問題ないが、この前提を補足するとよい。

---

## 参照ファイル

### コード
| ファイル | 関連箇所 |
|---------|---------|
| `src/components/worktree/FileTreeView.tsx` | 行594-666: refreshTrigger統合方式の適用対象 |
| `src/components/worktree/FilePanelContent.tsx` | 行646-678: ポーリング用fetch分離の対象 |
| `src/components/worktree/MarkdownEditor.tsx` | 行202, 697: isDirty状態と既存未保存インジケーター |
| `src/hooks/useFileTabs.ts` | 行36-47, 58-67: FileTab型/FileTabsAction型の変更対象 |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | 行1841-1945: 既存handleVisibilityChangeパターン |
| `src/app/api/worktrees/[id]/files/[...path]/route.ts` | 行256-272: Last-Modified/304対応追加箇所 |

### ドキュメント
- `CLAUDE.md`: モジュール一覧・技術スタック確認
