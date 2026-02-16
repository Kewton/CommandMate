# Issue #288 仮説検証レポート

## 検証日時
- 2026-02-17

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | handleMessageChange内のセレクター表示ロジックに問題がある | **Confirmed** | コード確認済み - L158で条件一致時に必ずセレクター再表示 |
| 2 | handleFreeInput()でセレクターを閉じても再表示される | **Confirmed** | L141-148でセレクター閉じるが、L158-159で再表示される |
| 3 | submitMessage()でメッセージがクリアされる | **Confirmed** | L76で `setMessage('')` 実行を確認 |

## 詳細検証

### 仮説 1: handleMessageChange内のセレクター表示ロジックに問題がある

**Issue内の記述**:
> `src/components/worktree/MessageInput.tsx` L158 の `handleMessageChange` 内のセレクター表示ロジックに問題がある。

**検証手順**:
1. `MessageInput.tsx` L153-163 の `handleMessageChange` 関数を確認
2. L158 の条件式を検証

**判定**: **Confirmed**

**根拠**:
```typescript
// L157-162
if (newValue === '/' || (newValue.startsWith('/') && !newValue.includes(' '))) {
  setShowCommandSelector(true);  // ← handleFreeInput()で閉じても再表示される
} else {
  setShowCommandSelector(false);
}
```

コードが完全に一致し、Issue記載の行番号も正確。条件 `newValue.startsWith('/') && !newValue.includes(' ')` により、`/` で始まりスペースを含まないすべての入力でセレクターが表示される。

---

### 仮説 2: handleFreeInput()でセレクターを閉じても再表示される

**Issue内の記述**:
> `handleFreeInput()`（L141-148）はセレクターを閉じて `/` をセットするが、その後の入力で `handleMessageChange` が呼ばれるたびに、メッセージが `/` で始まりスペースを含まない場合にセレクターが再表示されてしまう。

**検証手順**:
1. `handleFreeInput` 関数を確認（L141-148）
2. `handleMessageChange` との相互作用を確認

**判定**: **Confirmed**

**根拠**:
```typescript
// L141-148: handleFreeInput
const handleFreeInput = () => {
  setShowCommandSelector(false);  // セレクター閉じる
  setMessage('/');                // '/' をセット
  setTimeout(() => {
    textareaRef.current?.focus();
  }, 50);
};
```

1. `handleFreeInput()` が `setMessage('/')` を実行
2. ユーザーが続けて文字入力（例: `m` → `/m`）
3. `handleMessageChange` が発火し、`newValue = '/m'`
4. 条件 `newValue.startsWith('/') && !newValue.includes(' ')` が `true`
5. `setShowCommandSelector(true)` でセレクター再表示

この動作フローが確認され、仮説は正確。

---

### 仮説 3: submitMessage()でメッセージがクリアされる

**Issue内の記述**:
> フラグはメッセージ送信時またはメッセージがクリアされた時にリセットする。

**検証手順**:
1. `submitMessage` 関数を確認（L66-83）

**判定**: **Confirmed**

**根拠**:
```typescript
// L76
setMessage('');
```

`submitMessage()` 内で L76 にて `setMessage('')` が実行され、メッセージがクリアされることを確認。この時点でフリー入力モードフラグをリセットする実装が適切。

---

## Stage 1レビューへの申し送り事項

**全仮説が Confirmed** のため、Issue記載の原因分析および対策案は正確。レビュー時に以下を確認：

1. **対策案の妥当性**: `isFreeInputMode` フラグによる制御が適切か
2. **エッジケース**:
   - ユーザーが手動でメッセージを削除した場合のフラグリセット
   - 複数の `/` 入力シナリオ
3. **既存機能への影響**: 通常のスラッシュコマンドセレクター動作に影響がないか

## 結論

Issue #288 の仮説はすべてコードベースと一致しており、根本原因の分析は正確。対策案も適切な方向性を示している。
