# Issue #86 影響範囲レビューレポート

**レビュー日**: 2026-01-30
**ステージ**: 3（影響範囲レビュー 1回目）
**対象Issue**: リリース手順書とスキル自動化

---

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 1 |
| Should Fix | 3 |
| Nice to Have | 3 |
| **合計** | **7** |

---

## 影響範囲分析

### 変更対象ファイル

| ファイルパス | 変更種別 | 説明 |
|-------------|---------|------|
| `docs/release-guide.md` | 新規作成 | リリース手順書 |
| `.claude/skills/release/SKILL.md` | 新規作成 | リリーススキル本体 |
| `.claude/skills/release/templates/changelog-entry.md` | 新規作成 | テンプレート |
| `.claude/skills/release/examples/release-example.md` | 新規作成 | 実行例 |
| `CLAUDE.md` | 更新 | スキル一覧に追加 |
| `docs/user-guide/commands-guide.md` | 更新推奨 | スキル説明追加を検討 |

### 依存関係

#### 内部依存

- **Issue #40（セマンティックバージョニング導入）**: CLOSED - 完了済み
- **CHANGELOG.md**: Keep a Changelog形式で存在 - 確認済み
- **package.json**: version: 0.1.0 - 確認済み

#### 外部依存

- `gh` CLI（GitHub Releases作成）
- `git` コマンド（タグ操作）
- `npm version` コマンド（オプション）

### CI/CD影響

直接的な影響なし。`.github/workflows/ci-pr.yml`への変更は不要。

### ドキュメント影響

- **CLAUDE.md**: 更新必須（受け入れ条件に記載あり）
- **docs/user-guide/commands-guide.md**: 更新検討
- **docs/user-guide/agents-guide.md**: スキルとエージェントの違い明確化を検討

### ユーザー影響

- 破壊的変更: なし
- 新機能: `/release` コマンドが利用可能に

---

## Must Fix（必須対応）

### MF-1: ドキュメント更新対象の明示的記載がない

**カテゴリ**: 完全性
**場所**: ## 受け入れ条件 セクション

**問題**:
受け入れ条件には「CLAUDE.mdにスキルの説明が追加されている」のみ記載されていますが、他のドキュメント（`docs/user-guide/commands-guide.md`や`docs/user-guide/agents-guide.md`）への影響が明示されていません。

**証拠**:
- `docs/user-guide/commands-guide.md`: コマンド一覧が記載されているが、スキルの記載なし
- `docs/user-guide/agents-guide.md`: エージェント一覧が記載されているが、スキルとの関係性が不明確

**推奨対応**:
以下のドキュメント更新要否を受け入れ条件に追加:
- `docs/user-guide/commands-guide.md`へのスキル説明追加
- スキルとコマンドの違いの説明

---

## Should Fix（推奨対応）

### SF-1: 既存のrebuildスキルとの構造整合性

**カテゴリ**: 整合性
**場所**: ## 2. リリーススキルの作成 セクション

**問題**:
既存の`.claude/skills/rebuild/SKILL.md`はシンプルな単一ファイル構成ですが、新しいreleaseスキルでは`templates/`と`examples/`サブディレクトリを追加する計画です。この構造の違いに対する説明がありません。

**証拠**:
既存rebuild構造:
```
.claude/skills/rebuild/
  SKILL.md
```

提案されたrelease構造:
```
.claude/skills/release/
  SKILL.md
  templates/changelog-entry.md
  examples/release-example.md
```

**推奨対応**:
- 新しいディレクトリ構造を採用する理由を明記
- または既存スキルと同じ単一ファイル構成に統一

---

### SF-2: npm version未使用時のpackage-lock.json更新方法

**カテゴリ**: 技術的妥当性
**場所**: ## 実行内容 セクション

**問題**:
手順4で「npm installでpackage-lock.json更新」とありますが、依存関係が変わらない場合は不要なダウンロード処理が発生する可能性があります。

**証拠**:
実行内容の手順:
> 4. npm installでpackage-lock.json更新

**推奨対応**:
`npm install --package-lock-only`の使用を検討。これにより依存関係のダウンロードをスキップしてpackage-lock.jsonのみを更新できます。

---

### SF-3: スキルとコマンドの関係性の明確化

**カテゴリ**: 影響範囲
**場所**: Issue全体

**問題**:
プロジェクトには`.claude/skills/`（スキル）と`.claude/commands/`（コマンド）の両方が存在しますが、その使い分けがユーザーに分かりにくい可能性があります。

**証拠**:
- `.claude/commands/`: 15個のコマンド定義
- `.claude/skills/`: 1個のスキル定義（rebuild）
- Issue本文のNote: 「Claude Code Skillsでは、スキルもスラッシュコマンドとして呼び出し可能」

**推奨対応**:
- スキルとコマンドの違いをドキュメント化
- 新規作成するドキュメント（`docs/release-guide.md`）でスキルの位置づけを説明

---

## Nice to Have（あれば良い）

### NTH-1: GitHub Releases自動作成の詳細手順

**カテゴリ**: 拡張性
**場所**: ## 実行内容 セクション

**問題**:
手順8の「GitHub Releases作成（推奨）」が`gh`コマンド使用なのか手動なのか不明確です。

**推奨対応**:
具体的なコマンド例を追加:
```bash
gh release create v0.2.0 --title "v0.2.0" --notes-file RELEASE_NOTES.md
```

---

### NTH-2: CHANGELOG.mdの比較リンク更新の具体例

**カテゴリ**: 完全性
**場所**: ## 1. リリース手順書の作成 セクション

**問題**:
Keep a Changelog形式では末尾の比較リンクセクションの更新が必要ですが、Issue本文内での具体的なフォーマット例が分散しています。

**推奨対応**:
リリース手順書の作成内容セクションで、比較リンク更新の具体例を統合して記載。

---

### NTH-3: スキル実行後の確認手順

**カテゴリ**: ユーザビリティ
**場所**: ## 受け入れ条件 セクション

**問題**:
動作検証項目はあるが、ユーザーが手動で確認するためのコマンド例がありません。

**推奨対応**:
確認コマンド例を追加:
```bash
git tag -l          # タグ一覧確認
gh release list     # GitHub Releases確認
cat package.json | jq .version  # バージョン確認
```

---

## 参照ファイル

### コード

| ファイル | 関連性 |
|---------|--------|
| `.claude/skills/rebuild/SKILL.md` | 既存スキルの構造参照 |
| `package.json` | バージョン管理対象 |
| `CHANGELOG.md` | リリース時更新対象 |
| `.github/workflows/ci-pr.yml` | CI/CD影響確認 |

### ドキュメント

| ファイル | 関連性 |
|---------|--------|
| `CLAUDE.md` | スキル一覧更新対象 |
| `docs/user-guide/commands-guide.md` | スキル説明追加検討 |
| `docs/user-guide/agents-guide.md` | スキル/エージェント関係の明確化 |
| `README.md` | プロジェクト概要との整合性 |

---

## 総合評価

Issue #86は、Issue #40（セマンティックバージョニング導入）の完了を前提とした継続的なリリース自動化の取り組みとして、技術的に妥当な内容です。

**依存関係の確認結果**:
- Issue #40: CLOSED（完了済み）
- CHANGELOG.md: Keep a Changelog形式で存在
- package.json: version 0.1.0で整備済み

**リスク評価**: 低
- CI/CDへの直接的な影響なし
- 既存ユーザーへの破壊的変更なし
- 新機能追加のみ

**主な改善点**:
1. ドキュメント更新範囲の明確化（CLAUDE.md以外への影響）
2. 既存rebuildスキルとの構造整合性確認
3. スキルとコマンドの関係性の説明追加
