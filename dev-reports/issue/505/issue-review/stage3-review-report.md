# Issue #505 レビューレポート - Stage 3

**レビュー日**: 2026-03-16
**フォーカス**: 影響範囲レビュー（1回目）
**ステージ**: 3（Stage 1 通常レビュー + Stage 2 反映済み後の影響範囲分析）

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 3 |
| Should Fix | 6 |
| Nice to Have | 3 |
| **合計** | **12** |

Issue のコールバック伝播経路は正しく設計されているが、影響範囲の変更対象ファイル表に記載漏れがある。特に中間伝播層（FilePanelSplit, FilePanelTabs, FilePanelContent 内のサブコンポーネント）と型定義ファイル（EditorProps）への変更が不足している。セキュリティ面では postMessage のメッセージスキーマ定義の具体化と、iframe srcDoc へのスクリプト注入の実装詳細が必要。

---

## Must Fix（必須対応）

### F3-001: FilePanelSplit.tsx の onOpenFile props 伝播が影響範囲に未記載

**カテゴリ**: 影響ファイル漏れ

**問題**:
Issue のコールバック伝播経路図に FilePanelSplit.tsx が記載されているが、影響範囲の変更対象ファイル表には含まれていない。実際のコードを確認すると、`FilePanelSplitProps` インターフェースに `onOpenFile` は存在せず、FilePanelSplit は FilePanelTabs に props を中継する役割を持つ。

**証拠**:
- `src/components/worktree/FilePanelSplit.tsx` の `FilePanelSplitProps` には onOpenFile が未定義
- 伝播経路図: `WorktreeDetailRefactored -> FilePanelSplit -> FilePanelContent -> MarkdownEditor -> MarkdownPreview`

**推奨対応**:
変更対象ファイル表に `src/components/worktree/FilePanelSplit.tsx` を追加し、「onOpenFile コールバック props 追加・FilePanelTabs への伝播」と記載する。

---

### F3-002: FilePanelTabs.tsx の FilePanelTabsProps に onOpenFile 伝播が必要だが未記載

**カテゴリ**: 影響ファイル漏れ

**問題**:
FilePanelTabs.tsx の影響範囲は「ドロップダウンUI追加、タブ移動ロジック」のみ記載。しかし FilePanelTabs が FilePanelContent を描画する際に onOpenFile を伝播する必要がある。

**証拠**:
- `FilePanelTabsProps` インターフェースに onOpenFile が未定義（行23-44）
- FilePanelContent の描画箇所（行150-159）で props を渡している

**推奨対応**:
FilePanelTabs.tsx の変更内容に「onOpenFile コールバック props 追加・FilePanelContent への伝播」を追記する。

---

### F3-003: EditorProps（src/types/markdown-editor.ts）への変更が影響範囲に未記載

**カテゴリ**: 影響ファイル漏れ

**問題**:
MarkdownEditor の props 型は `src/types/markdown-editor.ts` の `EditorProps` で定義されている。onOpenFile を MarkdownEditor に追加するには、この型定義ファイルを変更する必要がある。また `FilePanelContentProps` にも onOpenFile を追加する必要がある。

**証拠**:
- `EditorProps`（markdown-editor.ts:75-90）に onOpenFile が未定義
- `FilePanelContentProps`（FilePanelContent.tsx:65-80）にも onOpenFile が未定義

**推奨対応**:
影響範囲に `src/types/markdown-editor.ts` を追加し、「EditorProps に onOpenFile?: (path: string) => void 追加」と記載する。

---

## Should Fix（推奨対応）

### F3-004: ユニットテストの具体的なテスト対象が列挙されていない

**カテゴリ**: テスト範囲

Issue の実装タスクに「ユニットテスト追加」とあるが具体性が不足。

**推奨対応**:
以下のテストケースを明記する:
1. `MOVE_TO_FRONT` reducer アクションの正常系・異常系テスト
2. ドロップダウン選択時の先頭移動テスト
3. rehype-sanitize カスタムスキーマが相対パス href を保持するテスト
4. 相対パス解決・パストラバーサル防止のクライアントサイドテスト
5. postMessage origin 検証・スキーマ検証テスト

---

### F3-005: FilePanelTabs.test.tsx がドロップダウン UI の新規描画をカバーしていない

**カテゴリ**: テスト範囲

既存テスト（tests/unit/components/FilePanelTabs.test.tsx）は全タブを横並び表示する前提のみ。

**推奨対応**:
テスト計画に以下を含める:
- タブ5個以下ではドロップダウン非表示
- タブ6個以上でドロップダウン表示
- ドロップダウンからの選択で onActivate（または MOVE_TO_FRONT dispatch）呼び出し
- アクティブタブが6番目以降でもタブバーに表示

---

### F3-006: postMessage メッセージスキーマの具体的な型定義が不足

**カテゴリ**: セキュリティ

sandbox iframe からの postMessage は origin が文字列 `'null'` となり、他の sandbox iframe と区別できない。メッセージスキーマの具体的な形式が定義されていない。

**推奨対応**:
メッセージスキーマを具体的に定義する。例:
```typescript
interface LinkClickMessage {
  type: 'commandmate:link-click';
  href: string;
}
```
namespace prefix（`commandmate:`）を付与して偽メッセージを区別する。

---

### F3-007: MAX_FILE_TABS 変更の localStorage への影響

**カテゴリ**: 破壊的変更

RESTORE アクションは `action.paths.slice(0, MAX_FILE_TABS)` で制限している。5から30への変更自体は後方互換性を壊さないが、localStorage に最大30パスが保存されることでストレージ使用量が増加する。

**推奨対応**:
現在の設計（RESTORE 時に MAX_FILE_TABS でスライス）で十分であることを確認し、問題なしとする旨を Issue に明記する。

---

### F3-008: MarkdownWithSearch / MarpEditorWithSlides への onOpenFile 伝播

**カテゴリ**: 依存関係

FilePanelContent.tsx 内の `MarkdownWithSearch` と `MarpEditorWithSlides` サブコンポーネントも MarkdownEditor を描画しているため、onOpenFile を伝播する変更が必要。

**推奨対応**:
FilePanelContent.tsx の影響範囲に MarkdownWithSearch、MarpEditorWithSlides サブコンポーネントへの props 追加を明記する。

---

### F3-009: HtmlIframePreview の srcDoc へのスクリプト注入実装詳細が不足

**カテゴリ**: 影響ファイル漏れ

iframe 内からリンククリックを検知するには、srcDoc の HTML にリンククリックハンドラスクリプトを注入する必要がある。現在の HtmlIframePreview は `srcDoc={htmlContent}` をそのまま渡している。

**推奨対応**:
実装タスクに以下を追加:
- interactive モード時に srcDoc HTML へリンククリック検知スクリプトを注入
- `document.addEventListener('click')` で a タグクリックを検知
- `e.preventDefault()` + `parent.postMessage()` で親に通知

---

## Nice to Have（あれば良い）

### F3-010: Toast メッセージの i18n 対応

既存コードのパターンに合わせて英語ハードコードで問題ない。将来の i18n Issue で一括対応推奨。

### F3-011: postMessage イベントリスナーのライフサイクル管理

複数の HtmlPreview タブが同時に開かれた場合のリスナー重複に注意。useEffect クリーンアップと event.source による iframe 識別を推奨。

### F3-012: モバイルビューでのリンククリック動作が未定義

デスクトップのみをスコープとするなら明示する。モバイルでは `mobileFileViewerPath` を使用する別の経路が必要。

---

## 影響範囲サマリー

### Issue に記載済みの変更対象ファイル（8ファイル）

| ファイル | 記載の変更内容 | 追加で必要な変更 |
|---------|---------------|----------------|
| `src/hooks/useFileTabs.ts` | MAX_FILE_TABS 変更、MOVE_TO_FRONT 追加 | - |
| `src/components/worktree/FilePanelTabs.tsx` | ドロップダウン UI | **onOpenFile props 伝播追加** |
| `src/components/worktree/MarkdownPreview.tsx` | a タグカスタム、rehype-sanitize 調整 | - |
| `src/components/worktree/MarkdownEditor.tsx` | onOpenFile props 追加 | - |
| `src/components/worktree/HtmlPreview.tsx` | postMessage 監視 | **srcDoc スクリプト注入の詳細** |
| `src/components/worktree/FilePanelContent.tsx` | コールバック連携 | **サブコンポーネントへの伝播** |
| `src/components/worktree/WorktreeDetailRefactored.tsx` | onOpenFile 起点、Toast 更新 | - |
| `src/config/html-extensions.ts` | sandbox 属性検討 | - |

### Issue に未記載だが変更が必要なファイル（2ファイル）

| ファイル | 必要な変更 |
|---------|----------|
| `src/components/worktree/FilePanelSplit.tsx` | `onOpenFile` props 追加・FilePanelTabs への伝播 |
| `src/types/markdown-editor.ts` | `EditorProps` に `onOpenFile` 追加 |

### テスト影響

| テストファイル | 影響 |
|--------------|------|
| `tests/unit/hooks/useFileTabs.test.ts` | MOVE_TO_FRONT テスト追加必要 |
| `tests/unit/components/FilePanelTabs.test.tsx` | ドロップダウン UI テスト追加必要 |
| (新規) | rehype-sanitize スキーマ、postMessage 検証、パストラバーサル防止のテスト |
