# 設計方針: 端末間で通知を消し込む（Issue #2001）

- **Issue**: [#2001](https://github.com/Kewton/CommandMate/issues/2001)（Epic [#2002](https://github.com/Kewton/CommandMate/issues/2002) の 3 本目）
- **前提**: [#1999](https://github.com/Kewton/CommandMate/issues/1999)（Auto-Yes 抑止）/ [#2000](https://github.com/Kewton/CommandMate/issues/2000)（要対応の軸・失敗通知）はマージ済み
- **ステータス**: Accepted
- **基準日**: 2026-08-23（仕様・各エンジン実装の実測。行番号は腐るため識別子で参照する）

---

## 0. 結論（先に書く）

**Issue の提案（`silent: true` で送り、Service Worker は `showNotification` を呼ばず
`getNotifications({tag})` → `close()` だけする）は成立しない。iOS だけの制約ではなく、
Chrome / Firefox / Safari の 3 エンジンすべてで `userVisibleOnly: true` 契約違反になる。**

採用したのは **「無音の置き換え（silent replacement）」** である。

```
待機が解決（応答された／Auto-Yes が答えた／セッションが進んだ）
    ↓
サーバが「解決」イベントを、要対応バケツの全購読へ送る
（kind: 'prompt' / tag は古いカードと同じ <worktreeId>:prompt / resolved: true）
    ↓
各端末の Service Worker が受信
    ↓
getNotifications({ tag }) → close()   ← 古い嘘のカードを消す
    ↓
showNotification(同じ tag, silent: true, renotify: false)  ← 契約を守る 1 枚
```

端末上のカード枚数は **増えない**（1 枚が 1 枚に置き換わる）。音もバイブも鳴らない。
そして文面が「応答待ちです」から「対応済みです（他の端末で応答されました）」に変わるので、
**「どれが消化済みか端末を見ても分からない」という Issue の中核の不満は解消する。**

さらに、送信条件をサーバ側で 3 つに絞ったので、**1 台運用では push が 1 通も増えない**（§5）。

---

## 1. なぜ Issue の提案が成立しないか（仕様と 3 エンジンの実装から）

### 1.1 出発点: この repo の購読は `userVisibleOnly: true`

`src/components/notifications/NotificationsSettings.tsx` の `handleEnable` は

```ts
const sub = await reg.pushManager.subscribe({
  userVisibleOnly: true,
  applicationServerKey: urlBase64ToUint8Array(publicKey),
});
```

で購読する。これは選択ではない — **Web ページからは `false` を主要ブラウザが受け付けない**
（Chrome は `NotAllowedError`。`userVisibleOnly: false` が使えるのは Chrome 121+ の
**拡張機能**だけで、Web ページには開いていない）。

`userVisibleOnly: true` は「**受け取った push は必ずユーザーに見える通知を残す**」という
ブラウザとの約束であり、「表示せず close だけ」はその約束を破る行為そのものである。

### 1.2 各エンジンが違反をどう扱うか（実測ではなく、公式文書とエンジンの挙動）

| エンジン | 違反の判定 | 罰 |
|---|---|---|
| **Chrome / Chromium** | `event.waitUntil()` に渡した promise が settle した時点で、**表示中の通知が 0 枚**なら違反 | 自前の汎用通知「**This site has been updated in the background.**」を代わりに出す（Chromium のリソース文字列は「サイトが可視通知の要件を自分で満たさなかった場合」と説明している） |
| **Firefox / Gecko** | 同上（通知を残さない push＝silent push） | **購読ごとのクォータ**を消費する（初日 16、翌日 8、その次 5 … と逓減。`dom/push/PushRecord.sys.mjs` の `reduceQuota()` / `dom.push.maxQuotaPerSubscription`）。使い切ると**購読が破棄**され、ユーザーがサイトを再訪するまで復活しない |
| **Safari / WebKit（iOS 含む）** | 同上 | 「**Violations of the `userVisibleOnly` promise will result in a push subscription being revoked.**」（WebKit 公式 "Meet Web Push"）。実運用の観測では **silent push 3 回**で購読が取り消される |

出典:

- WebKit, *Meet Web Push* — <https://webkit.org/blog/12945/meet-web-push/>
  「The Web Push API is not an invitation for silent background runtime, as that would both
  violate a user's trust and impact a user's battery life. / When the service worker handles a
  push message, it is **required** to use the Notifications API to display a user visible
  notification. / Violations of the `userVisibleOnly` promise will result in a push subscription
  being revoked.」
- web.dev, *Push events* — <https://web.dev/articles/push-notifications-handling-messages>
  「Chrome will only show the "This site has been updated in the background." notification when a
  push message is received and the push event in the service worker **does not show a notification
  after the promise passed to `event.waitUntil()` has finished**.」
- Pushpad, *"This site has been updated in the background": what is this notification?* —
  <https://pushpad.xyz/blog/this-site-has-been-updated-in-the-background>
  （Chromium のリソース文字列の引用元）
- Mozilla, `PushRecord.sys.mjs` — <https://searchfox.org/mozilla-central/source/dom/push/PushRecord.sys.mjs>
  （`reduceQuota()` とクォータ曲線）／ Bugzilla 1153504 *Implement per origin quotas for Push Notifications*
- Progressier, *How to fix iOS push subscriptions being terminated after 3 notifications* —
  <https://dev.to/progressier/how-to-fix-ios-push-subscriptions-being-terminated-after-3-notifications-39a7>
- W3C Push API Issue #313 *userVisibleOnly should be standardized to match browser behaviour* —
  <https://github.com/w3c/push-api/issues/313>（仕様文が曖昧で、実装ごとに要件が違うことの記録）

### 1.3 「表示してから閉じる」も成立しない（ここが重要）

よく使われる回避策に「`showNotification()` してから同じ `waitUntil` の中で `close()` する」がある。
**これも通らない。** 上の web.dev の一文が正確に述べているとおり、Chrome の判定は
「`showNotification` を呼んだか」ではなく「**waitUntil が settle した時点で通知が表示されているか**」
である。`waitUntil` の中で閉じれば 0 枚になり、silent push として扱われる。

`waitUntil` の外の `setTimeout` で遅延 close する変種は、
(1) Service Worker は push 処理後すぐ終了させられうるのでタイマが発火する保証がない
（iOS では特に確実に殺される）、
(2) 一瞬表示されて消える「点滅」になり体験としてむしろ悪い、
(3) プライバシー契約を意図的に迂回する挙動であり、まさに購読取り消しの対象になりうる、
の 3 点で採らない。

### 1.4 結論として、Issue 提案は Chrome でも目的を達成しない

見落とされがちな点なので明記する。**Chrome では「close だけ」にしても通知は消えない** —
消えたところに Chrome 自身の「このサイトはバックグラウンドで更新されました」という
**情報量の少ないカード**が出るだけである。つまり Issue の提案は

- Chrome: カードは残る（内容が悪化する）
- Firefox: 16 回で購読が死ぬ
- iOS: 3 回で購読が死ぬ

となり、**採用案（§2）に完全に劣後する**。実機確認を待つまでもなく棄却できる。

---

## 2. 採った形と、採らなかった形

| 案 | 端末上のカード | 契約 | 判定 |
|---|---|---|---|
| **A. 無音 push ＋ close のみ**（Issue の提案） | Chrome は汎用カードに置換、他は消える | **全エンジンで違反**。iOS 3 回 / Firefox 16 回で購読取消 | **棄却**（§1.4） |
| **B. 無音の置き換え**（採用） | 1 枚 → 1 枚（文面が「対応済み」に変わる） | 常に遵守。silent push を 1 回も発生させない | **採用** |
| C. iOS だけ諦めて A を他エンジンで | Chrome で目的未達、Firefox で購読死 | 違反 | 棄却（片肺にする価値が無い） |
| D. push を使わず次回 push 時／アプリ起動時に畳む | 次の push まで嘘が残る | 遵守 | **受入条件を満たさない**ので単独では棄却。ただし B を補う保険としては有効（§6） |
| E. 表示 → `waitUntil` 外で遅延 close | 点滅して消える（発火保証なし） | 迂回。取消対象になりうる | 棄却（§1.3） |

**Issue 本文との食い違い**: Issue は「iOS の制約を実機で確認し、成立しないなら iOS では諦める」と
書いているが、**これは iOS 固有の制約ではない**。したがって「iOS だけ諦める」という選択肢自体が
成立せず、`docs/` に「iOS では成立しない」と書くのではなく、**全エンジンで成立しない理由**を
本書に書いた。これは逸脱ではなく訂正である。

---

## 3. どの kind を消し込むか

**`prompt` だけ。** 根拠を kind ごとに書く。

| kind | tag | 消し込むか | 理由 |
|---|---|---|---|
| `prompt` | `<worktreeId>:prompt` | **する** | 「解決」が機械的に定義できる唯一の kind。`waiting-episode-state`（#1786）が閉じるエッジを 1 箇所で観測しており、閉じた瞬間にカードの内容は**偽になる**。Issue が解こうとしている事象そのもの |
| `completion` | `<worktreeId>:completion` | しない | 「完了しました」は時点の事実であって、後から偽にならない。消し込む対象の「解決」が存在しない。#2000 で新規購読は既定 OFF になっており、そもそも受け取っていない端末が多い |
| `failure` | `<worktreeId>:failure` | **しない** | 「解決」の定義が待機と違う。検証ゲート不合格は誰かが直すまで不合格のままで、サーバはそれを知る信号を持たない。上流 API 障害は `failure-episode-state` の cooldown で畳まれるが、cooldown の満了は「直った」ではなく「もう言わない」である。**「対応済み」と書いた誤りのカードを出すのは、古いカードが残るより悪い** |

`failure` の消し込みは、将来 `verification_runs` が「再実行して合格した」を持つようになれば
自然に足せる。本 Issue ではその信号が存在しないため足さない。

---

## 4. 実装の地図

| 役割 | 場所 |
|---|---|
| カードが実際に端末へ出たかの記録 | `src/lib/push/prompt-card-state.ts`（`markPromptCardShown` / `hasPromptCard` / `clearPromptCard`） |
| 記録する唯一の地点 | `src/lib/push/push-sender.ts` の `notifyPushSubscribers` — VAPID チェック・dedup・購読 0 件のいずれも通過した後 |
| 送るか否かの判定（理由コードつき） | `src/lib/push/resolution-push-notifier.ts` の `decidePromptResolution` |
| 送信 | 同 `notifyPromptResolved`（never throws） |
| 起動点 | `src/lib/push/waiting-push-notifier.ts` の `handleWaitingTransition` の閉じるエッジ |
| worktree 単位の「まだ待っているか」 | `src/lib/session/waiting-episode-state.ts` の `hasOpenWaitingEpisode` |
| 端末数 | `src/lib/db/push-subscriptions-db.ts` の `countPushSubscriptionsForKind` |
| 受け側 | `public/sw.js` の `replaceStaleNotifications` と `push` ハンドラ |
| 文面 | `locales/{en,ja}/notifications.json` の `push.promptResolved` |

閉じるエッジを起動点にした理由: `observeWaitingEdge({ waiting: false })` は
**ポーラ（`response-checker`）と状態プローブ（`worktree-status-helper`）の両方**が呼ぶ。
#1790 が開くエッジで両プロデューサをまとめたのと同じ形で、1 箇所を塞げば両方に効く。

---

## 5. 通知量とバッテリの評価（#1999 / #2000 を帳消しにしないこと）

送信条件は 3 つあり、**すべて満たしたときだけ** push を 1 通増やす。各条件は理由コードとして
ログに出る（`resolution-push-skipped` / `resolution-push-sent` の `reason`）。

| 理由コード | 意味 | 効果 |
|---|---|---|
| `push-unconfigured` | VAPID 未設定 | 送らない |
| `no-card` | この worktree の prompt 通知は 1 通も出ていない | **#1999 の削減をそのまま維持する条件**。Auto-Yes が答えた待機は鳴っていないので、消すものが無い |
| `still-waiting` | 同じ worktree の別インスタンスがまだ待っている | カードはまだ真なので消さない |
| `single-device` | 要対応バケツの購読が **2 台未満** | **1 台運用では push が 1 通も増えない**（受入条件「購読が 1 台だけのときに現状から挙動が変わらない」を構造で満たす） |
| `cross-device-clear` | 上記すべてを通過 | 送る |

**定量**:

- **1 台運用 / 0 台運用**: 増分 **0 通**。`MIN_DEVICES_FOR_CROSS_DEVICE_CLEAR = 2` による。
- **2 台運用**: 「実際に鳴った待機」1 件につき **+1 通 × 台数**。Auto-Yes 下の待機（#1999 が
  消した分）は `no-card` で落ちるので増えない。つまり**増分の母数は #1999 が残した分だけ**であり、
  #1999 / #2000 の削減を食い潰す構造になっていない。
- **1 通のコスト**: ペイロードは既存の通知と同形（数百バイト）。`silent: true` /
  `renotify: false` なので **画面点灯・音・バイブを伴わない**。Android では既存カードの
  in-place 更新になるため、通知シェードを開かない限り視覚的な変化も起きない。
  push 1 通のバッテリ影響の大半は「無線を起こすこと」と「画面を点けること」であり、
  後者が発生しない分、同じ 1 通でも通常の通知より軽い。
- **上限**: 1 つの待機エピソードにつき解決通知は 1 通（`clearPromptCard` が送信時にマークを
  落とすので、閉じるエッジが二重に来ても 2 通目は `no-card` になる）。

---

## 6. 残る不正確さ（意図的に残したもの）

サーバは「**自分が送ったか**」は知っているが「**各端末がまだ表示しているか**」は知らない。
したがって、**通知をタップまたはスワイプで消した端末**には、解決 push が
「置き換え」ではなく「新規の 1 枚」として届く。無音で、内容は正しい（「対応済み」）が、
その端末だけカードが 0 → 1 枚になる。

これを消すには端末側から表示状態を報告させる必要があり、通知 1 通ごとに往復が増える。
置き換えのコストがゼロに近いのに対して割に合わないので、**残す**。

補強として `public/sw.js` は `getNotifications({tag})` → `close()` を
`showNotification` の**前**に必ず走らせる。iOS の `tag` 置換はエンジンによって挙動が揺れるという
報告があるため、tag 置換だけに頼らず明示的に閉じてから 1 枚出す形にしてある。
この順序は `tests/unit/pwa/sw-file.test.ts` と `tests/unit/pwa/sw-push.test.ts` が固定している
（逆にすると waitUntil settle 時に 0 枚になり、§1.2 の罰を全部踏む）。

---

## 7. 実機で確認すること

自動テストで固められない部分（実機の通知シェード挙動、音・バイブ、iOS の購読寿命）は
**[docs/qa/2001-cross-device-dismissal-uat.md](../qa/2001-cross-device-dismissal-uat.md)** の手順書に
分離した。特に次の 2 点は実機でしか取れない:

1. iOS の `ServiceWorkerRegistration.getNotifications()` が、実際に通知センターの配信済み通知を
   返し、`close()` がそれを取り除くか（仕様上は Baseline だが、iOS の通知センター連携は
   エンジン依存が残る領域である）。
2. `silent: true` が iOS で本当に無音になるか（iOS の通知音は端末側の設定にも従うため）。

**1 が成立しなかった場合でも、この設計は片肺にならない。** 同じ `tag` の
`showNotification` による置き換えが効けばカードは 1 枚のまま文面が更新されるので、
「嘘のカードが残る」という Issue の中核の不満は解消する。記録すべき内容は手順書の
「§6 記録テンプレート」に従うこと。
