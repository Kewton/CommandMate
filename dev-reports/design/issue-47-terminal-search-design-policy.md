# Issue #47 ターミナル検索機能 設計方針書

## 概要

TerminalDisplay.tsx に独自の検索バーUIを追加し、ターミナル出力テキストに対してテキスト検索を実装する。

---

## 1. アーキテクチャ設計

### システム構成

```
TerminalDisplay.tsx (既存)
  ├── useTerminalSearch (新規 Hook)
  │     ├── ANSI除去プレーンテキスト生成
  │     ├── 検索ロジック (indexOf, debounce)
  │     └── マッチ位置管理 (currentIndex, matchPositions)
  ├── TerminalSearchBar (新規 UI コンポーネント)
  │     ├── 入力欄
  │     ├── 前/次ボタン
  │     ├── 件数表示 (3/12)
  │     └── 閉じるボタン (Esc)
  └── TerminalHighlight (CSS Custom Highlight API)
        ├── TreeWalker でテキストノード走査
        ├── Range オブジェクト生成
        └── CSS.highlights.set() でハイライト適用
```

### レイヤー構成

| レイヤー | ファイル | 役割 |
|---------|---------|------|
| プレゼンテーション | `src/components/worktree/TerminalDisplay.tsx` | 検索バーUI統合 |
| プレゼンテーション | `src/components/worktree/TerminalSearchBar.tsx` | 検索バーUIコンポーネント |
| ビジネスロジック | `src/hooks/useTerminalSearch.ts` | 検索状態管理・ロジック |
| ユーティリティ | `src/lib/terminal-highlight.ts` | CSS Highlight API ラッパー関数 |

> **[C-SF-001対応]** `src/lib/ansi-stripper.ts` は不要。検索ソースを DOM textContent に変更したため ANSI 除去ライブラリは不要となった。

---

## 2. 技術選定

### 検索ロジック

| 候補 | 採用 | 理由 |
|-----|------|------|
| `String.prototype.indexOf()` | ✅ | 既存の file-search.ts と同様のセキュリティ方針 (SEC-MF-001)。ReDoSリスクなし |
| `RegExp` | ❌ | ReDoS リスクあり |

### ハイライト実装

| 候補 | 採用 | 理由 |
|-----|------|------|
| **CSS Custom Highlight API** (`CSS.highlights`) | ✅ | DOM変更なし、XSSリスクなし、既存のANSIカラー描画を維持 |
| `dangerouslySetInnerHTML` + `<mark>` 注入 | ❌ | XSSリスク、ANSIスパン構造との干渉が複雑 |
| 平文モード再レンダリング | ❌ | ANSIカラー情報が失われる |
| `window.find()` API | ❌ | 非標準、廃止予定 |

**CSS Custom Highlight API ブラウザサポート**: Chrome 105+, Safari 17.2+, Firefox 117+

非サポートブラウザへのフォールバック: **ハイライトなしで件数表示のみ提供**（スクロールは未実装。CSS Highlight API非サポート環境はCommandMateの利用対象外と判断）。`CSS.highlights` の存在確認で分岐。

### ANSI除去

| 候補 | 採用 | 理由 |
|-----|------|------|
| 正規表現による除去 | ✅ | 軽量。`ansi-to-html` の依存を追加せずに済む |
| `ansi-to-html` + DOMParser | ❌ | オーバーヘッドあり |

ANSI除去正規表現:
```typescript
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[mGKHFABCDJlh]/g;
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}
```

---

## 3. 設計パターン

### カスタムフック パターン

検索ロジックを `useTerminalSearch` に分離し、TerminalDisplay.tsx の責務を明確化。

```typescript
// src/hooks/useTerminalSearch.ts
export interface UseTerminalSearchOptions {
  /** ターミナル出力（ANSI含む生テキスト）- DOM更新検知に使用 */
  output: string;
  /**
   * ターミナルコンテナ要素のRef
   * [C-MF-001対応] DOM textContent を検索ソースとするため必要
   * useTerminalScroll の scrollRef と同一 ref を共用すること
   */
  containerRef: React.RefObject<HTMLElement>;
}

export interface UseTerminalSearchReturn {
  /** 検索クエリ */
  query: string;
  /** クエリ設定（debounce付き） */
  setQuery: (q: string) => void;
  /** 検索バーの表示状態 */
  isOpen: boolean;
  /** 検索バーを開く */
  openSearch: () => void;
  /** 検索バーを閉じる */
  closeSearch: () => void;
  /** マッチ総数 */
  matchCount: number;
  /** 現在のマッチインデックス（1-based） */
  currentMatchIndex: number;
  /** 次のマッチへ */
  nextMatch: () => void;
  /** 前のマッチへ */
  prevMatch: () => void;
  /** マッチ位置配列（container.textContent 基準） */
  matchPositions: Array<{ start: number; end: number }>;
}
```

> **設計ノート（C-SF-002対応）**: `containerRef` は `useTerminalScroll` の `scrollRef`（ターミナルコンテンツ全体のdiv）を共用する。同一DOM要素を指すためテキストノード走査の対象として適切。

### ハイライト適用関数（シンプル関数として実装）

CSS Highlight API の複雑性を隠蔽するユーティリティ関数。クラス/オブジェクトではなくシンプルな関数として実装（YAGNI/KISS準拠）。

```typescript
// src/lib/terminal-highlight.ts

/** CSS Custom Highlight API のサポート確認 */
export function isCSSHighlightSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS;
}

/**
 * コンテナ要素内のマッチ位置にハイライト適用
 * [注意] 検索位置は container.textContent 基準（DOM textContent = 検索ソース）
 */
export function applyTerminalHighlights(
  container: HTMLElement,
  matchPositions: Array<{ start: number; end: number }>,
  currentIndex: number
): void { /* ... */ }

/** ハイライトをすべてクリア */
export function clearTerminalHighlights(): void {
  CSS.highlights.delete('terminal-search');
  CSS.highlights.delete('terminal-search-current');
}
```

---

## 4. コンポーネント設計

### TerminalSearchBar

```typescript
// src/components/worktree/TerminalSearchBar.tsx
export interface TerminalSearchBarProps {
  query: string;
  matchCount: number;
  currentMatchIndex: number;
  onQueryChange: (q: string) => void;
  onNext: () => void;
  onPrev: () => void;
  onClose: () => void;
  /** 入力欄フォーカス制御用 ref */
  inputRef?: React.RefObject<HTMLInputElement>;
}
```

**UI仕様**:
```
┌─────────────────────────────────────────────┐
│ 🔍 [検索クエリ入力欄............] 3/12 ↑ ↓ ✕ │
└─────────────────────────────────────────────┘
```

- ターミナル上部に重ねて表示（`absolute` または `sticky`）
- 背景: `bg-gray-800/95` (半透明でターミナル内容が見える)
- Escキーで閉じる（keydown イベント）

### TerminalDisplay 変更点

```typescript
// 追加するprops（既存APIを破壊しない）
export interface TerminalDisplayProps {
  // ... 既存props ...
  /** 検索バーをCtrl+F以外で開くボタン（モバイル用）を有効化 */
  showSearchButton?: boolean;
}
```

---

## 5. ハイライト実装詳細（CSS Custom Highlight API）

### 検索ソースの統一（D-MF-001対応）

**重要設計決定**: 検索はプレーンテキスト（ANSI除去）ではなく **`container.textContent`** を対象とする。

理由: `sanitizeTerminalOutput()` による ANSI→HTML変換後、DOMのテキストノードには HTML エンティティデコード済みの文字列が格納される。`stripAnsi(output)` の結果と DOM textContent が一致しない可能性があるため、DOM textContent を検索ソースとして使用することで整合性を保証する。

```typescript
// アルゴリズム
function applyTerminalHighlights(container, matchPositions, currentIndex) {
  if (!isCSSHighlightSupported()) return; // フォールバック: 件数表示のみ

  // 1. テキストノードをTreeWalkerで走査（DOMのテキスト構造を把握）
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode as Text);
  }

  // 2. 各テキストノードの累積オフセットを計算
  // （container.textContent = テキストノード連結 = 検索ソース）
  const nodeOffsets: number[] = [];
  let cumOffset = 0;
  for (const node of textNodes) {
    nodeOffsets.push(cumOffset);
    cumOffset += node.textContent?.length ?? 0;
  }

  // 3. matchPositions を DOM Range に変換
  const ranges = matchPositions.map(({ start, end }) => {
    const range = new Range();
    // startノードとオフセットを特定
    setRangeBoundary(range, 'start', textNodes, nodeOffsets, start);
    setRangeBoundary(range, 'end', textNodes, nodeOffsets, end);
    return range;
  });

  // 4. CSS Highlight API でハイライト適用
  CSS.highlights.set('terminal-search', new Highlight(...ranges));

  // 5. 現在マッチは別 Highlight で強調表示
  if (ranges[currentIndex]) {
    CSS.highlights.set('terminal-search-current', new Highlight(ranges[currentIndex]));
  }
}

// 検索実行時も container.textContent を使用
function findMatches(container: HTMLElement, query: string): Array<{ start: number; end: number }> {
  const text = container.textContent ?? '';
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matches: Array<{ start: number; end: number }> = [];
  let pos = 0;
  while (matches.length < TERMINAL_SEARCH_MAX_MATCHES) {
    const idx = lowerText.indexOf(lowerQuery, pos);
    if (idx === -1) break;
    matches.push({ start: idx, end: idx + query.length });
    pos = idx + 1;
  }
  return matches;
}
```

**CSS定義（globals.css に追加）**:
```css
::highlight(terminal-search) {
  background-color: rgba(255, 255, 0, 0.4);
  color: inherit;
}

::highlight(terminal-search-current) {
  background-color: rgba(255, 165, 0, 0.8);
  color: black;
}
```

---

## 6. セキュリティ設計

| リスク | 対策 |
|-------|------|
| XSS（検索クエリ埋め込み） | CSS Highlight APIはDOMを変更しない。検索クエリはstring.includes()比較のみに使用 |
| ReDoS | 検索にRegExpを使用しない（indexOf/includesのみ） |
| 大量データ DoS | 検索結果は最大500件に制限。クエリ最小文字数2文字以上を強制し、短クエリによる大量マッチを防止 |
| ANSI injection | container.textContentを検索ソースとするためANSIコードは既にHTMLに変換済み |

**セキュリティ注釈コード**:
```typescript
// [SEC-TS-001] Search uses indexOf only - no RegExp (ReDoS prevention)
// [SEC-TS-002] CSS Highlight API used for XSS-safe highlighting
// [SEC-TS-003] container.textContent used as search source (no ANSI injection risk)
// [SEC-TS-004] Minimum query length: 2 characters (DoS prevention)
```

---

## 7. パフォーマンス設計

### デバウンス

```typescript
const TERMINAL_SEARCH_DEBOUNCE_MS = 300; // ファイル検索と統一
```

### 結果件数上限

```typescript
export const TERMINAL_SEARCH_MAX_MATCHES = 500;
// ファイル内容検索(SEARCH_MAX_RESULTS=100)より高い理由:
// ターミナル検索はメモリ上のテキスト操作でAPIタイムアウトリスクがない。
// 500件程度はブラウザのRange生成パフォーマンス上も問題ない範囲。
```

大量マッチ時は「500件以上（上限）」と表示。

### メモ化

```typescript
// matchPositions は containerRef と debouncedQuery が変わった時に再計算（useEffect）
// 注意: container.textContent を検索ソースとするため、DOM更新後に実行する必要がある
useEffect(() => {
  if (!containerRef.current || !debouncedQuery) {
    setMatchPositions([]);
    return;
  }
  const positions = findMatches(containerRef.current, debouncedQuery);
  setMatchPositions(positions);
}, [containerRef, debouncedQuery, output]); // output変化でDOM更新後に再実行
```

---

## 8. キーボードショートカット設計

### Ctrl+F / Cmd+F イベントハンドリング

```typescript
// TerminalDisplay.tsx内で、ターミナルコンテナにonKeyDownを設定
const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
  // Ctrl+F or Cmd+F: 検索バーを開く
  if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
    e.preventDefault(); // ブラウザのページ内検索を抑制
    e.stopPropagation();
    openSearch();
    return;
  }
}, [openSearch]);
```

**注意**: `tabIndex={0}` をターミナルコンテナに設定し、フォーカス可能にする必要がある。

> **[I-SF-001対応]** tabIndex追加により `tests/unit/components/TerminalDisplay.test.tsx` のfocusアサーションに影響が出る可能性がある。既存テストを確認・更新すること。

### Esc キー

検索バーコンポーネント内で `keydown` イベントをリッスン:
```typescript
if (e.key === 'Escape') {
  e.preventDefault();
  closeSearch();
  // フォーカスをターミナルコンテナに戻す
  terminalContainerRef.current?.focus();
}
```

---

## 9. モバイル対応設計

TerminalDisplay.tsx の `scrollRef` コンテナ内に検索アイコンボタンを追加:

```tsx
{showSearchButton && !isSearchOpen && (
  <button
    onClick={openSearch}
    className="absolute top-2 right-16 z-10 p-2 bg-gray-700 rounded"
    aria-label="ターミナルを検索"
  >
    <SearchIcon />
  </button>
)}
```

---

## 10. アクセシビリティ設計

```tsx
// TerminalSearchBar
<div
  role="search"
  aria-label="ターミナル出力を検索"
>
  <input
    aria-label="検索クエリ"
    aria-controls="terminal-search-status"
  />
  <div
    id="terminal-search-status"
    aria-live="polite"
    aria-atomic="true"
  >
    {matchCount > 0 ? `${currentMatchIndex + 1}/${matchCount}件` : '一致なし'}
  </div>
  <button aria-label="前の一致箇所" />
  <button aria-label="次の一致箇所" />
  <button aria-label="検索を閉じる" />
</div>
```

---

## 11. テスト設計

### 単体テスト（useTerminalSearch）

```
- 検索ロジック: クエリが空の場合はマッチなし
- 検索ロジック: 大文字小文字を区別しない検索
- 検索ロジック: 件数上限(500件)のテスト
- ナビゲーション: nextMatch/prevMatchで循環する
- デバウンス: 300ms後に検索が実行される
```

### 単体テスト（TerminalSearchBar）

```
- レンダリング: 件数表示が正しく表示される
- 操作: Escキーで閉じる
- 操作: 前/次ボタンでコールバックが呼ばれる
- アクセシビリティ: aria-live が更新される
```

### 単体テスト（TerminalDisplay 統合）

```
- Ctrl+Fでisopen=trueになる（tabIndex設定時）
- showSearchButton=trueで検索ボタンが表示される
- 検索を閉じるとhighlightがクリアされる
```

---

## 12. 設計上の決定事項とトレードオフ

| 決定事項 | 採用理由 | トレードオフ |
|---------|---------|------------|
| CSS Custom Highlight API | XSSリスクゼロ、既存HTML構造を変更しない、ANSIカラーと共存 | ブラウザサポートが限定的（フォールバック必要） |
| プレーンテキスト検索（indexOf） | SEC-MF-001準拠、ReDoSリスクなし | 正規表現検索はサポートしない |
| 検索UIをTerminalDisplay内に閉じる | 外部propsの追加を最小化、WorktreeDetailRefactored変更不要 | TerminalDisplayのサイズが増大 |
| ANSI除去にregexを使用 | 軽量、依存なし | 複雑なANSI CSI以外のシーケンスを見落とす可能性 |

---

## 13. 影響ファイル

### 新規作成

| ファイル | 内容 |
|---------|------|
| `src/hooks/useTerminalSearch.ts` | ターミナル検索フック |
| `src/components/worktree/TerminalSearchBar.tsx` | 検索バーUIコンポーネント |
| `src/lib/terminal-highlight.ts` | CSS Highlight API ラッパー関数 |
| `tests/unit/hooks/useTerminalSearch.test.ts` | フックの単体テスト |
| `tests/unit/components/TerminalSearchBar.test.tsx` | コンポーネントの単体テスト |
| `tests/unit/lib/terminal-highlight.test.ts` | ハイライト関数の単体テスト |

### 変更

| ファイル | 変更内容 |
|---------|---------|
| `src/components/worktree/TerminalDisplay.tsx` | 検索バーUI統合、キーボードショートカット、ハイライト制御 |
| `tests/unit/components/TerminalDisplay.test.tsx` | 検索機能の統合テスト追加 |
| `src/app/globals.css`（または同等） | `::highlight()` CSS定義追加 |

### 変更不要

- `src/components/worktree/WorktreeDetailRefactored.tsx` - TerminalDisplayのprops変更はなし
- `src/app/api/` - サーバーサイドAPIの変更なし
- `src/lib/file-search.ts` - 既存ファイル検索ロジックの変更なし

---

## 14. CLAUDE.md準拠チェック

| 原則 | 対応 |
|-----|------|
| SOLID: 単一責任 | useTerminalSearch, TerminalSearchBar, ansi-stripperそれぞれが単一責務 |
| KISS | 最小限の新規コンポーネント追加。新規APIなし |
| YAGNI | 正規表現検索・マルチワード検索は未実装（スコープ外） |
| DRY | ANSIストリッパーを`src/lib/`に共通化 |
| セキュリティ | SEC-MF-001（ReDoS防止）、XSS対策（CSS Highlight API使用） |
