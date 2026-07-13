# デザインシステム

CommandMate の UI デザイン基盤（色トークン・アイコン等）に関する規約をまとめる。

---

## セマンティックトークン（色）

CommandMate の色は **CSS 変数（セマンティックトークン）** で一元管理する。
Tailwind からは `bg-background` / `bg-surface` / `text-accent-500` のようなセマンティック
クラスで参照し、`gray-*` / `cyan-*` / `blue-*` の直書きは原則禁止とする。

- トークン定義: [`src/app/globals.css`](../src/app/globals.css)（`:root` = ライト、`.dark` = ダーク）
- Tailwind への登録: [`tailwind.config.js`](../tailwind.config.js) の `theme.extend.colors`
- 初出: Issue #1041（基盤導入。既存コンポーネントの一括置換は #1045 で実施）

> このトークン基盤の導入では **見た目を変えない**。各トークンの値は現行 Tailwind シェードの
> 実効値を写し取っている（例: `--background`(light) = `gray-50`）。

### トークン一覧

値は `rgb(...)` 合成のため **RGB チャンネル値（スペース区切り）** で定義する。
末尾に対応する現行 Tailwind シェードを併記する。

| トークン | ライト（`:root`） | ダーク（`.dark`） | 用途 |
|---------|------------------|------------------|------|
| `--background` | gray-50 | `#0f1117`（旧 `cmd-bg-dark`） | ページ背景 |
| `--foreground` | gray-900 | gray-100 | 基本文字色 |
| `--surface` | white | gray-800 | カード・パネル背景 |
| `--surface-foreground` | gray-900 | gray-100 | サーフェス上の文字色 |
| `--surface-2` | gray-50 | gray-900 | 一段深いサーフェス |
| `--muted` | gray-100 | gray-800 | 補助背景 |
| `--muted-foreground` | gray-500 | gray-400 | 補助文字 |
| `--border` | gray-200 | gray-700 | 境界線 |
| `--input` | gray-300 | gray-600 | フォーム枠 |
| `--ring` | cyan-500 | cyan-500 | フォーカスリング |
| `--accent-50`〜`--accent-950` | cyan-50〜950 | cyan-50〜950 | アクセント（cyan スケール） |
| `--success` | green-500 | green-500 | 成功 |
| `--warning` | amber-500 | amber-500 | 警告 |
| `--danger` | red-500 | red-500 | エラー・破壊的操作 |
| `--info` | blue-500 | blue-500 | 情報 |
| `--success-subtle` / `-border` / `-foreground` | green-50 / 200 / 800 | green-950 / 800 / 300 | 成功アラート面（淡色背景・枠・前景） |
| `--warning-subtle` / `-border` / `-foreground` | amber-50 / 200 / 800 | amber-950 / 800 / 300 | 警告アラート面 |
| `--danger-subtle` / `-border` / `-foreground` | red-50 / 200 / 800 | red-950 / 800 / 300 | エラーアラート面 |
| `--info-subtle` / `-border` / `-foreground` | blue-50 / 200 / 800 | blue-950 / 800 / 300 | 情報アラート面 |
| `--sidebar` | slate-50 | `#141821`（= `--surface`） | サイドバー地色 |
| `--sidebar-foreground` | gray-900 | gray-100 | サイドバー主要テキスト |
| `--sidebar-border` | slate-200 | `#2a303e` | サイドバー境界ヘアライン |
| `--sidebar-hover` | slate-100 | gray-800 | hover / 選択行の背景 |
| `--sidebar-muted` | gray-500 | gray-400 | サイドバー二次テキスト |

`--accent-*` と `--success` / `--warning` / `--danger` / `--info` はライト・ダークで同値だが、
将来のモード別調整を容易にするため両ブロックに明示的に定義している。

`--{status}-subtle/-border/-foreground`（Issue #1112 のステータス tint スケール）は**モード可変**。
ライトは `*-50` の淡色面＋ `*-800` の前景（AA 4.5:1 超）、ダークは `*-950` の低輝度面
（#0a0c12→#141821 のエレベーション階梯から浮かない）＋ `*-300` の前景（AA 8:1 超）。

`--sidebar-*`（Issue #1073）は **standalone なリテラル RGB 値**で定義する（`--surface` 等を
`var()` 参照しない）。理由: `--surface` 階梯の将来改修がサイドバー色に意図せず波及するのを防ぐため。
「テーマ追従」方式のため、ライトは白系パネル（slate-50 + ヘアライン）、ダークは `#141821`
（`--surface` = #1049 の階梯）に整合させる。`ThemeToggle` はサイドバー／ヘッダー共有部品のため
`--sidebar-*` には束縛せず、テーマ中立トークン（`text-muted-foreground` / `hover:bg-muted` /
`focus:ring-ring`）で着色する。

### Tailwind クラス対応

| CSS 変数 | Tailwind クラス例 |
|---------|------------------|
| `--background` | `bg-background` |
| `--foreground` | `text-foreground` |
| `--surface` / `--surface-foreground` / `--surface-2` | `bg-surface` / `text-surface-foreground` / `bg-surface-2` |
| `--muted` / `--muted-foreground` | `bg-muted` / `text-muted-foreground` |
| `--border` | `border-border` |
| `--input` | `border-input` |
| `--ring` | `ring-ring` / `focus:ring-ring` |
| `--accent-500` | `bg-accent-500` / `text-accent-500` |
| `--success` / `--warning` / `--danger` / `--info` | `text-success` / `bg-danger` など |
| `--{status}-subtle` / `--{status}-border` / `--{status}-foreground` | `bg-warning-subtle` / `border-warning-border` / `text-warning-foreground` など |
| `--sidebar` / `--sidebar-foreground` / `--sidebar-border` | `bg-sidebar` / `text-sidebar-foreground` / `border-sidebar-border` |
| `--sidebar-hover` / `--sidebar-muted` | `hover:bg-sidebar-hover` / `text-sidebar-muted` |

各色は `rgb(var(--token) / <alpha-value>)` 形式で登録しているため、
`bg-surface/80` のように **透過度指定** がそのまま使える。

### 使用ルール

1. **新規・変更するスタイルはセマンティックトークン経由で指定する**
   （`bg-white dark:bg-gray-800` ではなく `bg-surface`）。
2. トークンはライト/ダーク両モードで自動的に切り替わるため、**`dark:` バリアントは原則不要**。
3. 新しい意味的な色が必要になったら、直書きを増やさず **まずトークンを追加** する。
4. **淡色アラート面（Toast・エラーフォールバック・PromptPanel 等）は生パレット＋`dark:`ペア禁止**。
   `bg-{status}-subtle` + `border-{status}-border` + `text-{status}-foreground` の tint トークンを使う
   （status = success / warning / danger / info。Issue #1112）。tint 面内のソリッドアクションボタンは
   反転 tint（`bg-{status}-foreground text-{status}-subtle`）とし、両テーマで AA コントラストを確保する。
   常時ダーク島（`TerminalErrorFallback` 等の `*Terminal*` 面）はこのルールの対象外。

### 直書き色の禁止と例外

`gray-*` / `cyan-*` / `blue-*` 等の **直書きカラークラスは原則禁止**。以下は例外として許容する。

- **モードに依存しない固定色**: ブランド固定のシンタックスハイライト（`.prose pre` の
  `#0d1117` 等）、ターミナル配色、`::highlight()` 検索ハイライト。
- **意味的にトークン化されていない一過性の装飾**: 追加のトークン化が過剰と判断できる箇所。
  この場合もライト/ダーク両対応を保つこと。
- **サードパーティ由来のクラス**: xterm.js / highlight.js 等が要求する固定クラス。

例外を用いる場合は、その色がなぜトークン化に馴染まないかを PR で説明すること。

#### アクセント統一（#1045）で維持する直書き例外

`cyan-*` / `blue-*` をセマンティックトークンへ統一する際（Issue #1045）、以下は
意図的に直書きを維持する。これら以外に `cyan-*` / `blue-*` の直書きクラスが残っていないことを
grep で確認する運用とする。

1. **ターミナル ANSI 配色**: `src/components/Terminal.tsx` の xterm `theme` 内の色
   （`blue`/`cyan`/`brightBlue`/`brightCyan` 等の HEX 値）。ANSI パレットのため固定色を維持。
2. **CLI ツールのブランド識別色**: `src/app/worktrees/[id]/terminal/page.tsx` の CLI ツール選択色
   （claude=`bg-purple-600` / codex=`bg-blue-600` / gemini=`bg-green-600` / bash=`bg-gray-600`）。
   ツール識別のためのブランド色として当面維持する。
3. **スクロールバー**: `src/app/globals.css` の `.scrollbar-thin` は **Issue #1082 でトークン化済み**
   （thumb = `rgb(var(--input))` / hover = `rgb(var(--muted-foreground))`）。ライト/ダーク両モードに追従する。
   （なお `MessageList.tsx` は本 Issue で完全にトークン化済みで、直書きの `cyan-*` / `blue-*` は残っていない。）

なお、状態・情報色として使われていた `blue-*` は `info` トークン（= blue-500）へ、
インタラクティブ／アクティブ／フォーカスの `blue-*` は `accent` / `ring` トークンへ統一した。

### 常時ダーク領域とテーマ追従（#1075）

UI の配色方針は次の 2 分類のみ。曖昧な「暗いまま」の島を新設しないこと。

- **(a) 常時ダーク（意図的固定）**: xterm ターミナル本体の出力領域
  （`src/components/Terminal.tsx` / `TerminalDisplay.tsx` の描画先、`TerminalSearchBar` /
  `LogViewer` 等のターミナル系オーバーレイ）と、シンタックスハイライト付きコードブロック
  （`.prose pre` / `.assistant-md pre` = `#0d1117`。github-dark 系トークンが暗地前提のため）。
  端末・コードの慣例として妥当な固定ダーク。ライトモードでもダークで描画する。
- **(b) テーマ追従（既定）**: 上記以外の**すべての UI**。履歴ペイン・会話カード・Home Chat・
  メモ/ファイル等を含め、`surface` / `surface-2` / `border` / `foreground` /
  `muted-foreground` 等のセマンティックトークンで着色し、ライト/ダーク両モードへ追従する。
  常時ダーク領域を新設・拡張しないこと。

> **hidden-children 注意**: 常時ダーク前提で子孫が `text-gray-300` / `bg-gray-800` 等を
> `dark:` 無しで直書きしていると、テーマ追従化した親の下でライト時に不可視化する。
> コンテナだけでなく**描画サブツリー全体**をトークン化し、ライトの実画面で目視確認する。

---

## フォーカス表現 (Issue #1082)

インタラクティブ要素のフォーカスリングは **`focus-visible:`**（`focus:` ではなく）で表現し、
キーボード操作時のみリングを描画する（マウスクリックでリングを出さない）。手本は `Tabs` / `Switch`。

- **ボタン系プリミティブ**（`Button` / `SidebarToggle` / アイコンボタン等）:
  `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background`。
  `ring-offset-background` を必ず付ける（未指定だと Tailwind 既定の白オフセットがダークで白ハローになる）。
- **フォーム系プリミティブ**（`Input` / `Textarea` / `Select` トリガー等）:
  `focus-visible:ring-2 focus-visible:ring-ring focus-visible:border-ring`（枠が反応するため ring-offset は付けない）。
- 逸脱フォーカス色（`ring-gray-*` / `ring-red-*` / purple / amber）は使わない。既定は `ring-ring`、
  破壊的操作の文脈でのみ `ring-danger`。

### テキスト選択・ツールチップ

- **`::selection`**: `rgb(var(--accent-500) / 0.25)` のアクセント淡色ウォッシュ（`globals.css`、両モード共通）。
- **ツールチップ**: 反転サーフェス `bg-foreground text-background`（Radix `TooltipContent` が基準。
  ライトで暗い吹き出し、ダークで明るい吹き出しにテーマ追従する）。二次テキストは `text-background/70`。

## トークン規律 CI ガード (Issue #1082)

移行済みディレクトリに **生 `gray` / `slate` 直書き（`bg-`/`text-`/`border-`/`ring-`）が再流入したら CI で hard-fail** する
（`.github/workflows/ci-pr.yml` の `token-discipline` ジョブ。CLAUDE.md size check と同方式の `git grep` ガード）。

- **対象（ホワイトリスト）**: `src/app`（`src/app/worktrees/**` を除く）、`src/components/{ui,layout,home,review,repository,common,sidebar,providers}`。
- **対象外（未移行・#1061 で拡大予定）**: `src/components/{worktree,mobile,external-apps}`、`src/app/worktrees/**`
  （ワークツリー領域。常時ダークのターミナルページと CLI ブランド色 `bash=bg-gray-600` 等を含む）、
  および `src/components/Terminal.tsx` 等のターミナル系。テストファイル（`*.test.*` / `*.spec.*` / `__tests__`）も除外。
- **違反時の直し方**: ホワイトリストをいじらず、`docs/design-system.md` のセマンティックトークン
  （`foreground` / `muted` / `muted-foreground` / `border` / `surface` / `input` / `ring` 等）へ置換する。

---

## アイコン (Icons)

### ライブラリ

- UI アイコンは **[lucide-react](https://lucide.dev/)** に統一する。
- 絵文字リテラル(🤖 / ⚡ / ✦ / 💻 / ⭐ / ✨ など)を **UI 表示に使用しない**。
  絵文字は OS・ブラウザで見た目が変わり、モダンな UI トーンを崩すため。
  - 例外: ターミナルストリーム出力(xterm.js に書き込むテキスト)や CLI 出力・
    ログ・検出パターン(`src/lib/detection/**`)は対象外。これらは表示 UI ではなく
    テキストコンテンツのため。

### サイズ規約

アイコンサイズは以下の 3 段階に統一する(`size` prop または `w-*/h-*`)。

| サイズ | 用途 |
|--------|------|
| **16px** | テキストインライン、密度の高いリスト・バッジ内 |
| **20px** | ナビゲーション・ツールバー・タブ(標準) |
| **24px** | 見出し・強調・モーダルヘッダ |

### strokeWidth

- `strokeWidth` は **2**(lucide-react のデフォルト)を基準とする。
- 現行デザインの見た目に合わせて個別調整する場合を除き、変更しない。

### 色

- アイコンの色は原則 `currentColor` を継承させ、親要素のテキスト色
  (セマンティックトークン経由、ライト/ダーク両対応)で制御する。
- ブランド固有色(CLI ツールの claude/codex/gemini 等)は個別指定を許容する。

### アクセシビリティ

- 装飾目的のアイコンには `aria-hidden="true"` を付与し、隣接するテキストラベルや
  `aria-label` を主たるアクセシブルネームとする。
- アイコン単独ボタンには必ず `aria-label` を付与する。

### 実装例

```tsx
import { Bot } from 'lucide-react';

// ナビ・ツールバー(20px 標準)
<Bot size={20} aria-hidden="true" />

// テキストインライン(16px)
<Star size={16} className="inline align-[-2px] mr-1" aria-hidden="true" />
```

---

## UI プリミティブ (Issue #1046)

`src/components/ui/` の共通プリミティブ。すべて `cn()` + セマンティックトークンで
着色し、ライト/ダーク両モードに自動対応する。`@/components/ui` から import する。

- **着色**: セマンティックトークン経由(`bg-surface` / `border-input` / `ring-ring` 等)。直書き色は使わない。
- **SSR**: Radix の Portal 系(Select / Tooltip / DropdownMenu / Switch / Tabs)は `'use client'` 必須。
- **z-index**: Portal コンテンツは `Z_INDEX.POPOVER`(65)で描画され、Modal(50)より前面に出る(`src/config/z-index.ts`)。
- **a11y / キーボード**: Radix 既定のロール・aria 属性・キーボード操作(Tab/矢印/Escape)を壊さない。

### Input / Textarea

ネイティブ要素ベース。`inputSize`(`sm` / `md` / `lg`)で高さを切り替える。

```tsx
import { Input, Textarea } from '@/components/ui';

<Input placeholder="Filter..." value={q} onChange={(e) => setQ(e.target.value)} />
<Input inputSize="sm" aria-label="検索" />
<Textarea rows={4} placeholder="説明" />
```

### Select

`@radix-ui/react-select` ベース。トリガーは `role="combobox"`、項目は `role="option"`。

```tsx
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui';

<Select value={sortKey} onValueChange={setSortKey}>
  <SelectTrigger className="w-40" aria-label="並び替え">
    <SelectValue />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="repositoryName">Repository</SelectItem>
    <SelectItem value="lastSent">Last Sent</SelectItem>
  </SelectContent>
</Select>
```

### Tabs

`underline`(既定)と `pill` の 2 バリアント。`variant` は `Tabs` に渡す。

```tsx
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';

<Tabs defaultValue="overview" variant="pill">
  <TabsList>
    <TabsTrigger value="overview">概要</TabsTrigger>
    <TabsTrigger value="detail">詳細</TabsTrigger>
  </TabsList>
  <TabsContent value="overview">...</TabsContent>
  <TabsContent value="detail">...</TabsContent>
</Tabs>
```

### Tooltip

`TooltipProvider` でラップして使う(アプリ全体を 1 回で囲ってもよい)。

```tsx
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui';

<TooltipProvider delayDuration={300}>
  <Tooltip>
    <TooltipTrigger aria-label="ヘルプ"><HelpCircle size={16} /></TooltipTrigger>
    <TooltipContent>補足説明</TooltipContent>
  </Tooltip>
</TooltipProvider>
```

### DropdownMenu

`Item` / `CheckboxItem` / `RadioItem` / `Label` / `Separator` を提供。

```tsx
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui';

<DropdownMenu>
  <DropdownMenuTrigger aria-label="操作">…</DropdownMenuTrigger>
  <DropdownMenuContent>
    <DropdownMenuItem onSelect={onRename}>名前変更</DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem onSelect={onDelete}>削除</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

### Switch

`role="switch"`。`checked` / `onCheckedChange` で制御する。ラベルは `aria-label` で付与。

```tsx
import { Switch } from '@/components/ui';

<Switch checked={enabled} onCheckedChange={setEnabled} aria-label="通知を有効化" />
```

### Skeleton

`animate-pulse` のローディングプレースホルダ。サイズは `className` で指定。

```tsx
import { Skeleton } from '@/components/ui';

<Skeleton className="h-4 w-32" />
```

---

## モーション (Motion, Issue #1050)

マイクロインタラクションは **[`tailwindcss-animate`](https://github.com/jamiebuilds/tailwindcss-animate)**
で統一する。`framer-motion` は採用しない（バンドル軽量・Server Components 相性）。

### 規約（duration / easing）

| トークン | 値 | 用途 |
|---------|-----|------|
| `--motion-duration-fast` | 150ms | hover / 状態遷移・小さな要素 |
| `--motion-duration-base` | 200ms | Modal・ドロップダウンの開閉（標準） |
| `--motion-duration-slow` | 300ms | 一覧の stagger 入場など |
| `--motion-ease-out` | `cubic-bezier(0.16, 1, 0.3, 1)` | 入場（enter）基調 |
| `--motion-stagger-step` | 40ms | 一覧 stagger の 1 件あたり遅延 |

- 定義: [`src/app/globals.css`](../src/app/globals.css) の `:root`（モード非依存のため 1 箇所）。
- Tailwind からは `duration-150` / `duration-200` / `duration-300` で参照する
  （`tailwindcss-animate` の `duration-*` は `animation-duration` にも適用される）。
- easing は入場を `ease-out` 基調とし、急に現れる印象を避ける。

### enter / exit の標準パターン

- **Modal**（`src/components/ui/Modal.tsx`）: `data-state`（`open` / `closed`）に
  `data-[state=open]:animate-in fade-in-0 zoom-in-95 duration-200`（enter）と
  `data-[state=closed]:animate-out fade-out-0 zoom-out-95 duration-200 fill-mode-forwards`
  （exit）を連動。閉要求後は `useExitAnimation`（Issue #1114）が 200ms 描画を保持し、
  exit アニメ完了後に unmount する。
- **Toast / ContextMenu**: 同じく `useExitAnimation` で unmount を遅延し、Toast は
  `animate-out fade-out-0 slide-out-to-right-full`（200ms）、ContextMenu は
  `animate-out fade-out-0 zoom-out-95`（enter と同じ 100ms）で退場する。JS タイマーは
  `src/config/ui-feedback-config.ts` の `EXIT_ANIMATION_DURATION_MS` /
  `CONTEXT_MENU_EXIT_DURATION_MS` で CSS と同期する。
- **PromptPanel**（`usePromptAnimation`）: `animate-fade-in` / `animate-fade-out`
  （`tailwind.config.js` の keyframes、`var(--motion-duration-base)` +
  `var(--motion-ease-out)`）でフェードし、フック内タイマーで unmount を遅延する。
- **MobilePromptSheet**（`src/components/mobile/MobilePromptSheet.tsx`）: 既存の
  `usePromptAnimation` による slide-up（`translate-y-full → 0`）の enter/exit を踏襲。
- **Radix プリミティブ**（Select / DropdownMenu / Tooltip）: Radix の `data-state`
  （`open` / `closed` / Tooltip は `delayed-open`）と `data-side` に連動して
  `animate-in` / `animate-out` + `fade` + `zoom-95` + `slide-in-from-*` を適用。
  Radix が閉時も要素を保持するため exit アニメが再生される。

### 一覧の stagger

`src/lib/utils/stagger.ts` の `STAGGER_ENTER_CLASS` + `staggerDelay(index)` を使う。

- `fill-mode-backwards` で遅延中のみ開始フレーム（不可視）を保持し、入場後は素の
  スタイルへ戻す（後続の hover lift を上書きしない）。
- 最大 10 件程度まで `animation-delay` を段階付与し、それ以降は 0ms。
- **再ポーリングで再発火させない**: 一覧項目は必ず**安定したキー**（例: `wt.id`）を
  付ける。DOM ノードが再利用される限り、CSS アニメは再生されない。`key={index}` の
  ような不安定キーは禁止。

### hover lift / active press

- インタラクティブな **Card** は `interactive` prop（`hover:-translate-y-0.5 hover:shadow-lg`
  + `active:translate-y-0`）。装飾のみの影は従来どおり `hover` prop。
- **Button** は既定で hover lift + active press を持つ（無効時は付与しない）。

### 適用しない領域（重要）

- **ターミナル出力・仮想スクロール領域にはモーションを適用しない**（パフォーマンス優先）。
  xterm.js 描画や `@tanstack/react-virtual` の行にアニメーションクラスを付けないこと。

### `prefers-reduced-motion`

OS の「視差効果を減らす（reduce motion）」設定時は、[`src/app/globals.css`](../src/app/globals.css)
末尾のグローバル `@media (prefers-reduced-motion: reduce)` が全アニメーション/トランジションを
実質無効化する。コンポーネント側でこのメディアクエリを再実装しないこと。
