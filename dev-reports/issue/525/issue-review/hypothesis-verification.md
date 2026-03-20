# Issue #525 仮説検証レポート

## 検証日時
- 2026-03-20

## 検証結果サマリー

| # | 仮説/主張 | 判定 | 根拠 |
|---|----------|------|------|
| 1 | 現在のauto-yesはworktree単位の単一トグル | Rejected | auto-yes-state.ts: MapキーはworktreeIdのみだが、ポーラー側はcliToolIdを保持。「単一トグル」ではなく「キー設計の非対称性」が実態 |
| 2 | APIは既にcliToolIdパラメータを受け付けている | Confirmed | auto-yes/route.ts L156-158: body.cliToolIdを読み込み済み |
| 3 | ポーラーは既にエージェント単位でcliToolIdを追跡 | Confirmed | auto-yes-poller.ts L48-52: AutoYesPollerStateにcliToolIdフィールド存在 |
| 4 | CLIコマンドは既にエージェント指定に対応済み | Confirmed | auto-yes.ts L23: --agentオプション定義済み |
| 5 | UIフックは既にcliToolパラメータを受け取っている | Confirmed | useAutoYes.ts L28: cliTool: stringパラメータ |
| 6 | auto-yes状態管理のキーがworktreeId単位 | Confirmed | auto-yes-state.ts L57-58: Map<string, AutoYesState>キーはworktreeId |
| 7 | ポーラー状態のキーがworktreeId単位 | Confirmed | auto-yes-poller.ts L81-86: Map<string, AutoYesPollerState>キーはworktreeId |

## 詳細検証

### 仮説#1：Auto-Yes状態管理の粒度（Rejected）

**Issue内の記述**: 「現在のauto-yesはworktree単位の単一トグルで、1つのworktreeに対して1つの設定しか持てない」

**検証手順**:
1. `src/lib/auto-yes-state.ts` L57-58: `autoYesStates = Map<string, AutoYesState>`
2. `AutoYesState`インターフェイス（L21-32）にcliToolIdフィールドがない
3. `setAutoYesEnabled`（L105-126）にcliToolIdパラメータがない

**判定**: Rejected

**根拠**: 「単一トグル」という表現は不正確。実態は：
- 状態管理側（auto-yes-state.ts）: worktreeId単位でcliToolIdを保持しない
- ポーラー側（auto-yes-poller.ts）: 各ポーラー状態は1つのcliToolIdを保持（L52）
- API層：cliToolIdを受け取るが、setAutoYesEnabledに渡していない（L160-165）
- 同じworktreeIdで異なるcliToolIdのリクエストが来ると、状態は上書きされる

### 仮説#2-5：API・ポーラー・フック・CLI（すべてConfirmed）

各層で既にcliToolIdの概念は導入済み：
- API: `body.cliToolId`読み込み、`startAutoYesPolling(params.id, cliToolId)`に渡す
- ポーラー: `AutoYesPollerState.cliToolId`フィールド存在
- CLI: `--agent`オプション→`body.cliToolId`に設定
- UIフック: `cliTool`パラメータ受け取り

### 仮説#6-7：キー設計（Confirmed）

両MapともworktreeId単位のキーで管理。

## Stage 1レビューへの申し送り事項

1. **キー設計の非対称性**: ポーラーはcliToolIdを保持するが、状態管理はcliToolIdを保持しない。複合キー化が必須。
2. **API層での上書き動作**: `setAutoYesEnabled`にcliToolIdを渡していないため、異なるエージェントのリクエストで上書きされる。
3. **ポーラー開始時の排他動作**: 新cliToolIdでリクエスト時、既存ポーラーを停止して上書き（L552-554）。複数同時ポーリング未対応。
4. **依存関係の確認**: プロンプト検出のエージェント別対応、DB永続化設計、UI状態表示の検討が必要。
