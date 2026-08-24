# 実機確認手順書: 通知の静音化（Issue #1999 / #2000）

- **対象**: Epic [#2002](https://github.com/Kewton/CommandMate/issues/2002) の 1 本目
  [#1999](https://github.com/Kewton/CommandMate/issues/1999)（Auto-Yes 中は鳴らさない）と
  2 本目 [#2000](https://github.com/Kewton/CommandMate/issues/2000)（失敗通知）
- **起票**: [#2057](https://github.com/Kewton/CommandMate/issues/2057)「#1999 / #2000 についても、
  実機で確かめるべきことがあるなら最小限の確認手順を起こす。無いなら『実機不要』とその理由を書く」
- **記録先**: [docs/qa/2002-push-uat-record.md](./2002-push-uat-record.md)（本書の `- [ ]` は埋めないこと）
- **所要**: 準備は #2001 の手順書と共通。実施 10 分程度（**端末は 1 台でよい**）

---

## 1. 要否の判断（先に書く）

**結論: 2 件とも「実機は要る。ただし最小限」。** 台数の要る話ではないので #2001 の 2 台構成は不要で、
1 台で 4 ケースだけ見れば足りる。

判断は「unit テストが**構造的に**答えられない問いが残っているか」で行った。
残っていなければ実機不要、というのが本書の基準である。

| Issue | 自動テストが固めていること | 自動テストに**構造的に**答えられない問い | 判定 |
|---|---|---|---|
| #1999 | ゲートの判断そのもの（`tests/unit/push/prompt-push-gate-1999.test.ts`、`auto-yes-waiting-push-1999.test.ts`）。Auto-Yes の 4 種の停止理由・policy withheld・エスカレーションの各分岐 | **鍵が実物同士で噛み合うか**。ゲートは `buildCompositeKey(worktreeId, cliToolId, instanceId)` で Auto-Yes 状態を引くが、unit テストは待機側も Auto-Yes 側も**同じ手書きの鍵**で組み立てている。実物の alias インスタンス（`claude-2`）で待機を開いた鍵と、CLI が Auto-Yes を書いた鍵がずれていれば、ゲートは**エラーを出さずに素通り**する（＝ #1999 が無言で無効） | **要**（L-1 / L-2） |
| #2000 | 4 種の失敗の本文と辞書（`failure-push-body-2000.test.ts`）、エピソード境界とクールダウン（`failure-episode-state-2000.test.ts`）、プロデューサの配線（`failure-push-notifier-2000.test.ts`） | **本文だけで成功と失敗が区別できるか**という #2000 の受入条件は「実機のロック画面で、展開せずに読めるか」を含む。OS の切り詰め位置は端末の性質で、辞書の文字列長からは決まらない。加えて `tag` が `<wt>:failure` で prompt カードとは**別枠**になるため、待機カードと失敗カードが同時に並ぶ見え方は実機でしか確かめられない | **要**（L-3 / L-4） |

**実機不要と判断したもの**（作らない手順の明示）:

- 失敗 4 種を全部鳴らすこと。文面は辞書と unit テストが固めており、実機で見たいのは
  「切り詰められないか」だけなので、**最も長い本文 1 種**（`session-start-unavailable`）で足りる。
- 遷移先 URL の全種確認。`url` は `buildPushPayload` の 1 行で、#2022 が入れた例外
  （Assistant Chat の `/chat`）以外は `/worktrees/<id>` 一択。L-4 で 1 回踏めば十分。
- クールダウン（30 分）の実測。時計依存で、**実機で待つと 30 分かかるうえに得るものが
  `failure-episode-state-2000.test.ts` と同じ**。

---

## 2. 準備

[docs/qa/2001-cross-device-dismissal-uat.md](./2001-cross-device-dismissal-uat.md) §1 と同じ。
違いは **端末は 1 台でよい**ことと、次のログを流すこと。

```bash
tail -f <server log> | grep -E 'push/prompt-gate|push/failure|push/sender'
```

---

## 3. #1999: Auto-Yes 中に鳴らないこと

### L-1. 実物の Auto-Yes で待機通知が止まる（primary インスタンス）

1. `commandmate auto-yes <worktree-id> --enable`
2. 承認プロンプトが出る作業を `commandmate send <worktree-id> "..."` で送る
3. Auto-Yes が答えるまで待つ

**期待**:

- [ ] 端末に待機通知が **1 通も来ない**
- [ ] ログに `prompt-push-suppressed` / `reason: auto-yes-answering` が出る
- [ ] **その行の `worktreeId` / `cliToolId` / `instanceId` が、待機を開いた実際のセッションと一致する**
      （ここが本ケースの本体。一致しない＝鍵がずれている＝ #1999 は無言で無効）

### L-2. alias インスタンスでも止まる（鍵のずれを踏む本命）

1. `commandmate instances <worktree-id> add --agent claude`（`claude-2` などが生える）
2. `commandmate auto-yes <worktree-id> --enable --instance claude-2`
3. `commandmate send <worktree-id> "..." --instance claude-2` で承認プロンプトを出す

**期待**:

- [ ] `claude-2` の待機で通知が **来ない**
- [ ] ログの `instanceId` が `claude-2`（`claude` に落ちていない）
- [ ] 同じ worktree の **primary** で Auto-Yes 無しの待機を作ると、そちらは**鳴る**
      （＝止まっているのは alias の待機だけで、worktree ごと黙っているのではない）

> `--instance` の綴りが roster と違うと 3 番目が崩れる。崩れたら **端末側ではなくログの
> `instanceId` をそのまま記録**すること。文面の問題ではないので、スクリーンショットより
> ログ行のほうが次の Issue の材料になる。

---

## 4. #2000: 失敗が「失敗として」読めること

### L-3. ロック画面で、展開せずに失敗と分かる

1. 端末の通知を購読し、**画面を消してロックする**
2. インストールされていない CLI を指すインスタンスへ送る
   （`session-start-unavailable` を出す。#2009 / #2022 の経路）

**期待**:

- [ ] ロック画面のカードを**展開せずに**、「起動できない／インストールが要る」と読める
- [ ] タイトルが `<worktree 名> (<インスタンス>)` になっており、どの作業の話か分かる
- [ ] 本文が途中で切れて「成功したのか失敗したのか分からない」状態に**ならない**
      （切れた場合は **切れた位置をそのまま**記録する。辞書の語順を直す材料になる）
- [ ] ログに `kind: 'failure'` の送信行が 1 回だけ出る

### L-4. タップの着地と、prompt カードとの同居

1. L-3 のカードが出ている状態で、**同じ worktree に**承認プロンプトの待機を作る
   （＝ `<wt>:prompt` のカードが別に出る）

**期待**:

- [ ] カードが **2 枚**並ぶ（`tag` が別なので置き換わらないのが正しい）
- [ ] 失敗カードをタップすると PWA が `/worktrees/<id>` を開く
- [ ] 待機カードをタップしても同じ画面に着く（どちらも worktree が主語）

> 2 枚並ぶことは仕様である。1 枚に潰れていたら `tag` の作り方が壊れている＝**不合格**。

---

## 5. 合否のまとめ

| # | 確認項目 | 合格条件 |
|---|---|---|
| L-1 | Auto-Yes（primary） | 待機通知 0 通、`reason: auto-yes-answering`、鍵が実セッションと一致 |
| L-2 | Auto-Yes（alias） | alias の待機だけ止まる。`instanceId` が alias のまま |
| L-3 | 失敗の可読性 | 展開せずに失敗と分かる。途中で切れない |
| L-4 | 同居と着地 | prompt と failure が 2 枚並ぶ。両方 `/worktrees/<id>` に着く |
