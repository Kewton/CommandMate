# Issue #104 レビューレポート

**レビュー日**: 2026-02-01
**フォーカス**: 通常レビュー（整合性・正確性）
**イテレーション**: 1回目

## サマリー

| カテゴリ | 件数 |
|---------|------|
| Must Fix | 2 |
| Should Fix | 3 |
| Nice to Have | 2 |

## 検証結果

### 行番号の確認

| Issue記載 | 実際のコード | 状態 |
|-----------|------------|------|
| `MarkdownEditor.tsx:184` (isMobilePortrait) | L184 | 一致 |
| `MarkdownEditor.tsx:437-441` (containerStyle) | L436-441 | 1行ずれ |
| `useIsMobile.ts` (breakpoint 768px) | L51, L62 | 一致 |

### コードロジックの確認

| 項目 | 確認結果 |
|------|---------|
| isMobilePortrait が静的評価 | 確認: 初回レンダリング時のみ評価（state/effectではない） |
| z-index条件 | 確認: `isMaximized && isFallbackMode` の両方がtrueの場合のみ設定 |
| useIsMobileのresizeリスナー | 確認: resizeイベントリスナーあり（L68-70） |

---

## Must Fix（必須対応）

### MF-1: 行番号の不一致

**カテゴリ**: 正確性
**場所**: ## 原因分析 セクション

**問題**:
Issueで参照している行番号がコードの実際の行番号と一致しない部分がある。

**証拠**:
- Issue記載: `src/components/worktree/MarkdownEditor.tsx:437-441`
- 実際のコード: L436-441（1行のずれ）

```typescript
// 実際のコード（L436-441）
const containerStyle = useMemo(() => {
  if (isMaximized && isFallbackMode) {
    return { zIndex: Z_INDEX.MAXIMIZED_EDITOR };
  }
  return undefined;
}, [isMaximized, isFallbackMode]);
```

**推奨対応**:
正しい行番号に修正する。

---

### MF-2: z-index条件の問題分析が不完全

**カテゴリ**: 正確性
**場所**: ## 原因分析 > 2. z-index の条件付き設定

**問題**:
Fullscreen API成功時のz-index設定に関する説明が不足している。Issue #99の設計意図と現在の問題の関係が不明確。

**証拠**:
`useFullscreen.ts` L188-193を確認:
```typescript
if (isFullscreenSupported() && elementRef?.current) {
  try {
    await requestFullscreen(elementRef.current);
    setIsFullscreen(true);
    setIsFallbackMode(false);  // API成功時はfalse
    onEnter?.();
  } catch (err) {
```

Fullscreen API成功時は `isFallbackMode = false` となり、z-indexは意図的に設定されない設計になっている。これはFullscreen APIが正常に動作すれば、ブラウザがフルスクリーン要素を最上位に配置するためz-indexは不要という前提に基づく。

**推奨対応**:
- Fullscreen API成功時はz-indexが不要という設計意図を追記
- iPad Chromeで実際にFullscreen APIが成功しているか（isFallbackModeの値）を確認結果として追記
- 問題が親要素のスタッキングコンテキストに起因する可能性を追記

---

## Should Fix（推奨対応）

### SF-1: iPad Chrome固有のFullscreen API挙動調査結果が不足

**カテゴリ**: 完全性
**場所**: ## 原因分析

**問題**:
`isFallbackMode = false (Fullscreen API成功時)` と記載されているが、実際にiPad Chromeでこの値を確認したかどうかが不明。

**証拠**:
Fullscreen APIが失敗した場合は `useFullscreen.ts` L200-203 のフォールバック処理が実行される:
```typescript
// Fall back to CSS-based fullscreen
setIsFullscreen(true);
setIsFallbackMode(true);
onEnter?.();
```

**推奨対応**:
iPad ChromeでDevToolsを使用し、以下を確認して結果を追記:
1. `isFullscreen` の値
2. `isFallbackMode` の値
3. Fullscreen API成功/失敗のログ

---

### SF-2: 修正方針案の優先度と関係性が不明確

**カテゴリ**: 明確性
**場所**: ## 修正方針案

**問題**:
3つの修正方針案が提示されているが、それぞれの目的と優先度、適用条件が不明確。

**証拠**:
- **案1**: z-index条件の修正 - 即座のバグ修正として有効
- **案2**: オリエンテーション変更の検知 - モバイルポートレート判定の問題
- **案3**: タブレット判定の追加 - iPad特有の対応

Issue本文の「ターミナルタブが前面に表示される」問題は、主に案1で解決できる可能性が高い。案2・案3は別の問題（オリエンテーション変更時のUI切替）に関連する。

**推奨対応**:
- 各案の目的を明確化（バグ修正 vs 機能改善）
- 優先度を明記（案1: 高、案2: 中、案3: 低など）
- 今回のバグに対してどの案を採用するか推奨を追記

---

### SF-3: useIsMobile.tsに関する分析の修正

**カテゴリ**: 整合性
**場所**: ## 原因分析 > 3. iPad の判定漏れ

**問題**:
「オリエンテーション変更が検知されない」という分析が実装と完全には一致しない。

**証拠**:
`useIsMobile.ts` L68-70:
```typescript
window.addEventListener('resize', handleResize);
```

`useIsMobile` フック自体はresizeイベントをリッスンしており、オリエンテーション変更時にも更新される。

問題は `MarkdownEditor.tsx` L184:
```typescript
const isMobilePortrait = isMobile && typeof window !== 'undefined'
  && window.innerHeight > window.innerWidth;
```

この `isMobilePortrait` がコンポーネントの通常レンダリング時にのみ評価され、独立したstateや再評価メカニズムがない点にある。

**推奨対応**:
- 問題の正確な箇所を「isMobilePortraitの静的評価」として特定
- useIsMobile自体は動的更新されることを明記
- 修正案2のコード例が正しい対処法であることを追記

---

## Nice to Have（あれば良い）

### NTH-1: Issue #99との関連性の詳細説明

**カテゴリ**: 完全性
**場所**: ## 関連Issue

**問題**:
Issue #99を関連Issueとして挙げているが、具体的にどの設計判断がこの問題に関係しているかの説明がない。

**証拠**:
Issue #99 設計書（`dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md`）セクション12.1「採用した設計」:
> CSS固定ポジション優先 | ブラウザ互換性 | Fullscreen APIの没入感は得られない

この設計判断により、Fullscreen API成功時はz-indexを設定しない実装となった。

**推奨対応**:
Issue #99の該当セクションへの参照を追加し、設計判断の経緯を説明。

---

### NTH-2: 再現手順の詳細追記

**カテゴリ**: 完全性
**場所**: ## 再現手順

**問題**:
環境情報に具体的なバージョンが記載されていない。

**推奨対応**:
以下を追記:
- iPadOSのバージョン
- Chromeのバージョン
- サーバーURL（ローカルホスト/リモート）

---

## 参照ファイル

### コード
| ファイル | 関連性 |
|---------|--------|
| `src/components/worktree/MarkdownEditor.tsx` | 問題の主要箇所（L184, L436-441） |
| `src/hooks/useFullscreen.ts` | Fullscreen API処理（L188-210） |
| `src/hooks/useIsMobile.ts` | モバイル判定（L68-70にresizeリスナー） |
| `src/config/z-index.ts` | z-index値定義（MAXIMIZED_EDITOR: 40） |

### ドキュメント
| ファイル | 関連性 |
|---------|--------|
| `dev-reports/design/issue-99-markdown-editor-display-improvement-design-policy.md` | z-index条件の設計判断が記載 |

---

## 結論

Issue #104の原因分析は概ね正確だが、以下の点を修正・追記することで品質が向上する:

1. **行番号の修正**: L437-441 -> L436-441
2. **z-index設計意図の追記**: Fullscreen API成功時にz-indexを設定しない理由
3. **iPad固有の調査結果**: 実際のisFallbackMode値の確認
4. **修正方針の優先度明確化**: 案1を推奨として明記

特に重要なのは、案1（z-index条件の修正）が最も直接的な修正であり、これを第一の修正方針として推奨することを明記すべきである。

---

*レビュー実施日: 2026-02-01*
