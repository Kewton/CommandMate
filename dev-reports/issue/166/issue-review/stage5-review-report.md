# Issue #166 Stage 5 レビューレポート

**レビュー日**: 2026-03-14
**フォーカス**: 通常レビュー（2回目）
**ステージ**: Stage 5 / 6

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

## 前回指摘事項の反映状況

### Must Fix（Stage 1: 3件 + Stage 3: 1件 = 全4件）

| ID | 指摘内容 | ステータス |
|----|---------|-----------|
| MF-1 | 背景の「.claude/commands/*.mdのみ対応」は事実と異なる | 反映済み |
| MF-2 | SlashCommandSource型への新値追加タスクが欠落 | 反映済み |
| MF-3 | ホームディレクトリアクセスのセキュリティ設計が未記載 | 反映済み |
| IA-004 | filterCommandsByCliTool()のデフォルト挙動と設計前提の明記 | 反映済み |

### Should Fix（Stage 1: 5件 + Stage 3: 4件 = 全9件）

| ID | 指摘内容 | ステータス |
|----|---------|-----------|
| SF-1 | 非推奨Custom Promptsの対応方針が不明確 | 反映済み |
| SF-2 | filterCommandsByCliTool()との統合方法が未定義 | 反映済み |
| SF-3 | グローバル/ローカルの読み込みスコープ設計が未定義 | 反映済み |
| SF-4 | 受け入れ条件（Acceptance Criteria）が未定義 | 反映済み |
| SF-5 | SKILL.md形式パースの仕様詳細が不足 | 反映済み |
| IA-001 | clearCache()へのCodexスキルキャッシュクリア影響 | 反映済み |
| IA-002 | APIレスポンスのsources集計にcodex-skillの追加 | 反映済み |
| IA-003 | CATEGORY_ORDER/CATEGORY_LABELS連動更新の注意 | 反映済み |
| IA-006 | ホームディレクトリ解決方法(os.homedir())の明示 | 反映済み |
| IA-007 | グローバル/ローカル重複排除テストの設計 | 反映済み |

### Nice to Have（Stage 1: 1件反映済み、1件スキップ / Stage 3: 2件スキップ）

| ID | 指摘内容 | ステータス |
|----|---------|-----------|
| NTH-1 | 関連Issue #343へのリンク追加 | 反映済み |
| NTH-2 | 既存UIコンポーネントへの影響記載 | スキップ（Stage 3で対応） |
| IA-005 | ホームディレクトリ配下アクセスの考慮 | スキップ（テキスト肥大化防止） |
| IA-008 | メインAPIルートでのCodexスキル扱い | スキップ（テキスト肥大化防止） |

**反映率**: must-fix 4/4 (100%), should-fix 10/10 (100%), nice-to-have 1/1反映対象 (100%)

---

## 新規指摘事項

### Should Fix（推奨対応）

#### S5-001: D009コメントとfilterCommandsByCliTool()実装の矛盾

**カテゴリ**: 正確性
**場所**: Issue本文 - CLIツール別フィルタリング統合セクション / src/lib/slash-commands.ts:126-130

**問題**:
Issue本文の設計前提では「cliToolsがundefinedのスキルはclaudeタブでのみ表示される」と**正しく**記載されているが、既存のソースコード(src/lib/slash-commands.ts)のD009コメントには「Skills currently do not set cliTools, making them available for all CLI tools via filterCommandsByCliTool()」と記載されている。

実際のfilterCommandsByCliTool()の実装(command-merger.ts:193-194)は:
```typescript
if (!cmd.cliTools) {
  return cliToolId === 'claude';
}
```
であり、D009コメントは事実と異なる。Issue #166の実装時にこのコメントを参照した開発者がIssueの設計前提と既存コメントのどちらを信頼すべきか迷う可能性がある。

**推奨対応**:
Issue #166の実装タスクまたは注意事項に、D009コメントの修正を含めることを推奨する。あるいは事前にD009コメントを修正してからIssue #166に着手する。

---

#### S5-002: Issueタイトルに「~/.codex/prompts/」が残っている

**カテゴリ**: 明確性
**場所**: Issueタイトル

**問題**:
現在のIssueタイトルは「feat: Codexカスタムコマンド読込対応（~/.codex/prompts/, .codex/skills/）」だが、Issue本文ではCustom Prompts(~/.codex/prompts/)は「非推奨 - 対象外」と明記されている。タイトルが実際のスコープと一致していない。

**推奨対応**:
Issueタイトルを「feat: Codexカスタムスキル読込対応（.codex/skills/, ~/.codex/skills/）」等に修正し、対象範囲を正確に反映させる。

---

### Nice to Have（あれば良い）

#### S5-003: 参考リンクの有効性未確認

**カテゴリ**: 完全性
**場所**: Issue本文 - 参考リンクセクション

**問題**:
Codex公式ドキュメントURL 3件の有効性が未確認。

**推奨対応**:
実装着手前にリンクの有効性を確認し、必要に応じて代替参照先を追記する。

---

#### S5-004: 対象外機能(Custom Prompts)の詳細仕様記載が冗長

**カテゴリ**: 完全性
**場所**: Issue本文 - Codexのカスタムコマンド仕様 - Custom Promptsセクション

**問題**:
対象外と明示されているCustom Promptsの引数仕様($1-$9等)が詳細に記載されており、読み手のスコープ理解を妨げる可能性がある。

**推奨対応**:
最小限の記載に縮小する。ただしテキスト量としては軽微であり、対応は任意。

---

## 総合評価

Stage 1-4の全指摘事項（must-fix 4件、should-fix 10件）が全て適切に反映されており、Issue #166は**実装着手に十分な品質**に達している。

新たなmust-fix事項はなく、残る指摘はshould-fix 2件のみ:
1. **S5-002**: Issueタイトルの修正（対応時間: 数秒）
2. **S5-001**: D009コメント矛盾の注記（実装時に対応可能）

Issue全体として、以下の設計要素が網羅的に記載されている:
- 型定義の拡張方針（SlashCommandSource, SlashCommandCategory）
- セキュリティ対策（5項目）
- フィルタリング設計前提（filterCommandsByCliTool()のデフォルト挙動）
- キャッシュ管理（clearCache()連動）
- APIレスポンス型更新
- 読み込みスコープ設計（グローバル/ローカル、優先度、キャッシュ）
- 受け入れ条件（7項目、検証可能）
- テスト計画（Unit/Integration）

## 参照ファイル

### コード
- `src/lib/slash-commands.ts`: 既存コマンド・スキル読込ロジック（D009コメント矛盾箇所を含む）
- `src/lib/command-merger.ts`: filterCommandsByCliTool()の実装
- `src/types/slash-commands.ts`: SlashCommandSource/Category型定義

### ドキュメント
- `CLAUDE.md`: プロジェクト構成・モジュール一覧
