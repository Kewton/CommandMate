# Issue #288 レビューレポート

**レビュー日**: 2026-02-17
**フォーカス**: 通常レビュー（Consistency & Correctness）
**イテレーション**: 1回目
**仮説検証結果**: 全3仮説 Confirmed

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 0 |
| Should Fix | 3 |
| Nice to Have | 3 |

Issue #288 の技術的な根本原因分析は正確であり、コードベースとの整合性も高い。仮説検証レポートで全3仮説が Confirmed されている通り、行番号・コード内容・動作フローの記述はすべて実際のコードと一致している。ただし、Issueタイトルと本文の不一致、対策案の一部詳細不足、根本原因説明の補足が推奨される。

---

## Must Fix（必須対応）

なし。

技術的に誤った記載や重大な矛盾は検出されなかった。

---

## Should Fix（推奨対応）

### SF-1: Issueタイトルと本文内容の不一致

**カテゴリ**: 明確性
**場所**: Issueタイトル

**問題**:
Issueタイトルは「Codexにてカスタムモデルが利用出来ない」だが、本文の内容は以下の点でタイトルと乖離がある:

1. **影響範囲**: 本文に「CodexとClaude Codeの両方で発生する」と明記されており、Codex限定の問題ではない
2. **問題の本質**: `/model` コマンドに限った問題ではなく、「Enter custom command...」経由のすべてのカスタムコマンド入力で発生するセレクター再表示の問題
3. **「カスタムモデル」の曖昧さ**: タイトルだけ読むと「Codexでモデル選択ができない」という別の問題に見える

**推奨対応**:
タイトルを問題の本質に合わせて修正する。例:
- 「Enter custom command選択後、カスタムコマンド入力中にセレクターが再表示されEnterで送信できない」
- 「フリー入力モードでスラッシュコマンドセレクターが再表示される不具合」

---

### SF-2: 対策案のフラグリセット条件の詳細不足

**カテゴリ**: 完全性
**場所**: ## 対策案 セクション

**問題**:
対策案で「フラグはメッセージ送信時またはメッセージがクリアされた時にリセットする」と記載されているが、以下の具体的な実装方針が不明:

1. **handleMessageChange内のロジック**: `isFreeInputMode === true` の場合、セレクター表示をスキップするだけなのか、他にも挙動変更があるのか
2. **「メッセージがクリアされた時」の検出方法**: `handleMessageChange` 内で `newValue === ''` をチェックするのか、`useEffect` で `message` を監視するのか
3. **handleCommandCancel時のリセット**: ユーザーがEscapeキーでセレクターを閉じた場合やセレクター外をクリックした場合、`handleCommandCancel()` が呼ばれるが、この時のフラグ状態が未定義
4. **ユーザーが / を手動で消してから再度 / を入力した場合**: フラグがリセットされセレクターが再表示されるべきか

**推奨対応**:
フラグリセット条件を以下のように明示する:
- `submitMessage()` 実行時 --- 記載済み
- `message` が空文字になった時（`handleMessageChange` 内で `newValue === ''` を検出）
- `handleCommandCancel()` 呼び出し時（Escapeキー、セレクター外クリック）--- 検討要否を明記

---

### SF-3: 根本原因の説明がMessageInput側に限定されている

**カテゴリ**: 技術的妥当性
**場所**: ## 根本原因の仮説 セクション

**問題**:
Issue本文では `MessageInput.tsx` の `handleMessageChange` 内のロジックのみが根本原因として説明されているが、Enterキーが「セレクター操作に消費される」メカニズムには2つのレイヤーが関与している:

1. **MessageInput.tsx L192**: `handleKeyDown` 内で `!showCommandSelector` ガードによりEnter送信がスキップされる
2. **SlashCommandSelector.tsx L112-117 + L124-129**: `document.addEventListener('keydown', handleKeyDown)` によるグローバルイベントリスナーが、`isOpen === true` の時にEnterキーに対して `e.preventDefault()` を実行し、ハイライト中のコマンドを選択する

**証拠**:
```typescript
// SlashCommandSelector.tsx L93-121
const handleKeyDown = useCallback(
  (e: KeyboardEvent) => {
    if (!isOpen) return;
    switch (e.key) {
      case 'Enter':
        e.preventDefault();  // Enterイベントが消費される
        if (flatCommands[highlightedIndex]) {
          handleSelect(flatCommands[highlightedIndex]);
        }
        break;
    }
  },
  [isOpen, flatCommands, highlightedIndex, onClose, handleSelect]
);

// L124-129 グローバルリスナー登録
useEffect(() => {
  document.addEventListener('keydown', handleKeyDown);
  return () => {
    document.removeEventListener('keydown', handleKeyDown);
  };
}, [handleKeyDown]);
```

**推奨対応**:
対策案の `isFreeInputMode` フラグにより `showCommandSelector` が `true` にならなくなることで、SlashCommandSelector の `isOpen` も `false` となりグローバルリスナーも無効化されるため、提案された対策自体は両方のレイヤーを解決する。根本原因の説明に補足を追加するとより完全になる。

---

## Nice to Have（あれば良い）

### NTH-1: 関連Issueへのリンク追加

**カテゴリ**: 完全性
**場所**: Issue本文

**問題**:
フリー入力機能（「Enter custom command...」）を追加した Issue #56 や、Codex CLI対応の Issue #4 への参照リンクがない。コードコメントでは `// Issue #56` や `// Issue #4` と記載されており、経緯把握のためリンクがあると有用。

**推奨対応**:
Issue本文に「関連Issue: #56（フリー入力機能追加）、#4（Codex CLI対応）」を追記する。

---

### NTH-2: 受入条件にテスト追加項目がない

**カテゴリ**: 完全性
**場所**: ## 受入条件 セクション

**問題**:
既存テスト（`tests/unit/components/worktree/MessageInput.test.tsx`）にはフリー入力モードに関するテストケースが存在しない。受入条件にテスト追加の要件が含まれていない。

**推奨対応**:
受入条件に以下を追加することを検討:
- 「`isFreeInputMode` フラグの動作を検証するユニットテストが追加されている」
- 具体的には: フリー入力モード中のセレクター非表示、フラグリセット後のセレクター再表示、submitMessage後のフラグリセット

---

### NTH-3: 受入条件に具体的テストシナリオがない

**カテゴリ**: 明確性
**場所**: ## 受入条件 セクション

**問題**:
受入条件の「Codex・Claude Code両方で正常に動作する」「通常の `/` 入力時のコマンドセレクター表示は従来通り動作する」は方向性として正しいが、具体的な手動テストシナリオが明記されていない。

**推奨対応**:
以下のような具体的シナリオを追記すると検証しやすい:
1. `/model gpt-4o` を入力してEnterで送信できること
2. `/` のみ入力した場合はセレクターが表示されること
3. セレクターからコマンドを選択した場合は従来通り動作すること
4. フリー入力中に全文字を削除して再度 `/` を入力した場合、セレクターが表示されること
5. `/custom` 入力中にスペースを追加（`/custom arg`）した場合、セレクターが閉じること

---

## 整合性チェック結果

### コードベースとの整合性

| チェック項目 | 結果 | 詳細 |
|------------|------|------|
| 行番号の正確性 | OK | L158, L141-148, L76 すべて実際のコードと一致 |
| コードスニペットの正確性 | OK | Issue記載のコードブロックは実際のコードと完全一致 |
| 関数名の正確性 | OK | handleMessageChange, handleFreeInput, submitMessage すべて正確 |
| 影響範囲ファイル一覧 | OK | MessageInput.tsx が主要変更対象、SlashCommandSelector.tsx は変更不要という判断は妥当 |

### ドキュメントとの整合性

| チェック項目 | 結果 | 詳細 |
|------------|------|------|
| CLAUDE.md | OK | MessageInput.tsx は直接記載されていないが、矛盾する記述もない |
| commands-guide.md | OK | カスタムコマンド入力手順の記載（L370-373）と整合 |

### 仮説検証レポートとの整合性

| チェック項目 | 結果 | 詳細 |
|------------|------|------|
| 仮説1: handleMessageChangeロジック | Confirmed | コード完全一致 |
| 仮説2: handleFreeInput後の再表示 | Confirmed | 動作フロー正確 |
| 仮説3: submitMessageでのクリア | Confirmed | L76 setMessage('') 確認 |

---

## 参照ファイル

### コード
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-288/src/components/worktree/MessageInput.tsx`: バグ発生箇所（handleFreeInput L141-148、handleMessageChange L153-163、submitMessage L66-83、handleKeyDown L168-203）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-288/src/components/worktree/SlashCommandSelector.tsx`: 関連コンポーネント（グローバルkeydownリスナー L124-129）
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-288/src/lib/standard-commands.ts`: スラッシュコマンド定義
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-288/tests/unit/components/worktree/MessageInput.test.tsx`: 既存テスト（フリー入力テストなし）

### ドキュメント
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-288/docs/user-guide/commands-guide.md`: コマンド利用ガイド
- `/Users/maenokota/share/work/github_kewton/commandmate-issue-288/CLAUDE.md`: プロジェクトガイドライン
