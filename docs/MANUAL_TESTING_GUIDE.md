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

## Next Steps (Phase 2)

Future enhancements to test:
- Multiple choice prompts
- Text input prompts
- Custom button labels
- Prompt templates and patterns
- Prompt history and analytics
