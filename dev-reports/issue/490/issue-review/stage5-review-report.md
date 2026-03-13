# Issue #490 レビューレポート（Stage 5: 通常レビュー 2回目）

**レビュー日**: 2026-03-13
**フォーカス**: 通常レビュー（2回目）
**ステージ**: Stage 5
**総合評価**: good

---

## サマリー

Stage 1（通常レビュー 1回目）の全8件の指摘事項は全て適切に対応されている。Stage 3（影響範囲レビュー 1回目）の指摘も同様に反映済み。Issue全体の品質は大幅に向上し、実装着手可能な水準に達している。

2回目レビューでの新規指摘は Should Fix 2件、Nice to Have 2件の計4件であり、いずれも軽微な改善提案に留まる。Must Fixは0件。

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 2 |
| Nice to Have | 2 |

---

## 前回指摘事項の対応状況

全8件が解決済み。

| ID | タイトル | 状態 |
|----|---------|------|
| S1-001 | MARPとの実装パターン相違点が未記載 | 解決済み - レンダリング方式セクションに明記 |
| S1-002 | EXTENSION_VALIDATORS設定が未記載 | 解決済み - 実装タスクに具体的に記載、アトミック変更の注意付き |
| S1-003 | ファイルサイズ上限が未確定 | 解決済み - 5MBに確定、受入条件にも追加 |
| S1-004 | sandbox Fullレベルのリスク説明不足 | 解決済み - 専用セクションで危険性と対策を記載 |
| S1-005 | isHtmlフラグ設定の実装詳細不足 | 解決済み - route.tsの変更内容を3点で具体化 |
| S1-006 | DOMPurify活用方針が不明確 | 解決済み - sandbox隔離優先の方針を明記 |
| S1-007 | html-extensions.tsの設計パターン未明示 | 解決済み - 最小API仕様を列挙 |
| S1-008 | モバイル版FileViewerのUI仕様未記載 | 解決済み - タブ切り替え方式とiframe高さ管理を記載 |

---

## 新規指摘事項

### Should Fix（推奨対応）

#### S5-001: FileContentインターフェースへのisHtml追加時のJSDocコメント規約

**カテゴリ**: 整合性
**場所**: 実装タスク「src/types/models.tsにisHtml?: booleanフラグ追加」

**問題**:
既存のFileContentインターフェースではisImage、isVideoにそれぞれJSDocコメントとIssue番号が付記されている（例: `/** Whether the file is a video (optional, for video files) - Issue #302 */`）。isHtmlの追加でも同様の記載パターンを踏襲すべきだが、Issueの実装タスクには言及がない。

**推奨対応**:
実装タスクに「JSDocコメント付き（例: `/** Whether the file is an HTML file (optional) - Issue #490 */`）」を追記する。

---

#### S5-002: route.tsのGETレスポンスとFileContentResponse型の整合性確認

**カテゴリ**: 完全性
**場所**: 実装タスク「route.tsのGETハンドラ変更」および受入条件

**問題**:
route.tsのGETハンドラのレスポンスにisHtml: trueを追加する際、FileContentResponse型（= `{ success: true } & FileContent`）を通じてクライアント側で型安全にアクセスできる必要がある。FileContentにisHtml?を追加すればFileContentResponseにも自動的に含まれるため構造上の問題はないが、テスト項目で型安全性を明示的に確認しておくと安全。

**推奨対応**:
受入条件またはテスト項目に型整合性の確認を追加することを検討する。既存のisImage/isVideoと同パターンのため大きなリスクではない。

---

### Nice to Have（あれば良い）

#### S5-003: EXTENSION_VALIDATORSのadditionalValidation方針の明確化

**カテゴリ**: 明確性
**場所**: 実装タスク「editable-extensions.tsへの追加」

**問題**:
additionalValidationの記述が「XSS危険パターン検出等を検討」と不確定のまま。sandbox隔離が主たるセキュリティ対策であることは明記されているが、初期実装での扱いが実装者の判断に委ねられている。

**推奨対応**:
「初期実装ではadditionalValidationはundefined。sandbox属性による隔離で安全性を担保するため、保存時のHTMLサニタイズは不要」のように方針を明確化する。

---

#### S5-004: blob: URLによるorigin分離の実装判断

**カテゴリ**: 完全性
**場所**: セキュリティ考慮「Fullレベルのセキュリティリスク」

**問題**:
Fullレベルの対策としてblob: URLによるorigin分離が「検討」として記載されているが、初期実装でsrcdocとblob: URLのどちらを採用するか未確定。

**推奨対応**:
「初期実装はsrcdocで進め、FullレベルのセキュリティテストによりBlob URL移行の要否を判断する」のように段階的方針を明記する。

---

## 参照ファイル

### コード
- `src/types/models.ts` (行278-299): FileContentインターフェースとFileContentResponse型
- `src/app/api/worktrees/[id]/files/[...path]/route.ts` (行290-301): GETレスポンスのisHtmlフラグ追加箇所
- `src/config/editable-extensions.ts` (行32-37): EXTENSION_VALIDATORS配列

---

## 総合評価

Issue #490は4回のレビューステージ（Stage 1-4）を経て、実装に必要な情報が十分に記載された状態に達している。前回の全指摘事項が適切に反映され、矛盾や新たな重大問題は検出されなかった。2回目レビューでの指摘は全て軽微であり、実装着手を妨げるものではない。

**判定: good -- 実装着手可能**
