# Issue #474 影響範囲レビューレポート

**レビュー日**: 2026-03-12
**フォーカス**: 影響範囲レビュー
**ステージ**: 3（影響範囲レビュー 1回目）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 5 |
| Nice to Have | 3 |

Issue内の影響範囲記載は主要な変更対象ファイルを概ね網羅しているが、実装に進む前に解決すべき重要な漏れがある。特にfetchApiのContent-Type固定問題、send/route.tsの呼び出しロジック変更、セキュリティ防御の適用について明確化が必要。

---

## Must Fix（必須対応）

### MF-1: fetchApiのContent-Type固定がmultipart/form-data送信を阻害

**カテゴリ**: 影響ファイル
**場所**: src/lib/api-client.ts: fetchApi関数（L46-47）、worktreeApi.sendMessage（L185-194）

**問題**:
`fetchApi`関数は全リクエストに`Content-Type: application/json`を強制設定している。画像ファイルをmultipart/form-dataで送信する場合、この関数をそのまま使用できない。影響範囲表にapi-client.tsの記載はあるが、この根本的な設計制約について言及がない。

**証拠**:
```typescript
// api-client.ts L46-47
const headers = new Headers(options?.headers);
headers.set('Content-Type', 'application/json');
```
`sendMessage`関数は`JSON.stringify(body)`でbodyを送信しており、バイナリファイルの直接送信に対応していない。

**推奨対応**:
2つの方式を検討し、Issueに設計判断を明記すべき:
1. **2段階方式**: 既存upload API（`/api/worktrees/[id]/upload/`）で画像をアップロードし、返却されたパスをsend APIのJSONボディに含める。fetchApiの変更不要だが2回のAPIコールが発生する
2. **send API拡張方式**: send APIをmultipart対応にする。fetchApiの修正またはバイパスが必要

---

### MF-2: send/route.tsの呼び出しロジック変更が影響範囲表に不足

**カテゴリ**: 影響ファイル
**場所**: src/lib/cli-tools/manager.ts、src/app/api/worktrees/[id]/send/route.ts

**問題**:
send/route.tsは`cliTool.sendMessage(params.id, body.content)`（L161）を直接呼び出している。画像添付時に`sendMessageWithImage`を呼び分けるロジック、`SendMessageRequest`型へのimagePath等のフィールド追加、画像パスのバリデーションロジックが必要。これらの変更がIssueの影響範囲表に記載されていない。

**証拠**:
```typescript
// send/route.ts L31-34
interface SendMessageRequest {
  content: string;
  cliToolId?: CLIToolType;  // Optional: override the worktree's default CLI tool
}

// send/route.ts L161
await cliTool.sendMessage(params.id, body.content);
```

**推奨対応**:
send/route.tsの変更内容を影響範囲表に具体的に記載すべき: (1) SendMessageRequest型へのimagePath追加、(2) supportsImage判定ロジック、(3) sendMessage/sendMessageWithImageの呼び分け。

---

### MF-3: 画像アップロード先のセキュリティ防御適用が未記載

**カテゴリ**: セキュリティ
**場所**: 提案する解決策セクション - フォールバック方式

**問題**:
`.commandmate/attachments/`への画像保存について、パストラバーサル防御（`isPathSafe`）とシンボリックリンク検証（`resolveAndValidateRealPath`）の適用が影響範囲に記載されていない。

**証拠**:
既存upload API（`src/app/api/worktrees/[id]/upload/[...path]/route.ts`）はL117でisPathSafe()、L122でresolveAndValidateRealPath()を使用している。新規の画像アップロードAPIにも同等の防御が必要。

**推奨対応**:
- `src/lib/path-validator.ts`の再利用を影響範囲に明記
- `.commandmate/attachments/`ディレクトリの自動作成ロジックとパーミッション設定を影響範囲に含める
- アップロード先パスの制約（worktreeルート配下固定）を明記

---

## Should Fix（推奨対応）

### SF-1: 影響を受ける既存テストファイルが影響範囲に未記載

**カテゴリ**: テスト範囲
**場所**: 影響範囲セクション

**問題**:
以下のテストファイルがインターフェース変更やコンポーネント変更に伴い修正が必要になるが、影響範囲に記載されていない。

**影響テストファイル一覧**:
| テストファイル | 影響理由 |
|-------------|---------|
| tests/unit/components/worktree/MessageInput.test.tsx | 画像添付ボタンのテスト追加 |
| tests/unit/cli-tools/base.test.ts | BaseCLIToolデフォルト画像メソッドテスト |
| tests/unit/lib/cli-tools/types.test.ts | supportsImageプロパティテスト |
| tests/integration/api-send-cli-tool.test.ts | 画像パス付きsendテスト、モッククラス更新 |
| tests/helpers/message-input-test-utils.ts | 新props対応ヘルパー更新 |
| tests/unit/config/image-extensions.test.ts | 既存テストとの整合性確認 |

---

### SF-2: cli-tools/index.tsのエクスポート更新の可能性

**カテゴリ**: 影響ファイル
**場所**: src/lib/cli-tools/index.ts

**問題**:
types.tsへの型追加はindex.tsのexport typeで自動的に含まれるが、base.tsへの新メソッド追加や画像送信用ユーティリティ追加時にはindex.tsの更新が必要。影響範囲表に含めるべき。

---

### SF-3: .commandmate/attachmentsディレクトリの.gitignore管理が未設計

**カテゴリ**: 影響ファイル
**場所**: 提案する解決策セクション

**問題**:
プロジェクトの.gitignoreに`.commandmate/`の記載はない。worktree内にattachmentsディレクトリを作成する場合、各worktreeの.gitignoreに自動追記する仕組みか、ユーザーへの手動追加指示が必要。

**推奨対応**:
- `.gitignore`自動追記ロジックの追加を影響範囲に含める
- または、各worktreeセットアップ時に`.commandmate/`がignore対象になるよう設計する

---

### SF-4: WorktreeDetailRefactored.tsxが変更対象ファイル表に未記載

**カテゴリ**: 影響ファイル
**場所**: 影響範囲セクション - 変更対象ファイル表

**問題**:
MessageInputのpropsに画像関連のstateやcallbackが追加される場合、WorktreeDetailRefactored.tsxからの呼び出し箇所（2箇所: L2335, L2596付近）の修正が必要。「関連コンポーネント」としての記載はあるが、変更対象ファイル表にも含めるべき。

---

### SF-5: image-extensions.tsのSVG含有とIssue受入条件の齟齬

**カテゴリ**: 破壊的変更
**場所**: 受入条件セクション、src/config/image-extensions.ts

**問題**:
`IMAGE_EXTENSIONS`にはSVGが含まれているが、受入条件では「SVGはXSSリスクがあるため添付対象外」としている。IMAGE_EXTENSIONSをそのまま再利用するのではなく、SVG除外のフィルタリングまたは`ATTACHABLE_IMAGE_EXTENSIONS`のような新定数が必要。

**証拠**:
```typescript
// image-extensions.ts L19-26
export const IMAGE_EXTENSIONS: readonly string[] = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg',
] as const;
```

**推奨対応**:
image-extensions.tsに添付用の定数を追加するか、バリデーション側でSVGを除外するロジックを追加する。いずれの方式を取るか影響範囲に明記すべき。

---

## Nice to Have（あれば良い）

### NTH-1: CLAUDE.mdモジュール一覧への追記

新規APIエンドポイントやユーティリティをCLAUDE.mdの主要モジュール一覧とdocs/implementation-history.mdに追記すると、今後のメンテナンス性が向上する。

### NTH-2: 同時添付画像数の制限明記

画像ファイルサイズ上限（5MB）は記載があるが、同時に添付可能な画像数の制限（例: 1枚のみ）が明記されていない。設計の曖昧さを減らすため、明示的な制限の記載が望ましい。

### NTH-3: 画像プレビューUIの実装タスク化

画像添付後のプレビュー表示UIが実装タスクに含まれていない。UXとして添付確認UIがあることが望ましいため、タスクへの追記を推奨。

---

## 影響ファイル完全一覧

### Issueに記載済みのファイル

| ファイル | 記載内容 | 追加コメント |
|---------|----------|------------|
| src/components/worktree/MessageInput.tsx | 画像添付ボタン・状態管理追加 | OK |
| src/lib/cli-tools/types.ts | ICLIToolインターフェース拡張 | OK |
| src/lib/cli-tools/claude.ts | 画像送信実装 | OK |
| src/lib/cli-tools/codex.ts | 画像送信実装 | OK |
| src/lib/cli-tools/gemini.ts | 画像送信方式調査・対応 | OK |
| src/lib/cli-tools/opencode.ts | 画像送信方式調査・対応 | OK |
| src/lib/cli-tools/vibe-local.ts | 画像送信方式調査・対応 | OK |
| src/lib/cli-tools/base.ts | ベースクラスフォールバック | OK |
| src/app/api/worktrees/[id]/send/route.ts | 画像パスパラメータ対応 | 詳細不足（MF-2） |
| src/lib/api-client.ts | sendMessageに画像パラメータ追加 | 設計制約未記載（MF-1） |
| src/config/image-extensions.ts | 既存設定再利用 | SVG齟齬あり（SF-5） |

### Issueに未記載だが影響を受けるファイル

| ファイル | 影響理由 |
|---------|---------|
| src/lib/cli-tools/index.ts | エクスポート更新の可能性（SF-2） |
| src/lib/cli-tools/manager.ts | getTool()戻り値型の伝播、ヘルパー追加の可能性 |
| src/lib/path-validator.ts | 画像アップロードのセキュリティ防御で再利用（MF-3） |
| src/components/worktree/WorktreeDetailRefactored.tsx | MessageInput親、2箇所の修正（SF-4） |
| tests/unit/components/worktree/MessageInput.test.tsx | テスト追加・修正（SF-1） |
| tests/unit/cli-tools/base.test.ts | テスト追加（SF-1） |
| tests/unit/lib/cli-tools/types.test.ts | テスト追加（SF-1） |
| tests/integration/api-send-cli-tool.test.ts | テスト追加・モック更新（SF-1） |
| tests/helpers/message-input-test-utils.ts | ヘルパー更新（SF-1） |
| .gitignore（各worktree内） | .commandmate/attachments管理（SF-3） |
| CLAUDE.md | モジュール一覧更新（NTH-1） |

---

## 参照ファイル

### コード
- `src/lib/api-client.ts`: fetchApiのContent-Type固定制約（L46-47）
- `src/app/api/worktrees/[id]/send/route.ts`: メッセージ送信API（SendMessageRequest型、cliTool.sendMessage呼び出し）
- `src/app/api/worktrees/[id]/upload/[...path]/route.ts`: 既存アップロードAPIのセキュリティパターン参考
- `src/lib/cli-tools/types.ts`: ICLIToolインターフェース定義
- `src/lib/cli-tools/base.ts`: BaseCLITool抽象クラス
- `src/config/image-extensions.ts`: IMAGE_EXTENSIONS定数（SVG含む）

### ドキュメント
- `CLAUDE.md`: プロジェクトガイドライン・モジュール一覧
- `.gitignore`: プロジェクトルートのgitignore設定
