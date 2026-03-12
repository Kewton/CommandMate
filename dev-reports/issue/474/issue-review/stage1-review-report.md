# Issue #474 Stage 1 レビューレポート

**レビュー日**: 2026-03-12
**フォーカス**: 通常レビュー（整合性・正確性・完全性）
**ステージ**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 4 |
| Nice to Have | 3 |

Issue #474の記載内容は全体的に明確で、既存コードとの整合性も概ね取れている。ただし、変更対象ファイルリストにgemini.tsが欠落している点、SVGファイルの取り扱い方針が未定義な点、CLIツール固有の画像送信方式の具体性不足、画像ファイルサイズ上限の未記載など、実装時に曖昧さを生む箇所が複数確認された。

---

## Must Fix（必須対応）

### S1-M1: 変更対象ファイルリストにgemini.tsが欠落

**カテゴリ**: 整合性
**場所**: 影響範囲 > 変更対象ファイルテーブル

**問題**:
実装タスクの「対象CLIツール」セクションではClaude, Codex, Gemini, Vibe Local, OpenCodeの5ツール全てが列挙されているが、影響範囲の変更対象ファイルテーブルにはsrc/lib/cli-tools/gemini.tsが記載されていない。同様にopencode.tsとvibe-local.tsも未記載である。

**証拠**:
- 実装タスク: 「各CLIツール（Claude, Codex, Gemini, Vibe Local, OpenCode）の画像送信方式調査」
- 変更対象テーブル: claude.ts, codex.ts, base.tsのみ記載。gemini.ts, opencode.ts, vibe-local.tsが欠落
- 実在ファイル: `src/lib/cli-tools/gemini.ts`, `src/lib/cli-tools/opencode.ts`, `src/lib/cli-tools/vibe-local.ts` が確認済み

**推奨対応**:
影響範囲の変更対象ファイルテーブルに以下を追加する:
- `src/lib/cli-tools/gemini.ts | Gemini CLIの画像送信実装`
- `src/lib/cli-tools/opencode.ts | OpenCode CLIの画像送信実装`
- `src/lib/cli-tools/vibe-local.ts | Vibe Local CLIの画像送信実装`

---

### S1-M2: SVGファイルの画像添付方針が未定義

**カテゴリ**: 完全性
**場所**: 受入条件 > 対応画像形式

**問題**:
既存の`src/config/image-extensions.ts`のIMAGE_EXTENSIONS配列にはSVG（'.svg'）が含まれ、XSS対策として`validateSvgContent()`が実装されている。しかし、Issueの受入条件では対応画像形式として「png, jpg, jpeg, gif, webp」のみ列挙されており、SVGが含まれていない。「既存のimage-extensions.tsを再利用」と記載している以上、SVGの方針を明確にしないと実装時に判断が分かれる。

**証拠**:
- `src/config/image-extensions.ts` L19-26: IMAGE_EXTENSIONS に '.svg' が含まれる
- `src/config/image-extensions.ts` L211-244: validateSvgContent() でXSS対策実装済み
- Issue受入条件: 「対応画像形式（png, jpg, jpeg, gif, webp）」にSVGなし

**推奨対応**:
受入条件にSVGの方針を追記する。選択肢:
- (a) CLIツールへの画像添付ではSVGを対象外とし、明示的に除外する旨を記載
- (b) SVGも対応する場合、既存のvalidateSvgContent()によるXSSバリデーションを必須とする受入条件を追加

---

## Should Fix（推奨対応）

### S1-S1: CLIツール固有の画像送信方式に関する具体性不足

**カテゴリ**: 明確性
**場所**: 提案する解決策 > 実装方針

**問題**:
「CLIツールが画像送信用のフラグやAPIを提供している場合、それを使用」と記載しているが、各CLIツールの具体的な画像送信方式が一切記載されていない。実装タスクに「各CLIツールの画像送信方式調査」があるが、調査と実装の順序関係が不明確。

**推奨対応**:
実装タスクの「各CLIツールの画像送信方式調査」を最初のブロッキングタスクとして位置づけ、調査結果をIssueに追記してからインターフェース設計に進むフローを明記する。

---

### S1-S2: 画像ファイルサイズ上限の受入条件への未記載

**カテゴリ**: 完全性
**場所**: 受入条件

**問題**:
既存の`src/config/image-extensions.ts`にはIMAGE_MAX_SIZE_BYTES = 5MB（5 * 1024 * 1024）の定数が定義されているが、Issueの受入条件にファイルサイズ制限に関する記載がない。

**証拠**:
- `src/config/image-extensions.ts` L32: `export const IMAGE_MAX_SIZE_BYTES = 5 * 1024 * 1024;`

**推奨対応**:
受入条件に「画像ファイルサイズの上限が設定されており、上限超過時に適切なエラーメッセージが表示されること」を追加する。

---

### S1-S3: ICLIToolインターフェース拡張の後方互換性への言及不足

**カテゴリ**: 技術的妥当性
**場所**: 実装タスク > ICLIToolインターフェース拡張

**問題**:
ICLIToolインターフェースに新メソッドを追加すると、5つの全実装クラス（ClaudeTool, CodexTool, GeminiTool, VibeLocalTool, OpenCodeTool）が影響を受ける。拡張方針が未記載。

**証拠**:
- `src/lib/cli-tools/types.ts` L21-76: ICLIToolインターフェース定義
- `src/lib/cli-tools/base.ts`: BaseCLITool抽象クラス

**推奨対応**:
BaseCLIToolにデフォルト実装（supportsImage() = false、sendMessageWithImageのフォールバック）を設け、各サブクラスでオーバーライドする方式を推奨。これにより既存ツールの破壊的変更を防げる。

---

### S1-S4: フォールバック方式の画像保存先パスが未定義

**カテゴリ**: 明確性
**場所**: 提案する解決策 > 実装方針 > フォールバック

**問題**:
「画像をworktree内にアップロードし、そのファイルパスをメッセージに含めて送信」と記載があるが、具体的な保存先ディレクトリが未定義。ユーザーのソースコードと混在する場所に配置すると、gitの管理対象になるリスクがある。

**推奨対応**:
画像の保存先ディレクトリを明記する（例: `.commandmate/images/`）。.gitignoreへの追記要否も検討事項として記載する。

---

## Nice to Have（あれば良い）

### S1-N1: ドラッグ&ドロップ/クリップボード貼り付けへの言及

**カテゴリ**: 完全性

Issueでは画像添付ボタンによるファイル選択のみ記載。ドラッグ&ドロップやクリップボード貼り付け（Ctrl+V）がスコープ内外かを明示すると実装範囲が明確になる。

---

### S1-N2: 複数画像の同時添付に関する仕様

**カテゴリ**: 明確性

1回のメッセージで添付できる画像が1枚か複数枚か判断できない。初期実装の上限を明記すると良い。

---

### S1-N3: 画像プレビュー/添付表示UI

**カテゴリ**: 完全性

添付前のプレビューや添付済みファイル名表示、添付解除ボタンなどのUI要件が記載されていない。最低限の表示要件を追加すると良い。

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/lib/cli-tools/types.ts` | ICLIToolインターフェース定義（拡張対象） |
| `src/lib/cli-tools/base.ts` | BaseCLITool抽象クラス（フォールバック実装先） |
| `src/lib/cli-tools/claude.ts` | Claude CLI実装（変更対象） |
| `src/lib/cli-tools/codex.ts` | Codex CLI実装（変更対象） |
| `src/lib/cli-tools/gemini.ts` | Gemini CLI実装（変更対象として欠落） |
| `src/lib/cli-tools/opencode.ts` | OpenCode CLI実装（変更対象として欠落） |
| `src/lib/cli-tools/vibe-local.ts` | Vibe Local CLI実装（変更対象として欠落） |
| `src/config/image-extensions.ts` | 画像バリデーション（再利用対象） |
| `src/components/worktree/MessageInput.tsx` | メッセージ入力UI（変更対象） |
| `src/lib/api-client.ts` | APIクライアント（sendMessage拡張対象） |
| `src/app/api/worktrees/[id]/send/route.ts` | メッセージ送信API（変更対象） |
| `src/app/api/worktrees/[id]/upload/[...path]/route.ts` | 既存アップロードAPI（参考） |
