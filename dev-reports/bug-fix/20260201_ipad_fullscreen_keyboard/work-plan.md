# バグ修正作業計画

## 不具合概要
- **Issue**: #104 追加問題
- **現象**: iPad横置きで全画面表示後、テキストエリアをタップすると全画面が解除される
- **根本原因**: iOS/iPadOSのFullscreen APIが仮想キーボード表示時に自動解除される（ブラウザ仕様）

## 選択された対策
**案A: iPad検出時はCSSフォールバック強制**

## 修正対象ファイル
1. `src/hooks/useFullscreen.ts` - iPad検出ロジック追加、フォールバック強制

## 修正内容

### 1. iPad/iOS検出関数の追加
```typescript
function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
```

### 2. enterFullscreen関数の修正
iPad検出時はFullscreen APIを使用せず、直接CSSフォールバックモードに移行

### 3. テストケース追加
- iPad検出時のフォールバックモード強制テスト

## Definition of Done
- [ ] useFullscreen.tsにiPad検出ロジック追加
- [ ] iPad検出時はisFallbackMode=trueで動作
- [ ] 既存テストがすべてパス
- [ ] ESLint/TypeScript エラーなし
- [ ] ビルド成功
