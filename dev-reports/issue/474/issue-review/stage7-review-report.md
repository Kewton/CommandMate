# Issue #474 レビューレポート（Stage 7）

**レビュー日**: 2026-03-12
**フォーカス**: 影響範囲レビュー（2回目）
**ステージ**: Stage 7

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 2 |

Stage 3の全指摘事項（MF-1, MF-2, MF-3, SF-1, SF-3, SF-4, SF-5）は適切に反映されている。2段階方式（upload API拡張 + send API）の採用により、fetchApiのContent-Type問題は解消され、既存のupload APIセキュリティ機構の再利用方針も明確になった。Must Fix相当の新規漏れはなく、Issueの影響範囲記載は十分に成熟している。

---

## Stage 3 指摘事項の対応確認

| ID | 重要度 | ステータス | 確認内容 |
|----|--------|-----------|---------|
| MF-1 | Must Fix | 解決済み | 2段階方式（upload API + send API）を「画像送信フロー」セクションとして追加。fetchApiのContent-Type問題を回避する設計判断が明記されている |
| MF-2 | Must Fix | 解決済み | send/route.tsの影響範囲にSendMessageRequest型のimagePath追加とsendMessageWithImage呼び分けロジックを具体的に記載 |
| MF-3 | Must Fix | 解決済み | フォールバック方式にpath-validator.tsのisPathSafe/resolveAndValidateRealPathの適用を明記 |
| SF-1 | Should Fix | 解決済み | 既存テストファイルへの影響を専用テーブルとして追加 |
| SF-3 | Should Fix | 解決済み | 実装タスクに.commandmate/attachments/のworktree別.gitignore管理を追加。attachmentsサブディレクトリのみの方針も明確 |
| SF-4 | Should Fix | 解決済み | 変更対象ファイル表にWorktreeDetailRefactored.tsxを追加 |
| SF-5 | Should Fix | 解決済み | SVGの受入条件を「実装時判断」とする柔軟な記述に更新。image-extensions.tsの既存XSS対策との関係も明記 |

---

## Should Fix（推奨対応）

### S7-SF-1: CLIToolInfo型へのsupportsImageプロパティ追加の漏れ

**カテゴリ**: 影響ファイル
**場所**: 影響範囲セクション - 変更対象ファイル表 src/lib/cli-tools/types.ts の行

**問題**:
ICLIToolインターフェースへのsupportsImage拡張は記載されているが、CLIToolInfo型への追加が記載されていない。CLIToolInfoはCLIToolManager.getToolInfo()の戻り値型であり、クライアント側にツール情報を提供する役割を持つ。ここにsupportsImageが含まれないと、クライアント側で画像添付ボタンの表示制御ができない。

**証拠**:
- `src/lib/cli-tools/types.ts` L188-197: CLIToolInfo型は `id`, `name`, `command`, `installed` の4プロパティのみ
- `src/lib/cli-tools/manager.ts` L100-110: getToolInfo()はCLIToolInfoを返すが、supportsImage情報を含まない
- manager.tsは変更対象ファイル表に含まれていない

**推奨対応**:
types.tsの変更内容に「CLIToolInfo型にsupportsImageプロパティを追加」を明記する。また、manager.tsのgetToolInfo()でsupportsImage値を返すロジック追加が必要であり、manager.tsも変更対象ファイル表に追加する。

---

### S7-SF-2: クライアント側upload呼び出しパターンの共通化が未検討

**カテゴリ**: 影響ファイル
**場所**: 影響範囲セクション - src/lib/api-client.ts の行

**問題**:
WorktreeDetailRefactored.tsx内に既にFormData+fetch直接呼び出しによるupload処理（L1784-1813）が存在する。MessageInputからの画像添付時にも同様のupload処理が必要になるが、この処理をapi-client.tsにuploadFile関数として共通化するか、各コンポーネントで個別にfetch()を呼ぶかの設計判断が影響範囲に含まれていない。

**証拠**:
- `src/components/worktree/WorktreeDetailRefactored.tsx` L1790-1796: fetch()を直接使用してupload APIを呼び出し
- `src/lib/api-client.ts`: uploadFile関数が存在しない。fetchApi関数はContent-Type: application/jsonを強制するためFormData送信に使用不可

**推奨対応**:
api-client.tsの変更内容に「uploadFile関数の新設（FormData対応）」を追加するか、または「画像添付のupload呼び出しはMessageInputコンポーネント内で直接fetch()を使用する」旨を明記する。DRY原則に従いapi-client.tsへの共通化が望ましい。

---

### S7-SF-3: uploadable-extensions.tsとimage-extensions.tsのバリデーション体系の整理

**カテゴリ**: 依存関係
**場所**: 影響範囲セクション - src/config/image-extensions.ts の行

**問題**:
既存のupload APIはuploadable-extensions.tsのバリデーション体系を使用しているが、Issueではimage-extensions.tsのバリデーションを再利用する旨が記載されている。upload APIを拡張する場合、どちらのバリデーション体系が適用されるかの整理が必要。

**証拠**:
- `src/config/uploadable-extensions.ts` L47-48: SVGはXSSリスクにより除外済み
- `src/config/image-extensions.ts` L19-26: IMAGE_EXTENSIONSにsvgを含む
- `src/app/api/worktrees/[id]/upload/[...path]/route.ts` L29-35: uploadable-extensions.tsの関数群をimport

**推奨対応**:
影響範囲のimage-extensions.tsの行の「変更なしまたは小」を見直し、uploadable-extensions.tsとの役割分担を明確にする。upload API拡張ではuploadable-extensions.tsのバリデーションがそのまま適用されるため、image-extensions.tsは添付可能な拡張子のクライアント側フィルタリング用途となる可能性が高い。この使い分けを影響範囲に記載すべき。

---

## Nice to Have（あれば良い）

### S7-NTH-1: テストシナリオの具体化

**カテゴリ**: テスト範囲
**場所**: 影響範囲セクション - 既存テストファイル表

**問題**:
既存テストファイル表のテスト対象記述が抽象的。

**推奨対応**:
主要なテストシナリオを列挙するとよい。例:
- supportsImage=trueのツールで画像パス付きsend成功
- supportsImage=falseのツールでフォールバック（パス埋め込み）成功
- 不正なimagePathでのバリデーションエラー
- upload API経由の.commandmate/attachments保存成功

---

### S7-NTH-2: 一時画像のクリーンアップ

**カテゴリ**: 影響ファイル
**場所**: 提案する解決策セクション - フォールバック方式

**問題**:
.commandmate/attachments/に保存された画像が蓄積し続ける問題への対策が含まれていない。

**推奨対応**:
スコープ外としても問題ないが、一時画像の蓄積問題を認識していることを記載しておくと、将来のIssueとして追跡しやすい。session-cleanup.tsやresource-cleanup.tsとの関連も検討の余地がある。

---

## 参照ファイル

### コード
- `src/lib/cli-tools/types.ts`: CLIToolInfo型へのsupportsImage追加が必要
- `src/lib/cli-tools/manager.ts`: getToolInfo()でsupportsImage値を返すロジック追加が必要（変更対象ファイル表に未記載）
- `src/lib/api-client.ts`: uploadFile関数の新設検討
- `src/components/worktree/WorktreeDetailRefactored.tsx`: 既存upload処理パターン（L1784-1813）
- `src/config/uploadable-extensions.ts`: 既存upload APIのバリデーション体系
- `src/config/image-extensions.ts`: 画像添付バリデーション用
- `src/app/api/worktrees/[id]/upload/[...path]/route.ts`: 既存upload API拡張対象

### ドキュメント
- `CLAUDE.md`: 主要モジュール一覧への更新
