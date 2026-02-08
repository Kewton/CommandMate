> **Note**: このIssueは 2026-02-08 にレビュー結果を反映して更新されました。
> 2026-02-08: 対象CLIツールの誤り（Codex → Claude Code）を修正し、全面的に見直し。
> 2026-02-08: Stage 1レビュー指摘事項を反映（MF-1〜3, SF-1〜4, NTH-1〜3）。
> 2026-02-08: Stage 3レビュー指摘事項を反映（MF-1〜2, SF-1〜4, NTH-1〜3）。影響範囲テーブルの拡充、テスト影響範囲の網羅、ドキュメント更新対象の追加。
> 2026-02-08: Stage 5レビュー指摘事項を反映（SF-NEW-1〜2, NTH-NEW-1〜3）。行番号修正、テスト影響範囲の記述精度向上、detectPrompt()呼び出し構造の説明改善。

## 概要

Claude Codeからの複数選択肢メッセージ（1~4の選択肢）に対し、CommandMateのUIから回答を送信できない。Auto-Yesモードでもタスクが進まない。

## 再現手順

1. CommandMateでClaude Codeセッションを開始
2. コーディングタスクを実行中、Claude Codeが複数選択肢を表示（例: 1~4の番号付き選択肢）
3. UIの入力欄に選択肢番号（例: `1`）を入力して送信ボタンを押す
4. エラーメッセージが表示され、回答が送信されない
5. Auto-Yesモードを有効にしても、選択肢で停止したまま進まない

## 期待する動作

- UIから選択肢番号を入力して送信すると、Claude Codeに回答が反映されタスクが継続する
- Auto-Yesモードが有効な場合、Claude Codeの選択肢にも自動応答してタスクが進む

## 実際の動作

- UIから送信しようとすると「プロンプトがアクティブでない」旨のエラーが表示される
- Auto-Yesモードでも選択肢を検出できず、タスクが停止したままになる

## スクリーンショット

1から4までの選択肢から該当のモノを選択して送信することを求められているが、commandmateから操作出来ない。

![Screenshot_20260208-092742.png](https://github.com/user-attachments/assets/d0088572-0759-4a6c-aa93-11c60f845150)

> **Phase 1での確認事項**: スクリーンショットから読み取れる選択肢のテキスト形式（行頭にインデントがあるか、番号の後にピリオドがあるか、各選択肢の区切りなど）をtmux capture-pane出力で正確に特定する。

## 根本原因の仮説

`prompt-detector.ts`の`detectMultipleChoicePrompt()`はClaude Codeの`❯`（U+276F）マーカー付き選択肢パターンに対応しているが、特定のClaude Codeプロンプト形式（スクリーンショットに示される形式）を検出できていない可能性がある。

### 処理フロー

```
Claude Code: 選択肢を表示（特定の形式）
  ↓
prompt-detector.ts: detectMultipleChoicePrompt()
  ├─ Pass 1 (L274-288): DEFAULT_OPTION_PATTERN (❯ U+276F) を検索 → マッチなし（❯マーカーが存在しない or 形式が異なる）
  │   → return { isPrompt: false }
  │
  └─ ※仮に Pass 1 を緩和しても:
      Layer 4 (L344-350): hasDefaultIndicator チェック
      → options.some(opt => opt.isDefault) が false の場合、ここでも return { isPrompt: false }
  ↓
prompt-response/route.ts: 「プロンプトがアクティブでない」と判定
  ↓
UI: エラーメッセージ表示 / Auto-Yes: 検出スキップ
```

**重要**: Pass 1（❯存在チェック）と Layer 4（hasDefaultIndicator チェック）は独立したゲートとして機能しており、❯マーカーなしの選択肢形式に対応するには**両方の修正が必要**。Pass 1 を緩和するだけでは Layer 4 で依然としてブロックされる。

### 調査が必要な点

1. **Claude Codeが選択肢をどのような形式で出力しているか**: tmuxバッファ（`tmux capture-pane -p`）を取得し、`stripAnsi()`後のテキストに❯マーカーが含まれるか確認
2. **❯マーカーなしの選択肢パターンが存在するか**: Claude Codeのバージョンやプロンプト種別によって、❯なしで番号付きリストのみの形式が使われるケースがあるか
3. **検出ウィンドウの制約**: `status-detector.ts`のSTATUS_CHECK_LINE_COUNT=15行制限により、選択肢が多い場合やヘッダーテキストが長い場合に検出ウィンドウから外れていないか

### 具体的な問題箇所（候補）

1. **`src/lib/prompt-detector.ts`**: `detectMultipleChoicePrompt()`内の2パス❯検出方式（Issue #161）が、スクリーンショットに示されるClaude Codeの選択肢形式をカバーできていない
   - Pass 1 (L274-288): `DEFAULT_OPTION_PATTERN` (`/^\s*\u276F\s*(\d+)\.\s*(.+)$/`) の存在チェック
   - Layer 4 (L344-350): `hasDefaultIndicator` (`options.some(opt => opt.isDefault)`) のチェック
2. **`src/app/api/worktrees/[id]/prompt-response/route.ts`**: `detectPrompt()`が選択肢プロンプトを認識できず、送信を拒否
3. **`detectPrompt()`の呼び出し箇所（計9箇所、うちstatus-detector.ts経由の間接呼び出し1箇所を含む）**: `detectPrompt()`の検出結果に依存する全箇所が影響を受ける:
   - **直接呼び出し（8箇所）**:
     1. `auto-yes-manager.ts` L290
     2. `prompt-response/route.ts` L75
     3. `current-output/route.ts` L88（thinkingガード付き。cliToolIdはworktree.cliToolIdから取得済み）
     4. `response-poller.ts` L248 **[Claude専用ガード内、stripAnsi()適用済み]**
     5. `response-poller.ts` L442 **[全CLIツール共通、ANSI未ストリップ]**
     6. `response-poller.ts` L556 **[全CLIツール共通、extractResponse()経由]**
     7. `claude-poller.ts` L164 **[到達不能コード: startPollingは呼び出されていない。一貫性のための修正]**
     8. `claude-poller.ts` L232 **[到達不能コード: 同上]**
   - **間接呼び出し（1箇所）**:
     9. `status-detector.ts` L87（内部で`detectPrompt()`を呼び出す中間モジュール。`detectSessionStatus()`は`cliToolId`を引数で受け取るが、現行は`detectPrompt()`への伝搬なし。ケースBではcliToolIdからDetectPromptOptionsを構築して`detectPrompt()`に渡す内部修正が必要）
4. **`detectSessionStatus()`経由の間接影響（コード変更不要）**:
   - `src/app/api/worktrees/route.ts` L58: サイドバーステータス表示。`detectSessionStatus()`経由で`detectPrompt()`を間接呼び出し。`detectSessionStatus()`のシグネチャは変更なしのためこのファイル自体の修正は不要だが、`detectPrompt()`の検出精度向上の恩恵を受ける
   - `src/app/api/worktrees/[id]/route.ts` L58: ワークツリー詳細ステータス表示。上記と同様の間接影響

> **注**: 旧Issue本文で参照していた `CLAUDE_CHOICE_INDICATOR_PATTERN` はコードベースに存在しない。選択肢検出パターンは `prompt-detector.ts` 内の `DEFAULT_OPTION_PATTERN` (L182) と `NORMAL_OPTION_PATTERN` (L189) にハードコードされている。`cli-patterns.ts` には選択肢パターンは定義されていない。

## 対策案

### Phase 1: 前提条件確認（実装前に必須）

実装前に以下を確認し、結果をこのIssueにコメントとして記録する:

1. **tmuxバッファのcapture-pane出力を取得**
   - `tmux capture-pane -p` でClaude Codeの選択肢表示時のバッファを取得
   - `stripAnsi()`後のテキストに❯マーカーが含まれるか確認
   - 番号付きリストのフォーマット（インデント、区切り文字等）を特定
   - **スクリーンショットの選択肢テキスト形式を正確に記録する**（行頭インデント有無、番号後のピリオド有無、各選択肢の区切り文字等）

2. **現行の検出ロジックとの照合**
   - 取得した出力を`detectMultipleChoicePrompt()`に入力し、検出されるか確認
   - 検出されない場合、どの条件で失敗しているかを特定:
     - **Pass 1** (L274-288): `DEFAULT_OPTION_PATTERN`（❯ U+276F）の存在チェック
     - **Layer 4** (L344-350): `hasDefaultIndicator`（`options.some(opt => opt.isDefault)`）のチェック
     - 連番検証、最小選択肢数等

3. **Claude Codeのバージョン・プロンプト種別の確認**
   - 選択肢が表示されるシナリオ（ツール承認、ファイル選択、確認プロンプト等）を特定
   - 各シナリオで出力形式が異なるかを確認

### Phase 2: パターン修正・コア実装（Phase 1完了後）

Phase 1の調査結果に基づき、以下のいずれかのアプローチを選択:

**ケースA: ❯マーカーはあるがパターンが一致しない場合**
- `src/lib/prompt-detector.ts`の`DEFAULT_OPTION_PATTERN` (L182) / `NORMAL_OPTION_PATTERN` (L189) を修正
- 正規表現の調整のみで対応可能

**ケースB: ❯マーカーなしの選択肢形式が存在する場合**
- `src/lib/prompt-detector.ts`の`detectMultipleChoicePrompt()`を拡張
- **案B（推奨）**: パターンのパラメータ化（`detectPrompt(output, options?)`）
  - `DetectPromptOptions` interfaceを定義:
    ```typescript
    interface DetectPromptOptions {
      /**
       * Pass 1 (L274-288) の DEFAULT_OPTION_PATTERN 存在チェックと
       * Layer 4 (L344-350) の hasDefaultIndicator チェックの両方をスキップする。
       * - true (デフォルト): ❯マーカー必須（既存動作を維持）
       * - false: ❯マーカーなしの選択肢も検出（Claude Code特殊形式用）
       */
      requireDefaultIndicator?: boolean;
      /** 追加の選択肢パターン注入（将来の拡張用） */
      additionalOptionPattern?: RegExp;
    }
    ```
  - Claude Code標準形式（❯あり）: `requireDefaultIndicator = true`（デフォルト）
  - Claude Code特殊形式（❯なし）: `requireDefaultIndicator = false`
  - **`requireDefaultIndicator = false`の場合のロジック**:
    - Pass 1 (L274-288): `hasDefaultLine`チェックをスキップ
    - Layer 4 (L344-350): `hasDefaultIndicator`チェックをスキップ（`options.length >= 2`のみで判定）
  - Issue #161で確立された「prompt-detector.tsのCLIツール非依存性」原則を維持。`DetectPromptOptions`はCLIツール固有のパラメータを直接含まず、`requireDefaultIndicator`という汎用フラグとして設計されているため非依存性原則と整合する
  - optionalパラメータのため後方互換性を保持
  - **Issue #161との整合性**: `requireDefaultIndicator = false`の場合でも、Layer 1（thinking skip）とLayer 3（連番検証）は維持される。通常の番号付きリストと選択肢プロンプトの区別は、thinking状態チェック（呼び出し元で実施）と連番検証によって行われる
  - **Codex / Gemini への影響**: `response-poller.ts` L442は全CLIツール共通パスであり、Codex/Geminiのプロンプト検出にも影響する。Codex/Geminiの呼び出し元では`requireDefaultIndicator`のデフォルト値（`true`）を維持し、Claude Codeのコンテキストでのみ`false`を渡す。`response-poller.ts` L498の`checkForResponse(worktreeId, cliToolId)`で`cliToolId`が利用可能であるため、CLIツール種別に基づくoptions構築が可能

**ケースC: 検出ウィンドウの問題の場合**
- `status-detector.ts`のSTATUS_CHECK_LINE_COUNT引き上げ
- `prompt-detector.ts`のSCAN_WINDOW_SIZE調整

### Phase 3: 呼び出し元の修正（Phase 2完了後、ケースBの場合）

パターンパラメータ化（案B）を採用した場合、`detectPrompt()`の呼び出し元を段階的に更新:

- [ ] `src/app/api/worktrees/[id]/prompt-response/route.ts`: CLIツール別パターンをoptions引数で渡す（L50で取得済みのcliToolIdを活用）
- [ ] `src/lib/auto-yes-manager.ts`: `pollAutoYes()`内の`detectPrompt()`にパターンを渡す（L262でcliToolIdを引数として受け取っている）
- [ ] `src/lib/response-poller.ts`:
  - L442: `detectPrompt(fullOutput)`呼び出しを更新。**ANSI未ストリップ問題の修正**: L442では`lines`（`rawLines`から空行トリミングのみ）を`join`しておりANSIコードが残存する。`stripAnsi()`を適用してから`detectPrompt()`に渡すよう修正。**CLIツール別options構築**: L498の`checkForResponse(worktreeId, cliToolId)`で利用可能な`cliToolId`に基づき、Claude Codeの場合は`{ requireDefaultIndicator: false }`、それ以外はデフォルト（`true`）を渡す。
    - **データフロー**: L244のClaude専用ガードでL248の`detectPrompt(stripAnsi(fullOutput))`で検出されなかった場合、またはClaude以外のCLIツール（Codex, Gemini）の場合にL442に到達する。
  - L556: `detectPrompt(result.response)`呼び出しを更新。`result.response`は`extractResponse()`の戻り値であり、`extractResponse()`内部ではstripAnsi()をパターンマッチ判定にのみ使用し（`const cleanLine = stripAnsi(line)`でマッチ判定）、`responseLines.push(line)`では`stripAnsi`前の生の行をpushしている。そのため`result.response`にはANSIコードが残存する。`stripAnsi()`を適用してから`detectPrompt()`に渡すよう修正。
  - L248はClaude専用ガード内で既にstripAnsi()適用済みのため変更不要
- [ ] `src/lib/claude-poller.ts`（到達不能コードだが一貫性のために修正。Issue #180のstage8-issue-body.mdに「startPollingは呼び出されておらず、修正の優先度は低い」と記載されている。将来的にclaude-poller.ts自体の廃止（response-poller.tsへの統合）を別Issueとして検討する）:
  - L164: `extractClaudeResponse()`内の`fullOutput`（`lines.join('\n')`）がANSI未ストリップのまま`detectPrompt()`に渡されている。`stripAnsi()`を適用してから渡すよう修正。
    - **データフロー**: L47-52で`rawLines`から空行トリミング後に`lines`を作成するが、ANSIストリップは行われていない。L163で`lines.join('\n')`した`fullOutput`にはANSIコードが残存する。
  - L232: `detectPrompt(result.response)`呼び出しも同様。`result.response`は`extractClaudeResponse()`の戻り値であり、ANSI未ストリップの`fullOutput`が返される場合がある。`stripAnsi()`を適用してから`detectPrompt()`に渡すよう修正。
- [ ] `src/lib/status-detector.ts`: L87の`detectPrompt()`呼び出しを更新。`detectSessionStatus()`はL77で`cliToolId`を引数として受け取っており、この`cliToolId`を使用して`DetectPromptOptions`を構築し`detectPrompt(lastLines, options)`に渡す。`detectSessionStatus()`のシグネチャ自体は変更不要だが、内部ロジックの修正が必要
- [ ] `src/app/api/worktrees/[id]/current-output/route.ts`: L88の`detectPrompt()`呼び出しを更新。thinkingガード内にあるため、thinking時は`detectPrompt()`がスキップされる。`cliToolId`はL40でクエリパラメータまたは`worktree.cliToolId`から取得済みであり（`const cliToolId: CLIToolType = isCliTool(cliToolParam) ? cliToolParam : (worktree.cliToolId || 'claude')`）、options引数の構築に利用する。

### Phase 4: テスト追加・既存テスト更新（Phase 3完了後）

- [ ] `tests/unit/prompt-detector.test.ts`: スクリーンショットの形式に基づく選択肢検出テスト追加
- [ ] 既存の`prompt-detector.test.ts`の全`multiple_choice`テストケースがパスすることを確認（リグレッションテスト）
- [ ] 新規リグレッションテスト: 既存の❯ (U+276F) マーカー付き選択肢パターンが引き続き正しく検出されることを確認するテストを追加
- [ ] 既存テストファイルのモック修正（ケースBの場合）:
  - `tests/unit/lib/auto-yes-manager.test.ts`（L431でdetectPromptをモック）: `vi.fn()`はoptionalパラメータ追加に対して引数の数に依存しないため、モック定義自体は変更不要。L451-459のテストでは`sendKeys`呼び出し有無で動作を検証しており、`detectPrompt`の`toHaveBeenCalledWith()`アサーションは使用されていない。そのため既存テストは変更不要。新パターン（`requireDefaultIndicator: false`）でのpollAutoYes動作テストを追加する場合は、`detectPrompt`のモック戻り値を`isDefault: false`の選択肢パターンに設定し、`sendKeys`が正しく呼ばれることを検証する
  - `tests/unit/api/prompt-response-verification.test.ts`（L50, L112, L141でdetectPromptをモック）: 同上。`vi.fn().mockReturnValue(...)`のモック定義は引数の数に依存しないため変更不要。`toHaveBeenCalledWith()`アサーションのみ確認・更新
- [ ] `tests/unit/lib/auto-yes-resolver.test.ts`: 全選択肢が`isDefault: false`の場合に`resolveAutoAnswer()`が最初の選択肢（`options[0]`）を選択する動作のテストケースが既存か確認し、なければ追加

### Phase 5: 動作検証（Phase 4完了後）

- [ ] 動作検証: UI手動送信、Auto-Yesモードの両方で確認
- [ ] スクリーンショットと同じシナリオで再現・解消を確認
- [ ] UIコンポーネントの動作確認: ケースBで全選択肢が`isDefault: false`になった場合の表示確認（PromptPanel.tsx、MobilePromptSheet.tsx、PromptMessage.txのデフォルトハイライト表示が消失しないか確認）

## 受入条件

- [ ] Claude Codeの複数選択肢にUIから番号を入力して回答を送信できること
- [ ] Auto-YesモードでClaude Codeの選択肢に自動応答されること
  - デフォルト選択（❯マーカー）が検出できる場合はデフォルトを選択
  - デフォルト選択がない場合は最初の選択肢を選択（現行ロジック維持）
- [ ] Claude Codeの既存の選択肢検出・応答機能（❯マーカー付き標準形式）に影響がないこと
- [ ] Claude Code選択肢表示時のサイドバーステータスが正しく'waiting'（黄色）になること
- [ ] ユニットテストが追加されていること
- [ ] 既存の`prompt-detector.test.ts`の全`multiple_choice`テストケースがパスすること（リグレッション確認）
- [ ] 新規リグレッションテスト: 既存の❯マーカー付き選択肢パターンの検出が維持されることを確認するテストが追加されていること
- [ ] 既存テストがすべてパスすること
- [ ] `detectPrompt()`を呼び出す全箇所（計9箇所）でANSI未ストリップの生出力が渡されていないこと
- [ ] 既存テストのモック定義が新シグネチャに対応していること（`toHaveBeenCalledWith`アサーションの更新含む）

## 影響範囲

### 変更対象ファイル

| ファイル | 変更内容 |
|---------|---------|
| `src/lib/prompt-detector.ts` | `detectMultipleChoicePrompt()`の修正: `DEFAULT_OPTION_PATTERN` (L182) / `NORMAL_OPTION_PATTERN` (L189) の調整（ケースA）、または `DetectPromptOptions` interface定義・`detectPrompt(output, options?)`シグネチャ変更（ケースB）。ケースBでは Pass 1 (L274-288) と Layer 4 (L344-350) の両方に `requireDefaultIndicator` パラメータを適用 |
| `src/app/api/worktrees/[id]/prompt-response/route.ts` | `detectPrompt()`呼び出しの修正（ケースBの場合） |
| `src/lib/auto-yes-manager.ts` | `pollAutoYes()`内の`detectPrompt()`修正（ケースBの場合） |
| `src/lib/response-poller.ts` | L442: `stripAnsi()`適用追加 + `detectPrompt()`修正（CLIツール別options構築含む）。L556: 同様。L248はClaude専用ガード内でstripAnsi()適用済みのため変更不要 |
| `src/lib/claude-poller.ts` | L164: `stripAnsi()`適用追加 + `detectPrompt()`修正。L232: 同様。**注: 到達不能コード（startPollingは呼び出されていない）。一貫性のための修正であり優先度は低い（Issue #180 stage8-issue-body.md参照）。将来的にclaude-poller.ts自体の廃止（response-poller.tsへの統合）を別Issueとして検討** |
| `src/lib/status-detector.ts` | L87の`detectPrompt()`修正（ケースBの場合）。`detectSessionStatus()`の内部ロジックを修正し、受け取った`cliToolId`からDetectPromptOptionsを構築して`detectPrompt(lastLines, options)`に渡す。`detectSessionStatus()`のシグネチャ自体は変更不要。STATUS_CHECK_LINE_COUNT引き上げ検討（ケースCの場合） |
| `src/app/api/worktrees/[id]/current-output/route.ts` | L88の`detectPrompt()`修正（ケースBの場合）。thinkingガード内のためoptions伝搬時にcliToolId（L40でクエリパラメータまたはworktree.cliToolIdから取得済み）を活用 |
| `tests/unit/prompt-detector.test.ts` | 選択肢検出テスト追加、❯マーカー付きパターンのリグレッションテスト追加 |
| `CLAUDE.md` | Issue #193の概要セクションを「最近の実装機能」に追加。`prompt-detector.ts`の`DetectPromptOptions` interface追加と`detectPrompt()`シグネチャ変更を主要機能モジュールテーブルに反映。Issue #161セクションの「CLIツール非依存性」原則との整合性記載 |

> **注**: 旧Issue本文で変更対象に含めていた `src/lib/cli-patterns.ts` は、選択肢パターンが定義されていないため変更対象から除外。選択肢パターンは `prompt-detector.ts` 内の `DEFAULT_OPTION_PATTERN` / `NORMAL_OPTION_PATTERN` に定義されている。

### 間接影響ファイル（コード変更不要、検出精度向上の恩恵）

| ファイル | 影響内容 |
|---------|---------|
| `src/app/api/worktrees/route.ts` L58 | `detectSessionStatus()`経由で`detectPrompt()`を間接呼び出し（サイドバーステータス表示）。`detectSessionStatus()`のシグネチャは変更なしのためこのファイルの修正は不要。`detectPrompt()`の検出精度向上の恩恵を受ける |
| `src/app/api/worktrees/[id]/route.ts` L58 | 上記と同様。ワークツリー詳細ステータス表示。`detectSessionStatus()`経由の間接影響 |
| `src/lib/auto-yes-resolver.ts` L23-36 | `resolveAutoAnswer()`は`PromptData.options[].isDefault`フラグに依存。ケースBで全選択肢が`isDefault: false`になった場合、`options[0]`にフォールバック（期待動作）。コード変更不要だが動作確認必要 |
| `src/app/api/worktrees/[id]/respond/route.ts` L12 | `getAnswerInput()`のみインポート。`detectPrompt()`への直接依存なし。選択肢応答の間接フローとして動作確認が必要 |
| `src/components/worktree/PromptPanel.tsx` | `PromptData`のUI描画コンポーネント。`isDefault`フラグの視覚的表現が影響を受ける可能性あり（全選択肢が`isDefault: false`の場合のデフォルトハイライト消失） |
| `src/components/mobile/MobilePromptSheet.tsx` | モバイル版`PromptData` UI。`PromptPanel.tsx`と同様の間接影響 |
| `src/components/worktree/PromptMessage.tsx` | 既回答済みプロンプトの選択肢描画。`isDefault`フラグの表示に影響する可能性 |
| `src/hooks/useAutoYes.ts` | クライアント側Auto-Yesフック。`resolveAutoAnswer()`経由の間接影響。重複応答防止ロジックの動作確認が必要 |

### 既存テストファイルの更新（シグネチャ変更時、ケースBの場合）

| ファイル | 更新理由 | 具体的な修正方針 |
|---------|---------|----------------|
| `tests/unit/lib/auto-yes-manager.test.ts` | L431でdetectPromptをモック - 新シグネチャ対応 | `vi.fn()`のモック定義は変更不要。L451-459のテストではsendKeys呼び出し有無で動作を検証しており、detectPromptのtoHaveBeenCalledWithアサーションは使用されていない。既存テストは変更不要。新パターン（`requireDefaultIndicator: false`）のテスト追加時はdetectPromptモック戻り値を`isDefault: false`の選択肢パターンに設定し、sendKeysが正しく呼ばれることを検証する |
| `tests/unit/api/prompt-response-verification.test.ts` | L50, L112, L141でdetectPromptをモック - 同上 | 同上。`vi.fn().mockReturnValue(...)`は引数の数に依存しないため定義自体は変更不要。`toHaveBeenCalledWith()`アサーションのみ確認・更新 |
| `tests/unit/lib/auto-yes-resolver.test.ts` | 全選択肢が`isDefault: false`の場合のフォールバック動作テスト | 既存テストケースに「全選択肢が`isDefault: false`の場合は`options[0]`を選択する」テストが存在するか確認し、なければ追加 |

### テスト影響範囲（確認が必要なファイル）

| ファイル | 影響内容 | 変更要否 |
|---------|---------|---------|
| `tests/unit/prompt-detector.test.ts` | 新規テスト追加。既存テストは`options`未指定のデフォルト動作テストとして機能する。変更不要だがパス確認必須 | 追加のみ |
| `tests/unit/lib/auto-yes-manager.test.ts` | L431のdetectPromptモック。L451-459ではsendKeys呼び出し有無で検証しておりtoHaveBeenCalledWithアサーションは未使用。既存テストは変更不要 | パス確認のみ |
| `tests/unit/api/prompt-response-verification.test.ts` | L50, L112, L141のdetectPromptモック。`toHaveBeenCalledWith()`アサーションの更新が必要な場合あり | 確認・更新 |
| `tests/unit/lib/auto-yes-resolver.test.ts` | `isDefault: false`フォールバック動作のテストケース確認・追加 | 確認・追加 |
| `tests/integration/api-prompt-handling.test.ts` | auto-yes-manager.tsまたはprompt-response/route.tsの結合テスト。detectPromptの直接モック使用はないが、シグネチャ変更後の統合動作確認が必要 | パス確認のみ |
| `tests/integration/auto-yes-persistence.test.ts` | auto-yes-manager.tsの永続化テスト。detectPromptの直接モック使用はないが、シグネチャ変更後の統合動作確認が必要 | パス確認のみ |
| `src/lib/__tests__/status-detector.test.ts` | `detectSessionStatus()`のテスト。内部で`detectPrompt()`を呼び出すため、新パターンの統合テストとしても機能。既存テストのパス確認必須 | パス確認 |

### ドキュメント影響範囲

| ファイル | 影響内容 | 変更要否 |
|---------|---------|---------|
| `CLAUDE.md` | Issue #193の概要セクション追加、`prompt-detector.ts`の`DetectPromptOptions` interface記載、Issue #161「CLIツール非依存性」原則との整合性記載 | Phase 4完了後に更新 |
| `docs/internal/PROMPT_HANDLING_IMPLEMENTATION_PLAN.md` | L459, L964のdetectPrompt()コード例が旧シグネチャのまま。別Issue（フォローアップ）で対応を検討 | フォローアップ |

### 関連コンポーネント（動作確認）

- `src/lib/auto-yes-resolver.ts` - 自動応答判定のClaude Code動作確認（isDefaultフラグの挙動検証。全選択肢がisDefault: falseの場合は最初の選択肢を選択する現行ロジックの動作確認）
- `src/app/api/worktrees/[id]/respond/route.ts` - メッセージIDベースのプロンプト応答API（detectPrompt()への直接依存はないが、選択肢応答がprompt-response/route.tsとは異なるフローでルーティングされるため、間接的な動作確認が必要）
- `src/components/worktree/PromptPanel.tsx` - 選択肢UI描画コンポーネント（isDefaultフラグの視覚的表現の確認）
- `src/components/worktree/MobilePromptSheet.tsx` - モバイル版選択肢UI（同上）
- `src/components/worktree/PromptMessage.tsx` - 既回答済みプロンプトの選択肢描画
- `src/hooks/useAutoYes.ts` - クライアント側Auto-Yesフック（重複応答防止の動作検証）

### 関連Issue

- Issue #161: Auto-Yes誤検出修正（2パス❯検出方式、prompt-detector.tsのCLIツール非依存性、多層防御: Layer 1 thinking skip, Layer 2 2-pass detection, Layer 3 consecutive validation）
- Issue #138: サーバー側Auto-Yesポーリング
- Issue #180: ステータス表示の不整合修正（status-detector.ts共通化、claude-poller.tsの到達不能コード判定）

## レビュー履歴

### 初版 (2026-02-08)
- 初回作成（対象CLIツールをCodex CLIと誤記）

### 修正版 (2026-02-08)
- 対象CLIツールの根本的な誤りを修正: Codex CLI → Claude Code
- Codex固有の記述（TUI調査、codex.ts参照、Down arrow+Enter操作等）を全面削除
- 根本原因の仮説をClaude Code文脈に修正（❯マーカーの有無に着目した3ケース分析）
- 対策案をPhase 1（前提条件確認）の調査結果に基づく条件分岐型に再構成
- 影響範囲テーブルを簡素化（ケース依存の変更を明記）

### Stage 1レビュー反映 (2026-02-08)
- MF-1: `CLAUDE_CHOICE_INDICATOR_PATTERN`（コードベースに存在しない）への参照を全て削除。選択肢パターンは`prompt-detector.ts`内の`DEFAULT_OPTION_PATTERN`/`NORMAL_OPTION_PATTERN`であることを明記。変更対象ファイルから`cli-patterns.ts`を除外
- MF-2: Layer 4 (`hasDefaultIndicator`チェック) が根本原因分析から欠落していた問題を修正。Pass 1とLayer 4の両方が独立したゲートであり、両方の修正が必要であることを処理フローと対策案に明記
- MF-3: `response-poller.ts`のANSI未ストリップ問題の記述を修正。L248のClaude専用ガード内ではstripAnsi()適用済み、L442到達条件の正確なデータフロー分析を記載
- SF-1: `DetectPromptOptions`の`requireDefaultIndicator`がPass 1とLayer 4の両方に影響する設計を明確化（TypeScript interface定義とJSDocコメントを追加）
- SF-2: `claude-poller.ts` L164/L232のANSI未ストリップ問題を変更対象ファイルテーブルに昇格（フォローアップ候補→本Issue対象）
- SF-3: 受入条件にリグレッションテスト要件を具体化（prompt-detector.testの全multiple_choiceテストパス、❯マーカー付きパターンのリグレッションテスト追加）
- SF-4: `current-output/route.ts`のthinkingガード内でのoptions伝搬方法を記載（cliToolIdがworktree.cliToolIdから取得済みであることを明記）
- NTH-1: `respond/route.ts`の動作確認目的を明記（detectPrompt()への直接依存がない間接フローの確認）
- NTH-2: Phase 1の調査項目にスクリーンショットのテキスト形式の正確な記録を追加
- NTH-3: ケースBの設計にIssue #161多層防御との整合性説明を追加（Layer 1/3は維持される）

### Stage 3レビュー反映（影響範囲）(2026-02-08)
- MF-1: `status-detector.ts`経由の間接依存を影響範囲に追加。`detectSessionStatus()`の呼び出し元（`worktrees/route.ts` L58、`worktrees/[id]/route.ts` L58）を間接影響テーブルに記載。`status-detector.ts`内部で`cliToolId`から`DetectPromptOptions`を構築して`detectPrompt()`に渡す設計を明記
- MF-2: 既存テストのモック定義とシグネチャ変更の具体的な修正方針を記載。`vi.fn()`のモック定義は引数の数に依存しないため変更不要、`toHaveBeenCalledWith()`アサーションの更新例を具体的に追加。テスト影響範囲テーブルに修正方針カラムを追加
- SF-1: `claude-poller.ts`が到達不能コード（startPollingは呼び出されていない）であることを変更対象ファイルテーブルと呼び出し箇所リストに明記。Issue #180 stage8-issue-body.mdとの整合性を記載。将来的な廃止を別Issueとして検討する旨を追加
- SF-2: `tests/unit/lib/auto-yes-resolver.test.ts`をテスト影響範囲テーブルと既存テストファイル更新テーブルに追加。全選択肢が`isDefault: false`の場合のフォールバック動作テストの確認・追加を記載
- SF-3: `tests/integration/api-prompt-handling.test.ts`と`tests/integration/auto-yes-persistence.test.ts`をテスト影響範囲テーブルに追加。detectPromptのモック使用状況の確認が必要である旨を記載
- SF-4: `CLAUDE.md`を変更対象ファイルテーブルに追加。Issue #193概要の「最近の実装機能」セクション追加、`DetectPromptOptions` interface記載、Issue #161「CLIツール非依存性」原則との整合性記載を明記。ドキュメント影響範囲テーブルを新設
- NTH-1: Phase 5の動作検証にUIコンポーネントの`isDefault: false`時の表示確認を追加。間接影響ファイルテーブルにPromptPanel/MobilePromptSheet/PromptMessageの影響を記載
- NTH-2: ケースBの設計にCodex/Geminiへの影響分析を追加（response-poller.ts L442の全CLIツール共通パス、cliToolIdベースのoptions構築）
- NTH-3: ドキュメント影響範囲テーブルに`PROMPT_HANDLING_IMPLEMENTATION_PLAN.md`の旧シグネチャコード例をフォローアップ対象として記載

### Stage 5レビュー反映（2回目通常レビュー）(2026-02-08)
- SF-NEW-1: `current-output/route.ts`のcliToolId取得箇所を「L66付近で`worktree.cliToolId`から取得」から「L40でクエリパラメータまたは`worktree.cliToolId`から取得」に修正。Phase 3と変更対象ファイルテーブルの両方を更新
- SF-NEW-2: テスト影響範囲テーブルの`tests/integration/api-prompt-handling.test.ts`と`tests/integration/auto-yes-persistence.test.ts`の影響内容を修正。detectPromptの直接モック使用はないことを明記し、変更要否を「要確認」から「パス確認のみ」に変更
- NTH-NEW-1: detectPrompt()呼び出し箇所リストを直接呼び出し（8箇所）と間接呼び出し（1箇所: status-detector.ts経由）に分類して構造を明確化
- NTH-NEW-2: `auto-yes-manager.test.ts`の修正方針を精度向上。L451-459ではsendKeys呼び出し有無で検証しておりtoHaveBeenCalledWithアサーションは未使用であることを明記。既存テストファイル更新テーブルとテスト影響範囲テーブルの両方を更新
- NTH-NEW-3: response-poller.ts L556の`extractResponse()`データフロー説明を精度向上。内部でstripAnsi()がパターンマッチ判定にのみ使用され、`responseLines.push(line)`ではstripAnsi前の生の行がpushされることを正確に記述