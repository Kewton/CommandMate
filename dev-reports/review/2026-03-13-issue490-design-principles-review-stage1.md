# Issue #490 Stage 1: 設計原則レビュー

| 項目 | 内容 |
|------|------|
| Issue | #490 HTMLファイル レンダリング |
| ステージ | Stage 1 - 通常レビュー（設計原則） |
| 対象文書 | `dev-reports/design/issue-490-html-preview-design-policy.md` |
| レビュー日 | 2026-03-13 |
| 総合評価 | **Good** |

---

## サマリー

設計方針書は全体的に高品質であり、既存のコードベースパターン（`isImage`/`isVideo`、`dynamic import`、拡張子設定ファイル）との整合性が優れている。SOLID原則・KISS原則は概ね遵守されている。主な指摘事項は、SandboxLevel型の重複定義（DRY違反）、`normalizeExtension`関数の未再利用（DRY違反）、Fullサンドボックスレベルの必要性への疑問（YAGNI原則）、および`editable-extensions`へのHTML追加の設計意図の曖昧さの4点である。

---

## 指摘事項一覧

| ID | 重要度 | カテゴリ | タイトル |
|----|--------|----------|----------|
| DR1-001 | must_fix | DRY原則 | SandboxLevel型の重複定義 |
| DR1-002 | should_fix | DRY原則 | normalizeExtension関数の未再利用 |
| DR1-003 | should_fix | YAGNI原則 | Fullサンドボックスレベルの初期リリースでの必要性 |
| DR1-004 | should_fix | 単一責任原則 | editable-extensionsへのHTML追加の設計意図が不明確 |
| DR1-005 | nice_to_have | 既存パターン整合性 | MARP定数の重複（スコープ外） |
| DR1-006 | nice_to_have | 型定義の完全性 | HtmlViewMode型の定義場所 |
| DR1-007 | nice_to_have | 開放閉鎖原則 | ファイルタイプ分岐のif-else連鎖 |

---

## 詳細

### DR1-001 [must_fix] SandboxLevel型がhtml-extensions.tsとHtmlPreview.tsxの2箇所で重複定義されている

**問題**: 設計方針書のセクション3-1で`SandboxLevel`型を`html-extensions.ts`に定義し、セクション3-4で`HtmlPreview.tsx`にも同一の`SandboxLevel`型を`export`している。型定義が2箇所に存在すると、将来の変更時に片方だけ更新される不整合リスクがある。

**改善案**: `SandboxLevel`型は`html-extensions.ts`のみで定義し、`HtmlPreview.tsx`ではimportして使用する。`SANDBOX_ATTRIBUTES`定数も同様に`html-extensions.ts`をSingle Source of Truthとする。`HtmlPreview.tsx`には`HtmlViewMode`型のみを定義する。

---

### DR1-002 [should_fix] normalizeExtension関数がimage-extensions.tsに既存だが再利用が明記されていない

**問題**: 設計方針書の`isHtmlExtension`関数の説明に「ドット正規化対応」と記載されているが、`image-extensions.ts`に既にexportされている`normalizeExtension`関数の再利用について言及がない。`video-extensions.ts`は`image-extensions.ts`からimportして再利用している既存パターンがある。

**根拠コード**（`src/config/video-extensions.ts` 行17）:
```typescript
import { normalizeExtension } from '@/config/image-extensions';
```

**改善案**: `html-extensions.ts`の`isHtmlExtension`実装では`image-extensions.ts`から`normalizeExtension`をimportして再利用する旨を設計方針書に明記する。

---

### DR1-003 [should_fix] Fullサンドボックスレベル（allow-scripts allow-same-origin）の初期リリースでの必要性

**問題**: 設計方針書自体がセクション3-4で「将来的に2段階（Safe/Interactive）への簡素化を検討」と記載しており、Fullレベルの必要性に自ら疑問を呈している。`allow-scripts` + `allow-same-origin`の組み合わせはsandboxを実質無効化するため、セキュリティリスクが高い。初期リリースでこのレベルを提供する明確なユースケースが設計書に記載されていない。

**改善案**: 初期リリースではSafe/Interactiveの2段階のみとし、Fullレベルは具体的なユーザー要求が発生してから追加する。YAGNI原則に従い、不要な機能とセキュリティリスクを同時に排除できる。

---

### DR1-004 [should_fix] editable-extensionsへのHTML追加の設計意図が不明確

**問題**: `editable-extensions.ts`のJSDocコメントに「MarkdownEditorで編集可能な拡張子」と明記されているが、HTMLファイルは`MarkdownEditor`ではなく`HtmlPreview`で編集される。`EDITABLE_EXTENSIONS`に`.html`/`.htm`を追加する理由（PUT APIでの保存許可が目的と推測される）が設計書で明確に説明されていない。

**根拠コード**（`src/config/editable-extensions.ts` 行8）:
```typescript
 * This module defines which file extensions can be edited in the MarkdownEditor.
```

**改善案**: 設計方針書に、`EDITABLE_EXTENSIONS`が実際にはPUT `/files/...` APIの書き込み許可リストとして機能する旨を明記する。あるいは、モジュール名やJSDocを「ブラウザ上で編集可能なファイル拡張子」に更新することを改善項目として記載する。

---

### DR1-005 [nice_to_have] MARP_FRONTMATTER_REGEXとMAX_MARP_CONTENT_LENGTHの重複

**問題**: 既存コードベースにおいてMARPのフロントマター検出パターンと最大コンテンツ長が`FilePanelContent.tsx`と`FileViewer.tsx`の両方で独立定義されている。Issue #490の直接スコープ外だが、HTMLプレビュー追加時に`FileViewer.tsx`を変更する際に整理する機会がある。

**改善案**: 別Issueで対応する。将来的にはファイルタイプ判定ロジックをユーティリティモジュールに集約することを検討する。

---

### DR1-006 [nice_to_have] HtmlViewMode型の定義場所の検討

**問題**: `HtmlViewMode`型がHtmlPreview.tsxコンポーネント内で定義される設計だが、MarkdownEditorのViewModeは`src/types/markdown-editor.ts`に定義されている。型定義の配置ポリシーに一貫性がない。

**改善案**: 現時点ではHtmlPreviewのみが使用するためコンポーネントローカルで問題ないが、将来FileViewer.tsxでも使用する場合は外部化が必要。

---

### DR1-007 [nice_to_have] FilePanelContent.tsxのファイルタイプ分岐がif-else連鎖で拡張性に課題

**問題**: `FilePanelContent.tsx`は現在`isImage` -> `isVideo` -> `extension === 'md'` -> デフォルトのif-else連鎖でファイルタイプを判定しており、`isHtml`追加で更に分岐が増える。

**改善案**: 現時点では分岐が5種類程度であり、シンプルなif-else連鎖はKISS原則とのバランスが取れているため即時対応は不要。将来的にファイルタイプが増加した場合はStrategy/Registryパターンを検討する。

---

## 設計原則チェックリスト

| 原則 | 評価 | 備考 |
|------|------|------|
| 単一責任原則（SRP） | OK | HtmlPreviewの独立コンポーネント化は適切 |
| 開放閉鎖原則（OCP） | 注意 | if-else連鎖は許容範囲だが将来的に要改善 |
| リスコフの置換原則（LSP） | 該当なし | - |
| インターフェース分離原則（ISP） | OK | HtmlPreviewPropsは必要最小限 |
| 依存関係逆転原則（DIP） | OK | 設定層・型定義層の分離が適切 |
| KISS原則 | OK | iframe srcdocによるシンプルな実装方針 |
| YAGNI原則 | 要改善 | Fullサンドボックスレベルの早期実装 |
| DRY原則 | 要改善 | SandboxLevel型重複、normalizeExtension未再利用 |

---

## 統計

| 重要度 | 件数 |
|--------|------|
| must_fix | 1 |
| should_fix | 3 |
| nice_to_have | 3 |
| **合計** | **7** |
