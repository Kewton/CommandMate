# 担当の切り替えの手順

本体の 3-5・3-5b から、切り替えの手順を移した（#3481）。切り替えるかどうかの条件は本体にある。

## 3-5 Antigravity から Claude への切り替え

1. **Antigravity のセッションだけを止める**。他のインスタンスは止めない。
   ```bash
   commandmatedev instances "$WT" kill antigravity
   commandmatedev instances "$WT"        # antigravity の RUNNING が no であること
   ```
   止めるのは、次の task を作る**前**にする。env-clean のベースラインは task を作った時点で採られ、
   ベースラインにあったセッションが後から消えると違反になるため。
2. **Claude 用の契約** `.commandmate/tasks/issue-<N>-claude.yaml` を作る。
   - `scope` / `verify` / `success` は元の契約と同じにする
   - goal には、Claude 担当の通常の goal（2-4-2）に次の「引き継ぎ」節を足す
     ```markdown
     ## 引き継ぎ（前任: Antigravity、検証不合格 N 回）
     - 前任のコミット: <git log --oneline origin/develop..HEAD の出力>
     - 不合格だったゲートと logTail: <verify --json の該当部分。2 回分>
     - 前任の変更を読み、正しい部分は残し、誤っている部分は直すこと。作り直してもよい。
     - コミットは前任のコミットに追加してよい（1 つにまとめなくてよい）。
     ```
   - 前任のコミットがあるため、`work-evidence` は Claude が何もしなくても PASS する。
     Claude が実際に作業したかは、commits の増加と 3-3 のゲートで確かめる
3. **Claude に送る**。tasks.tsv の担当を `claude` に更新する（元の行は残し、切替の行を追記する）。
   ```bash
   AGENT=claude; MODEL=opus          # 切替先は常に opus。sonnet には切り替えない
   set_claude_model "$WT_PATH" opus  # 3-1 の関数。前の run の sonnet 指定が残っていても消える
   commandmatedev send "$WT" --contract ".commandmate/tasks/issue-${issue}-claude.yaml" \
     --instance claude --auto-yes --duration 3h \
     > "workspace/orchestration/runs/$DATE/send-${issue}-claude.out" 2>&1
   commandmatedev wait "$WT" --instance claude --on-prompt human --verify --timeout 10800
   ```
4. 以降は通常の Claude 担当として 3-4 に従う（ワーカー起因の不合格 2 回で人間へエスカレーション）。

## 3-5b sonnet から opus への格上げ

1. **Claude のセッションだけを止める**（task を作る**前**に。理由は 3-5 の手順 1 と同じ）。
   ```bash
   commandmatedev instances "$WT" kill claude
   commandmatedev instances "$WT"        # claude の RUNNING が no であること
   ```
2. **モデルの指定を外す**: `set_claude_model "$WT_PATH" opus`（3-1 の関数。`model` キーを消して既定の opus に戻す）
3. **opus 用の契約** `.commandmate/tasks/issue-<N>-opus.yaml` を作る。`scope` / `verify` / `success` は元の契約と同じ。
   goal は Claude 担当の通常の goal（2-4-2。**sonnet 用の 2 行は外す**）に、3-5 と同じ形の「引き継ぎ」節を足す（見出しは `## 引き継ぎ（前任: Claude sonnet、検証不合格 N 回）`）
4. **送って、モデルを確かめてから待つ**。tasks.tsv には切替の行を追記する（元の行は残す）。
   ```bash
   AGENT=claude; MODEL=opus
   commandmatedev send "$WT" --contract ".commandmate/tasks/issue-${issue}-opus.yaml" \
     --instance claude --auto-yes --duration 3h \
     > "workspace/orchestration/runs/$DATE/send-${issue}-opus.out" 2>&1
   commandmatedev capture "$WT" --instance claude --json | jq -r '.model'   # opus を含むこと
   commandmatedev wait "$WT" --instance claude --on-prompt human --verify --timeout 10800
   ```
5. 以降は通常の Claude（opus）担当として 3-4 に従う（ワーカー起因の不合格 2 回で人間へエスカレーション）。
