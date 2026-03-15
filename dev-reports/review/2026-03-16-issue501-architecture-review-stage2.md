# Architecture Review: Issue #501 - Stage 2 整合性レビュー

| 項目 | 内容 |
|------|------|
| Issue | #501 Auto-Yesサーバー/クライアント二重応答とポーラー再作成によるステータス不安定 |
| Stage | 2 - 整合性レビュー |
| 日付 | 2026-03-16 |
| 対象 | dev-reports/design/issue-501-auto-yes-dual-response-fix-design-policy.md |

## サマリ

| 重要度 | 件数 |
|--------|------|
| must_fix | 3 |
| should_fix | 3 |
| nice_to_have | 4 |
| **合計** | **10** |

## must_fix (3件)

### DR2-001: CurrentOutputResponse型にlastServerResponseTimestampフィールドが未定義

**場所**: 設計書セクション3.1 / `src/components/worktree/WorktreeDetailRefactored.tsx` L116-L132

設計書ではデータフローとして「CurrentOutputResponse型に型追加」と記載しているが、現在のCurrentOutputResponse型(L116-L132)にはlastServerResponseTimestampフィールドが存在しない。APIレスポンス側(current-output/route.ts L139)では既にフィールドを返却しているため、クライアント側型定義の欠落が問題の本質である。

設計書は「対策1」としてこの修正を認識しているが、具体的な型定義(`lastServerResponseTimestamp?: number | null`)を明記すべきである。

### DR2-002: useAutoYes呼び出しでlastServerResponseTimestampが渡されていない(具体的変更箇所の記載不足)

**場所**: 設計書セクション4, セクション9 / `src/components/worktree/WorktreeDetailRefactored.tsx` L961-L967, L352-L398

設計書のデータフローでは「useAutoYes({ ..., lastServerResponseTimestamp }) に渡す」と記載。useAutoYes.tsのUseAutoYesParams型は既にlastServerResponseTimestampをオプショナルパラメータとして受け入れ可能(L36)。しかし実際のuseAutoYes呼び出し(L961-L967)では渡されていない。

設計書の変更ファイル一覧には「useState追加、useAutoYes引数追加」と書かれているが、fetchCurrentOutput()内でのsetState呼び出し追加(data.lastServerResponseTimestampの保存)が具体的に記述されていない。実装者が迷わないよう具体的な変更箇所を明記すべきである。

### DR2-003: startAutoYesPolling()の冪等化差分が不明確

**場所**: 設計書セクション3.2 / `src/lib/auto-yes-poller.ts` L469-L516

設計書の「Before/After」比較は概念的に正確だが、具体的な実装差分が不明確である。現在のコード(L486-L494)ではexistingPollerがある場合に無条件でstopAutoYesPolling()を呼び出し、新規作成する。冪等化するにはL492の条件分岐にcliToolId比較を追加する必要があるが、設計書にはこの具体的な変更箇所が記載されていない。

**推奨変更**: L492のif (existingPoller)ブロック内でgetPollerState(worktreeId)?.cliToolIdとリクエストのcliToolIdを比較し、一致する場合は`{ started: true, reason: 'already_running' }`を返却する。

## should_fix (3件)

### DR2-004: detectSessionStatus()のlastOutputTimestamp型(Date)とlastServerResponseTimestamp型(number)の不一致が未記載

**場所**: 設計書セクション3.3 / `src/lib/detection/status-detector.ts` L152-L156, `src/lib/auto-yes-poller.ts` L125-L128

detectSessionStatus()の第3引数は`lastOutputTimestamp?: Date`(Date型)。getLastServerResponseTimestamp()の戻り値は`number | null`(Date.now()のミリ秒値)。設計書のセマンティックギャップに関する議論(セクション3.3)は概念的差異を論じているが、TypeScript型の実際の不一致(number -> Dateへの変換が必要)には言及していない。

**推奨**: 呼び出し側で`new Date(timestamp)`による型変換が必要であることを設計書に明記する。

### DR2-005: worktree-status-helper.tsの変更内容に型変換記述が必要

**場所**: 設計書セクション9 / `src/lib/session/worktree-status-helper.ts` L91

現在のworktree-status-helper.ts L91ではdetectSessionStatus(output, cliToolId)を2引数で呼び出しており、auto-yes-managerからのimportも存在しない。設計書の変更予定記載は正しいが、DR2-004と同様に型変換の必要性を含めるべきである。

### DR2-006: current-output/route.tsの変更内容に型変換記述が必要

**場所**: 設計書セクション9 / `src/app/api/worktrees/[id]/current-output/route.ts` L86, L111

current-output/route.ts L86ではdetectSessionStatus(output, cliToolId)を2引数で呼び出し、L111ではgetLastServerResponseTimestamp(params.id)の値を取得済みだが、detectSessionStatus()に渡していない。変更は容易だが、null -> undefinedの変換とnumber -> Date変換の具体的記載が望ましい。

## nice_to_have (4件)

### DR2-007: 「API設計: 変更なし」記述の精度

設計書セクション5の「変更なし」は形式的には正確だが、対策3によりステータス判定結果が変化しうることへの注記があると親切である。

### DR2-008: STALE_OUTPUT_THRESHOLD_MS = 5000ms (確認済み - 問題なし)

status-detector.ts L134の定数値が設計書記載と一致することを確認。

### DR2-009: AutoYesPollerState型の整合性 (確認済み - 問題なし)

auto-yes-poller.ts L42-L59のAutoYesPollerState interfaceが設計書記載と一致することを確認。lastServerResponseTimestamp(L52)およびcliToolId(L46)フィールドが存在する。

### DR2-010: auto-yes-manager.tsバレルファイルの再エクスポート (確認済み - 問題なし)

auto-yes-manager.ts L48でgetLastServerResponseTimestampが再エクスポートされていることを確認。設計書のimportパス記載は正確。

## 検証済み項目チェックリスト

| 検証項目 | 結果 | 備考 |
|----------|------|------|
| startAutoYesPolling()シグネチャ | 一致 | (worktreeId: string, cliToolId: CLIToolType): StartPollingResult |
| AutoYesPollerState型フィールド | 一致 | 7フィールド全て設計書と一致 |
| auto-yes-managerバレルファイル | 一致 | getLastServerResponseTimestamp再エクスポート確認 |
| useAutoYes.tsのlastServerResponseTimestampパラメータ | 一致 | UseAutoYesParams L36に定義済み(オプショナル) |
| detectSessionStatus()第3引数 | 型不一致発見 | 設計書: timestamp概念 / 実装: Date型 (DR2-004) |
| STALE_OUTPUT_THRESHOLD_MS | 一致 | 5000ms (status-detector.ts L134) |
| CurrentOutputResponse型 | 欠落発見 | lastServerResponseTimestampフィールド未定義 (DR2-001) |
| worktree-status-helper.ts現状 | 確認済み | detectSessionStatus 2引数呼び出し、auto-yes-manager import なし |
