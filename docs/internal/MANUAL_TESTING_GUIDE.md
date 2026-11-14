[English](../en/internal/MANUAL_TESTING_GUIDE.md)

# Manual Testing Guide - Prompt Handling Feature

This guide explains how to manually test the interactive prompt handling feature (Phase 1: Yes/No prompts).

## Prerequisites

1. **Database Migration**: Ensure the database migration has been applied:
   ```bash
   npx tsx scripts/init-and-migrate.ts
   ```

2. **Server Running**: Start the development server:
   ```bash
   npm run dev
   ```
   The server should start on http://localhost:3000

3. **Claude CLI**: Have Claude CLI installed and available in your PATH:
   ```bash
   claude --version
   # Should show: claude-cli v2.0.42 or higher
   ```

## Test Scenario 1: Basic Yes/No Prompt

### Setup
1. Create a test worktree using the UI or via git:
   ```bash
   cd /path/to/your/repo
   git worktree add ../test-prompt-feature test-prompt-feature
   ```

2. Open the MyCodeBranchDesk UI in your browser:
   ```
   http://localhost:3000
   ```

3. Navigate to the test worktree detail page

### Test Steps

#### Step 1: Send a message that triggers a prompt
Send the following message to Claude:
```
Please create a new file called test.txt with the content "Hello World"
```

Claude should respond with something like:
```
Would you like me to create this file? (y/n)
```

#### Step 2: Verify prompt detection
- **Expected**: The prompt should be displayed with:
  - ⚠️ Yellow background card
  - "Claudeからの確認" header
  - Question text: "Would you like me to create this file?"
  - Two buttons: "Yes" and "No"
  - Status: Pending (buttons enabled)

#### Step 3: Answer "Yes"
- Click the "Yes" button
- **Expected**:
  - Loading indicator appears ("送信中...")
  - Buttons become disabled
  - After ~1 second, the prompt card updates to show:
    - "✅ 回答済み: yes"
    - Buttons are replaced with answered status
  - Claude continues execution in the background
  - A new Claude response appears with the result

#### Step 4: Verify database persistence
Check the database to verify the prompt was saved correctly:
```bash
sqlite3 mcbd.db
SELECT id, message_type, prompt_data FROM chat_messages WHERE message_type = 'prompt' ORDER BY timestamp DESC LIMIT 1;
```

**Expected output** (formatted):
```json
{
  "type": "yes_no",
  "question": "Would you like me to create this file?",
  "options": ["yes", "no"],
  "status": "answered",
  "answer": "yes",
  "answeredAt": "2025-01-17T..."
}
```

## Test Scenario 2: Answering "No"

### Test Steps
1. Send a message that triggers a destructive operation:
   ```
   Delete all .log files in this directory
   ```

2. Claude should ask for confirmation:
   ```
   This will delete X files. Are you sure? (yes/no)
   ```

3. Click the "No" button

4. **Expected**:
   - Prompt updates to show "回答済み: no"
   - Claude receives "n" and stops the operation
   - Claude responds with something like "Operation cancelled"

## Test Scenario 3: Multiple Prompts

### Test Steps
1. Send a complex request that requires multiple confirmations:
   ```
   Create a new feature branch, make some changes, and push to remote
   ```

2. Claude may ask multiple prompts:
   - "Create new branch feature-xyz?" (y/n)
   - "Push to remote?" (y/n)

3. Answer each prompt in sequence

4. **Expected**:
   - Each prompt appears one at a time
   - Previous prompts show "回答済み" status
   - Current prompt shows interactive buttons
   - System handles sequential prompts correctly

## Test Scenario 4: WebSocket Real-time Updates

### Setup
1. Open the same worktree detail page in two browser tabs

### Test Steps
1. In Tab 1: Send a message that triggers a prompt
2. In Tab 2: Observe the UI

3. **Expected**:
   - The prompt appears in both tabs immediately (via WebSocket)
   - Answer the prompt in Tab 1
   - Tab 2 should update to show "回答済み" status without refresh

## Test Scenario 5: Error Handling

### Test 5a: Network Error
1. Stop the backend server: `pkill -f "tsx server.ts"`
2. Try to answer a pending prompt
3. **Expected**: Error alert "応答の送信に失敗しました。もう一度お試しください。"

### Test 5b: Already Answered
1. Answer a prompt successfully
2. Try to answer it again via API (using curl or Postman):
   ```bash
   curl -X POST http://localhost:3000/api/worktrees/test-worktree/respond \
     -H "Content-Type: application/json" \
     -d '{"messageId": "message-id-here", "answer": "yes"}'
   ```
3. **Expected**: 400 error "Prompt already answered"

## Test Scenario 6: Pattern Detection

Test all 5 prompt patterns to ensure they're detected correctly:

### Pattern 1: (y/n)
Send: `Create a backup? (y/n)`
**Expected**: Detected as yes/no prompt

### Pattern 2: [y/N]
Send: `Overwrite existing file? [y/N]`
**Expected**: Detected with default option "no"

### Pattern 3: [Y/n]
Send: `Install dependencies? [Y/n]`
**Expected**: Detected with default option "yes"

### Pattern 4: (yes/no)
Send: `Delete this permanently? (yes/no)`
**Expected**: Detected as yes/no prompt

### Pattern 5: Approve?
Send:
```
I will run the following command:
  rm -rf /tmp/cache
Approve?
```
**Expected**: Detected as yes/no prompt

## Test Scenario 7: Polling Behavior

### Test Steps
1. Send a message to Claude that takes time to process
2. Observe the browser's Network tab (WebSocket connection)
3. **Expected**:
   - Polling starts after sending message
   - Polling stops when prompt is detected
   - Polling resumes after answering prompt
   - Polling stops when final response is received

## Verification Checklist

After completing all test scenarios, verify:

- [ ] Prompts are detected correctly for all 5 patterns
- [ ] UI displays prompts with yellow theme and buttons
- [ ] "Yes" button sends "y" to tmux
- [ ] "No" button sends "n" to tmux
- [ ] Prompt status updates to "answered" after response
- [ ] Database stores prompt data correctly
- [ ] WebSocket broadcasts updates to all connected clients
- [ ] Polling stops when prompt detected
- [ ] Polling resumes after answering
- [ ] Error messages display correctly
- [ ] Multiple prompts in sequence work correctly
- [ ] Already-answered prompts show correct status
- [ ] Case-insensitive input works (YES, yes, Y, y all accepted)

## Known Limitations (Phase 1)

- Only yes/no prompts are supported (no multiple choice or text input)
- Prompts must match one of the 5 defined patterns
- Nested or complex prompts may not be detected correctly
- Timeout after 5 minutes of polling (may miss very long-running operations)

## Troubleshooting

### Prompt not detected
- Check tmux output: `tmux capture-pane -t mcbd-worktree-name -p -S -100`
- Verify the prompt matches one of the 5 patterns
- Check server logs for detection errors

### Response not sent to Claude
- Verify tmux session is running: `tmux list-sessions`
- Check server logs for tmux send-keys errors
- Verify session name format: `mcbd-{worktree-id}`

### WebSocket not working
- Check browser console for WebSocket errors
- Verify server is running and accessible
- Check that port 3000 is not blocked by firewall

## 実機の UAT の罠

### 検出の修正は空虚な合格に注意する

- 「修正後に偽の行が保存されなかった」は、修正前も保存されなかったなら証拠にならない。刺激が修正した判定まで届いたかを、`CM_LOG_LEVEL=debug` のログ（その判定自身のログの行）で確かめる。
- 決定的な証拠は、保存済みの実フレームを出荷のコードに通すオフラインの再現で取る（クォータを使わない）。prompt の行の `content` にはペインの末尾が残るので、本番の DB を `mode=ro` で開いて対象の行を取り出す。

  ```ts
  const det = detectPrompt(stripBoxDrawing(stripAnsi(raw)), buildDetectPromptOptions('claude'));
  ```

  `npx tsx --tsconfig <worktree>/tsconfig.json <script>.ts` で `@/` が解決する（`.mts` は export を解決できない）。Auto-Yes と同じ結果を見るには `stripBoxDrawing` を通す（箱の枠のダイアログは素のままだと `isPrompt=false`）。本物のダイアログが残ることを陽性対照として必ず並べる（何でも棄却しているだけでないことを示す）。
- 実機のターンは、再現で示せない経路（実ペインを実 poller が読む経路など）にだけ使い、刺激を候補が生じる形（質問の行と番号の選択肢）にする。
- ターンの完了は画面の `❯` の文字の一致で判定しない（送った本文がエコーされた行に当たる）。DB の assistant の行が出たことで見る。ペインの grep も、自分の依頼文に含まれる語に当たるので、着手の判定に使わない。

### 入力欄と配置の UAT

- 入力欄や本文の配置を変える UAT は、高さ・面積の数字だけで合格にしない。3〜5 行の文を実際に入力し、入力できる幅と道具の位置をスクリーンショットで見る。モックにも入力中の場面を描く。
- スラッシュコマンドのパレットは実キーの入力（`pressSequentially`）でしか開かない。`fill()` は値を入れるだけで、キーのハンドラが動かない。
- モバイルの詳細画面の入力欄では Enter は改行。送るのは `[data-testid=send-message-button]`。
- セーフエリア（`env(safe-area-inset-*)`）は Chromium の CDP で再現できる。`reload` しないと既存の算出値に乗らない。効いていることを probe で先に確かめる（無視されたまま測ると全部緑になる）。

  ```js
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
  await page.reload();
  // probe: padding-bottom: env(safe-area-inset-bottom, 0px) の算出値が '34px' になること
  ```

- 「修正前に戻すと崩れる」対照は、クラスを差し替えて作らない。Tailwind は使われなくなったクラスを配信の CSS から削るので、戻したクラスが効かない。修正前の算出値を inline style で再現し、測った後は空に戻して再測する。

### ブラウザの自動操作

- Chrome の拡張から開いたタブは `document.visibilityState === 'hidden'` のことがあり、`visibilitychange` を待つ取得が走らず、チャットや History がスケルトンのまま止まる（製品は正しい）。ナビゲーションのたびに次を入れる。

  ```js
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'visible' });
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => false });
  document.dispatchEvent(new Event('visibilitychange'));
  ```

- Chrome の拡張が Service Worker のキャッシュで古い画面を配って固まるときは、Playwright MCP（別のブラウザ）を使う。Playwright MCP がほかのセッションのプロファイルのロックで使えないときは、worktree の `node_modules/playwright` を Node のスクリプトから直接使う（`devices['iPhone 13']` などの context も自由に作れる）。
- Playwright MCP の `[ref=…]` は次の操作で失効しやすい。CSS / role の selector（`[data-testid=…]`、`[role="menuitemradio"]:has-text(…)`）か `browser_evaluate` で操作する。
- `browser_run_code_unsafe` の中には `setTimeout` と `URL` が無い（待つのは `page.waitForTimeout`）。落ちても直前の操作は実行済みなので、送信の後で落ちたら再実行の前にサーバーのログで到達の回数を確かめる。`filename` はコードを読むファイルの引数で、結果の保存先ではない。route のハンドラが throw しても要求はサーバーへ素通りする。
- ネットワーク・コンソールの記録は呼んだときから取られる。先に記録を始めてから再読み込みする。

### Playwright のハーネスの罠

1 回目の fail がハーネスの誤りのことがある。実装を疑う前に次を確かめる。

- `page.addInitScript` は再読み込みのたびに走る。「保存して再読み込みで残る」型の検査で保存値を initScript で入れると、毎回初期値に戻る。ページを開いて origin を作ってから `page.evaluate` で 1 回だけ `localStorage.setItem` し、`reload` する。計測のヘルパー（`window.__uat` など）を残したいときは逆に initScript に置く。
- 削除などの確認はブラウザの `confirm()` ではなくアプリ内の `[data-testid="confirm-dialog-confirm"]`。`page.once('dialog', …)` では確定しない。
- 前の UAT が置いた `package.json` の版より新しい `release-notes/*.json` が残っていると、`tests/unit/release-notes/release-notes-files.test.ts` が落ちる。退避して再実行し、両方の結果を残す。
- 仮想リストは画面の外や最後の行のマウントが遅れ、`querySelectorAll` が見落とす。「ボタンが 0 個」と判定する前に、行までスクロールして行が在ることを陽性対照として記録する。testid で見つからないときは、表示の文字列からテキストのノードを逆引きして `closest()` で辿る。
- セッションが終わった worktree のチャットは、行を「Previous session (N)」の畳みに入れる（seed しただけの隔離 worktree はいつもこの状態）。`[data-testid="chat-previous-session-toggle"]` を開いてから探す。
- 同じ役の要素でも面によって testid が違う（例: pending のバブルは、チャット面が `chat-pending-retry`、PC 詳細の History が `pending-retry`）。片方だけで探さない。
- `context.setOffline(true)` は loopback の WebSocket を切らない。
- 入力欄に `fill('/model')` のような `/` で始まる文字列を入れると、スラッシュコマンドのパレットが開いたまま残り、後から出るカードやダイアログに被る。送る前に Escape で閉じる。
- クリップボードは `context.grantPermissions(['clipboard-read','clipboard-write'])` の後、クリックの前に `writeText('__SENTINEL__')` を入れ、クリックの後に `readText()` で読む。センチネルが残れば書かれていない。
- グループの見出しなどは CSS で大文字にしているので、テキストの一致で数えない。表示の設定は外から入れられる: 言語は cookie `locale`（`ja` / `en`）、テーマは `localStorage.theme`、サイドバーの幅は `localStorage['mcbd-sidebar-width']`、`/sessions` のタイル表示は `localStorage['mcbd-sessions-view-mode']='tile'`。

## Next Steps (Phase 2)

Future enhancements to test:
- Multiple choice prompts
- Text input prompts
- Custom button labels
- Prompt templates and patterns
- Prompt history and analytics
