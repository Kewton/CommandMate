# マシンのロックの世代の鎖（#4559 案 A）

- 対象: マシンのロック（`~/.commandmate/locks/<name>` と、パスで名付けたロック run-lock・supervisor.lock）の 3 実装（bash `verify-run.sh`・同期 JS `scripts/orchestrate/machine-lock-sync.mjs`・TS `src/lib/verification/machine-lock.ts`）と、その呼び手・外の読み手
- この文書は案 A の正本。決まりと理由と試験の計画を書く。経緯（S10〜S12 の設計・レビュー・処分）は Issue #4559 と PR の本文で辿る
- PR-1（この文書・T1 の模型・T7 の文書のガード）は振る舞いを変えない。実装は PR-2・PR-3（§9）
- `docs/design/machine-lock-owner-atomic-4288.md` の保証の文と表 F は **PR-2 で書き直す**（PR-1 では触らない。表 F の行を数える既存の試験があるため）。それまでは、あの文書の前提 P0・P1 と表 F が今の実装の正本

---

## 1. 根（判定と操作の間の窓が繰り返し出る理由）

#4559 の本文の再現（死んだ保有者を判定した回収者が長く止まり、次の保有者の生きたロックを退かす）と、その後に見つかった同じ種類の窓（読み直しの後の停止、戻しの `link` の ENOENT を「無い」と読んで生きた退避を消す、身を引く操作の再試行、退避名の再利用による入れ子、札の照合 → `mv -f`）は、次の 3 つが重なって生まれる。

1. **同じ名前を、保有者の世代をまたいで使い回す**。`<lock>`・`<lock>/owner`・`<lock>.gone-<token>-<serial>`・札の名前は、保有が替わるたびに同じ綴りで別の中身を指す
2. **操作は名前に向けて行われ、ファイルシステムに「比べて替える」手段が無い**。`rename`・`rm -rf`・`link` は「今その名前にあるもの」に効く。「読んで判定する → 名前に操作する」は、確かめを何回重ねても最後の確かめと操作の間が残る
3. **回収が「退かす → 確かめる → 戻す」の可逆の形で、途中の形がまた新しい名前になる**。退避・戻しの空の `<lock>`・`.undo-*` は、どれも他者の判定と操作の対象になる

加えて、前提 P0（10 分を超えて止まらない）は時間で窓を塞ぐ前提だが、**停止の回数を限らない**。2 か所で止まる組は P0 の内のまま破れる。時間で塞ぐ限り、多重の停止の組が次々に見つかる。

ここから出る設計の条件:
- 共有の名前を、判定した後に名前で動かさない（保有を表す名前を再利用しない）
- 判定の対象は「一度真になれば真のまま」の事実だけにする。その事実に基づく操作は、いつ実行されても、その事実の対象にしか効かない形にする
- 安全（保有者は高々 1）を、停止の長さ（P0）に頼らない

---

## 2. 保証

- **新版どうしの安全（S1・S2）は P0 に依らず、前提 P1（壁時計の前提・pid の再利用の判定 D7 を含む）と、C2（取得の後の一覧の readdir が最大を返す）・C5（世代の名前の書式）・C6（`.gen` を消さない運用）・C7（パスで名付けたロックの `.gen` の名前が 1 つ）に依る**。停止の長さ・回数に上限を置かない。これは前提を緩めて保証を守る形ではなく、保証が P0 を使わなくなる形
- C2 が崩れると取得の後の一覧が最大を見落として L3 が崩れ、C5〜C7 が崩れると世代の番号が振り直されるか鎖が 2 本になって L1 が崩れる。どれも S1 に効くので、実装の一覧の書き方・`.gen` の置き場を変えるときはこの文に照らす
- **P0 の定義の文は変えない**。P0 は活性（札の期限・持ち主の無い世代の猶予）と、混在の間の限界にだけ残る
- **混在の間の窓は、旧い版の書き手・回収者を相手にする `mixed` の行（§6.5）だけ**。新版どうしには無い。混在は長く続く（無期限もありうる）前提で、「新版どうしは閉じた」と「旧い版との間は `mixed` の行」の 2 つの文で受け入れる。混在の終わりを待たずに成り立つ
- 他ホストの記録は今どおり死と判定しない（待つ）

---

## 3. 置き方

```
<root>/<name>.queue/                札（今のまま。公平と、旧い版の書き手を待たせるためだけ。安全には使わない）
<root>/<name>.gen/g<12 桁の N>/     N 番目の保有の世代。一度作った N の名前は、その世代のためだけに使う
    owner                           その世代の最初の記録（tmp → link で公開）。後から書き換えない
    owner.h<k>                      引渡し（D4）で足す記録（k は 1 からの連番。link で排他に足す）
    fields                          merge-pr のフェーズなど。ロックの安全には使わない（merge-pr の回収の判断に使う）。持ち主だけが書き、mv で置き換えてよい
    end                             世代の終わりの印（link で排他に作る。中身は released／dead／withdrawn と書いた者の token）
<root>/<name>.gen.tmp/              tmp の置き場（世代のディレクトリの外。同じファイルシステム）
<root>/<name>.lock/                 旧い版のための目印（混在の間だけ。§6）。M3 の後は塞ぎのファイル（§6.3）
```

- パスで名付けたロック（run-lock `$TMPDIR/commandmate-run.lock`・supervisor.lock）の `.gen` は `$TMPDIR` の外、`<root>/by-path/<hash>.gen` に置く（root は名前で取るロックと同じ。`CM_VERIFY_LOCK_ROOT`、無ければ `~/.commandmate/locks`。`$TMPDIR` の掃除で `.gen` が消えると L1 が崩れるため）。hash の元は C7
- **どちらの置き場かはロックのパスだけで決まる**（PR-2 の実装で決めた）: ロックの親ディレクトリの realpath が root の realpath と同じで、名前が `<name>.lock` なら `<root>/<name>.gen`、それ以外は `<root>/by-path/<hash>.gen`。呼び手が名前（root と name）で取るか、パス（`lockPath`）で取るかに依らない。同じロックを名前で取る者とパスで取る者が別々の鎖を持つと L1 が崩れる（C7）ため
- **比べるのはディレクトリの実体（PR-2 の直し r6、C7-I1）**: 親と root の realpath は native の realpath（`fs.realpathSync.native`。ディレクトリ自身の綴りを返す）で観測し、その path を比べる（by-path の hash の元の親も同じ path）。大小を区別しないファイルシステム（APFS の既定）で、root を別の大小で綴った lockPath・大小だけ違う `CM_VERIFY_LOCK_ROOT`・親を大小違いで綴った by-path のロックが、同じ実体なら同じ鎖になる（JS の realpath は呼び手の綴りを返すので、文字列の等号が別の鎖を選んでいた）
- **ロックの名前（base 名）は常に小文字に寄せる（PR-2 の直し r6、D2。人の決定 #4559 コメント 7186934798）**: 名前の鎖の決め（`<name>.lock` か）と by-path の hash の元では、ロックの base 名を小文字にして使う。**小文字に寄せるのは ASCII の大文字（A–Z → a–z）だけ**で、ほかの字（ASCII でない字を含む）は綴りのまま（PR-2 の直し r7、レビュー a2 P3-5・PM の処分 3: PR-3 の bash と同じ寄せ方にするため。ロケール・Unicode の大小の畳みは使わない）。実体の綴りは読まず、FS が大小を区別するかも判定しない。大小を区別しない FS では `X.lock` と `x.lock` は 1 つのロックで、ロックがまだ無い間に 2 者が同時に鎖を選んでも鎖は 1 本（前の案 (i)〔親を読んで実体の綴りを取る〕に残っていた、ロックの無い間の 2 本の鎖は閉じた）。代わりに、大小を区別する FS で大小だけ違う 2 つの別のロック（同じ親）は 1 本の鎖を共にし、互いに待ち合う（安全の側。活性だけの費用として名指す）
- **root の realpath が resolved でなければ選ばない（PR-2 の直し r6、C7-I2）**: 親と同じく、root の realpath が不明（EIO など）でも無い（ENOENT）でも、名前の鎖も by-path も選ばない（その周は取らず、`gen-realpath` と root のパスを名指し、次の周で読み直す）。取得（と保有者でない者の解放・回収 D5・D6）は観測の前に root を `mkdir -p` で作る（by-path の鎖は root の中に置く。run-lock のロックは root の外なので、root の無い機械でも取れるように）。この `mkdir -p` は観測点 `gen-root-mkdir` で、作れなければ（親の権限など）その点と root のパス・errno で名指し、鎖を選ばない（`gen-realpath` の ENOENT とは名指さない。PR-2 の直し r7、PM の処分 4）。by-path の鎖の親 `<root>/by-path` の `mkdir` も観測点 `gen-parent-mkdir`（失敗は名指して取らない。取得の外へ投げない。レビュー a2 P3-6）。だから root の realpath が absent なのは、観測の間に消された・綴りが違うときだけ
- 試験の口 `hooks.genDir` は試験だけが渡す（C7-I4。本物の入口の run-lock・TS・merge-pr・merge-train が渡さないことを T2 の走査で固定する）。鎖が不明のとき（C7-I3）は、鎖に依る判断（世代の取得・`end`・目印の取り外し・`released`・世代の保有者の読み）を進めない。保有者でない者の解放・回収（D5・D6）はその周に世代に何も書かず作らず、目印にも触れず、D5 は `deferred`・D6 は `kept` を返して不明の点を名指す（PR-2 の直し r7、レビュー a2 P2-1・b2 P2-2）。どの公開の関数のどの観測点で、どの値（resolved・absent・unknown）のときに何をするかは §8.4 の表（機械で作る）で固定する
- **C7 の前提（#4559 コメント 7183455133）**: S1・S2 の証明は、同じロックの書き手がみな同じ鎖を見ることを前提にする。そのため親と root の realpath は観測（`gen-realpath`）で、失敗は不明として名指し、鎖を選ばずに取らず、次の周で読み直す（字面のパスへ落とさない）。鎖の置き場の明示（`hooks.genDir`）は試験の口だけで、呼び手・TS からは渡らない
- 世代のディレクトリの中は「足すだけ」。書き換えるのは `fields` だけ
- 記録には世代の番号を持たせる: JSON（SJ・TS・VR のゲート）は `"g":<N>`、kv（ML・supervisor・run-lock）は `g=<N>` の 1 行。`g` は予約の欄に足し、呼び手が書けないようにする
- supervisor.lock の世代の記録にも `lstart=`・`started_at=` を書く（D7 を世代の回収で使うため）

---

## 4. 手順

どの手順も、1 回の排他の作成（`mkdir`・`link`）か、世代の名前の中の操作で進む。

### 4.1 保有者の定義と取得
- **保有者**: 存在する世代のうち番号が最大の `g<M>` で、`end` が無いもの（`owner` が公開済みなら、その記録とその引渡し先のグループ）
- **取得**:
  1. 一覧で最大 `M` を読む
  2. `g<M>/end` を読む。在れば 3 へ。無ければ回収の判定（§4.3・§4.4）へ。世代が消えていた（ENOENT）ら「`end` が無い」と読んで判定へ進んでよい（緩めた C4）
  3. `mkdir g<M+1>`（EEXIST なら 1 から）
  4. `g<M+1>/owner` を tmp から `link`（EEXIST なら負け: 墓か別の書き手。1 から）
  5. **もう一度一覧を読み、自分より大きい世代が無ければ取得**。在れば自分の世代に `end`（withdrawn）を付けて 1 から（身を引く。操作は自分の世代の名前の中だけ）
  6. 多重の防御として、自分の `g<N>` に `end` が無いこと・`owner` が自分の token であることも確かめる
- **諦める道**: 自分の `owner` を `link` した後、取得を返さずに抜ける道は、どれも**自分の `g<N>` に `end` を書いてから抜ける**（`end` の書き込みも失敗したら名指す）。`end` の中身は withdrawn（目印の待ちの期限だけは released。§6.1）。道は、自分より大きい世代を見た（5 の身を引く）、取得の後の一覧が読めない（EIO・ENOENT。C6）、多重の防御が外れた（6）、目印の待ちの期限（§6.1）、例外と中止（async の包みの中止を含む）。**例外と中止は `mkdir g<N>` の後のどこからでも**（PR-2 の直し r6）: `owner` の公開の直後（`gen-owner-linked`）・取得の後の一覧（`gen-postlist`）の継ぎ目の例外、待ちの間の外の sleep の例外、generator の `return()` のどれでも、手順の `finally` が自分の `g<N>` に withdrawn を書き、札を done にする（取得の答えを返した後は書かない）。大きい世代を見ていない道では自分の世代が本当の最大でありうるので、`end` が無いと次の周の自分が自分の生きた記録を待って詰まる（長く生きる TS のサーバーでは再起動まで。S4 に反する。模型の壊した版 `abort-no-end` が赤）
- **自分より大きい世代を見て身を引く場合の `end` は、安全・活性に要らない、診断と片付けの目印**（手順としては書く）。理由: 身を引く世代は最大でなく、最大は単調で片付けに消されない（L1・C1）ので、その世代が再び最大になることは無い。回収・墓の判定は最大の世代だけを対象にする（L3）ので、誰もその世代を判定しない。片付けは `end` を見ずに `k < 最大` を消す（C1）ので、`end` が無くても溜まらない。模型でもこの場合の `end` を外した版は S1・S2・S4 のどれにも違反しない（§7.1）
  - 身を引く `end` を読むものは無い。根拠は 2 つに分かれる。(1) 旧い版の読み手は `.gen` を読まない（確かめた範囲: 呼び手・外の読み手 `scripts/agent-health/product/lib.sh`・`scripts/orchestrate/merge-pr.mjs`・`scripts/orchestrate/merge-train.mjs`・`src/lib/agent-health/run-lock.ts`・`scripts/uat/run-lock.sh`・`scripts/lib/machine-lock.sh`・`scripts/orchestrate/precheck.mjs`・`scripts/orchestrate/resource.mjs`・`scripts/flow/flow.mjs`・`src/lib/verification/gate-runner.ts` と 3 実装を、develop 890446374 と T5 の旧い版の sha で grep。旧い版は `<name>.lock`・その `.gone-*`〔ロックの根の readdir を接頭辞 `<name>.lock.gone-` で絞る〕・札だけを見る。`resource.mjs` は `cpu.sem/` だけ）。(2) 新版の読み手は §4 の決まりで最大の世代の `end` だけを読み、身を引く世代は最大にならない（L1）。新版の読み手がこの決まりの外で `end` を読まないことは、PR-2 で T3 の走査で固定する。だから混在の間の互換のためにも要らない
- T2・T6 に「取得の後の一覧の EIO 1 回の後、自分の世代に `end` が付き、次の周で取れる」行を置く
- 解放・回収の的は、取得の時に記録した世代の番号 N で決める（「今の最大」から導かない）。子へは `CM_RUN_LOCK_TOKEN` と一緒に N を渡す（`CM_RUN_LOCK_GEN`）

### 4.2 解放
- `end`（released）は、**D12 が released を返したとき**（引渡し先の全ての記録が死んだ: pid が無く pgid のグループが空、と判定できたとき）だけ、持ち主が書く（下の 2 項目目の「取得を返す前に諦める道」を除く）。deferred・kept・needs-head では書かない。D12 の `ownGroup` の例外（pid も pgid も自分）は今のまま
- 保有者でない者の解放（D5 `releaseAsHead`・UAT の `down`・失敗の trap・D6 のガード・ML の needs-head）は、**回収と同じ核の関数（§4.3）だけ**で `end` を書く。核の外から `end` を作る呼び出しは T3 の走査で赤
- 取得を返す前に諦める道（§4.1 の諦める道・§6.1 の目印の待ちの期限）の `end` は、まだ引渡しが無いので D12 を通さずに書いてよい。書くのは核の 1 つの関数（取得の側の「自分の世代を終える」）だけ
- D12 は世代の記録（`owner`・`owner.h<k>`）で **1 回だけ**判定し、その結果で目印 → `end` の順に外す（目印と世代を別々に判定しない。§6.1）
- **全ての引渡し先を判定する（PR-2 の直し r6）**: 目印は最後の引渡しの記録だけを持つ。持ち主の解放は、目印が示さない世代の記録（最初の `owner` と全ての `owner.h<k>`）を全部 D12 で判定し、1 つでも released でなければその答え（deferred・needs-head）を返す。保有者でない者の解放（D5 `releaseAsHead`）も、目印の記録が死んでいても、その保有の世代の記録のどれかが生きている・不明なら deferred で、目印も世代も残す（A → B → C の後に C だけが終わっても、B の生きたグループを守る）。**判定するのは最初の `owner` を含む全ての記録**で、回収（§4.3）と同じ判定を使う。D5 の呼び手自身の記録（pid と host が両方一致する記録だけ。共有の FS で別の host の同じ pid を自分と読まない。PR-2 の直し r8、レビュー a3 P3-1）は D12 の規則で自分の記録と読む（pgid が自分と別のグループならその生死を見る）。同じ規則を `end` の判定にも使うので、目印の判定と `end` の判定は 1 つで、`released` を返すのは `end` が付いたときだけ（`end` が書けなければ `deferred` で名指す。目印は §6.1 の順で先に外れている）（PR-2 の直し r7、レビュー a2 P2-2・b2 P2-1）。**`released` の前に、保有の世代が終わったこと（`end` が在る、または片付けで消えた: L1）を確かめる**（PR-2 の直し r8、レビュー a3 P2-1 ＝ b3 P2-2）: 目印を外した後の記録の読み直しの失敗は不明（`holder-read` など）として、`end` の前の判定が busy・young・again を答えたとき・`end` の `link` の ENOENT の後に世代がまだ在るときは `beacon-gen-end` の EAGAIN として、`deferred` で名指す（次の呼び出しか次の先頭が `end` を書く）。D6 の回収も、目印の記録が `g=<N>` を持つときは、`g<N>` が終わっている（`end` が在る、または片付けで消えた）ときだけ目印を回収する（§6.1 の前の世代の目印と同じ必要条件。`end` は全ての記録が死んだときだけ付くので、全ての引渡し先を判定したことになる）
- **解放の `end` の再試行（PR-2 の直し r6、S4）**: `end` の tmp は試行ごとに別の名前（C8）。`link` の ENOENT は、世代が終わっている（`end` が在る、または最大より小さくて片付けで消えた: L1）ときだけ完了と読み、世代がまだ在って `end` が無ければ新しい tmp でやり直す（tmp が古さで片付けられた後の再開で、`end` の無いまま released を返さない）。1 回の解放の中のやり直しが尽きたら、投げずに `deferred` を返し（`machine-lock-release-deferred … point=end-link errno=EAGAIN`）、次の解放が `end` を書く（PR-2 の直し r7、レビュー a2 P3-6）

### 4.3 死んだ保有者の回収
1. `g<M>` の記録を `owner`・`owner.h1`・`owner.h2` … の順に読み、最初の ENOENT で止める（readdir を使わない。C2 の readdir に頼るのは取得の後の一覧だけ）。読んだ全員が死んだと判定する
2. **全員死を見た後に**、判定した最後の `h<k>` の次 `h<k+1>` を `lstat` して無いことを確かめる（readdir は使わない。C3）
3. `g<M>/end`（dead）を `link` で作る。`link` の ENOENT は、世代が終わっている（`end` が在る、または片付けで消えた: L1）ときだけ完了と読み、世代がまだ在れば 1 から新しい tmp でやり直す（tmp が古さで片付けられた後の再開。解放の `end` の再試行〔§4.2〕と同じ。PR-2 の直し r8、レビュー a3 P2-1）
- 保有者のロックを動かさない。退避は無い。止まった回収者が後で 3 を実行しても、効くのは判定した世代だけ（その世代の持ち主は全員死んでいて、死んだ者は記録を足せない: L5）
- merge-pr の回収の判断（`onStaleHolder` の phase → `recovered-stop`）のため、世代の回収は判定した記録と `fields` を `onStaleHolder` に渡す（今の回収が渡しているものと同じ形）
- **重ねる順は `owner` → 最後の引渡しの記録 → `fields`（`fields` が最後に勝つ。PR-2 の直し r6）**: 記録の `phase: 'idle'` より、保有の間に書いた phase が勝つ（予約の欄は `fields` に書けない）。`fields` の読みが失敗した・壊れていたときは `{}` と読まず、不明（`gen-fields-read`）としてその周は回収しない（次の周で判定し直す。未確認の書き込みを idle と読んで失わない）。held by の表示（`readHolder`）も同じ順。`readHolder` は鎖の観測（`fields` の読みも）が失敗したら世代の保有者を答えない（`genOnly` は null、そうでなければ目印の記録）。呼び手が `warn` を渡せば点を名指す（PR-2 の直し r8、レビュー a3 P3-2 ＝ b3 P3-1）。D6（`recoverIfDead`）も世代の回収の観測の失敗を答えの `unknown` に名指す（素の `kept` にしない）

### 4.4 持ち主の無い世代（墓）
- 作成の途中で止まった・死んだ書き手の世代（`owner` が無い）は、猶予の後に墓の記録を `g<M>/owner` へ `link` で作る。**書き手の公開と同じ名前を奪い合う**（L4）。勝った方だけが進む。墓が勝てば `end`（dead）
- 墓の記録は `tomb=1` の印を持ち、判定は常に死とする（回収者の pid を書いても生死に使わない。回収者が墓と `end` の間で止まっても、次の回収者が墓を死と読んで `end` を書ける）
- 猶予は `g<M>` の mtime から測る（P0 は活性だけに効く。墓は L4 の排他で、猶予の長さは安全に効かない）。模型は猶予ゼロ（安全の側）で、壊した版 `no-tomb`（墓を置かずに待ち続ける）が S4 で赤
- **生きた書き手の自分の墓（PR-2 の実装で足した。PM の処分で採った）**: `mkdir g<N>` の後に自分の `owner` の公開が**不明**（tmp の作成か `link` が EIO など、`unknown`）で終わった書き手は、`g<N>` を猶予の間持ち主の無いまま残さず、自分の墓を同じ `owner` の名前へ `link` してから `end`（withdrawn）を書く（継ぎ目 `gen-owner-failed`）。公開の `link` が `absent`（ENOENT: tmp か世代が片付けで消えた）のときは墓へ進まず次の周へ戻るので、`g<N>` が残っていれば持ち主の無い世代として猶予の待ちが残りうる（活性だけ。C8 の片付けは 10 分より古い tmp だけを消す）
  - **これは活性の手当て**: これが無いと、1 回の EIO で次の保有者が猶予（10 分）待つ（S4 の「EIO 1 回は次の周で回復」に反する）
  - **S1・S2 は排他の `link` が守る**: `g<N>` を作ったのは `mkdir` の排他でこの書き手だけなので、`owner` の名前を奪い合う相手は猶予の後の回収者の墓だけ（L4）。自分の `owner` が実は公開されていれば墓は EEXIST で、自分の世代として `end` を書く
  - **T1 の範囲の外で、T2 の 2 行が守る**: 模型は公開の失敗を表さない（§7.4）ので T1 は変えない。T2（`machine-lock-generation-seams-4559.test.ts`）が、公開の EIO の後に (i) 墓の前（`gen-owner-failed`）で殺すと持ち主の無い世代が残り、後継は猶予の内は取らず猶予の後に取ること、(ii) 墓の後・`end` の前（`tomb-linked`）で殺すと後継が猶予の内に `end`（dead）を付けて取ることを、継ぎ目の呼び出しの回数（1 回）とともに確かめ、自分の墓を書かない核の写しで (ii) の継ぎ目に届かない（0 回）ことを確かめる

### 4.5 片付け
- 一覧のたびに最大を読み直し、**`k < 最大` の世代だけ**を `rm -rf` する（`end` は見ない）。最大は決して消さない（C1）
- 他者の tmp（`<name>.gen.tmp/`）は古さ（10 分）だけで選んで消す（C8）
- 片付けが失敗し続けると世代が溜まる（活性だけ。名指す）

### 4.6 引渡し（D4）
- 保有者は、保護するプロセス（子）を始める**前に** `owner.h<k>` を `link` で足し終える。親が死んだ後に遅れて足された記録の子は、合図が無いので始まらない（L5 の根拠）
- 引渡しは 1 回の保有の中で何度でもありうる（k は 1, 2, …）。2 回目以降は、目印が前の引渡しの token を持つ（その token もこの保有の札として持ち、引渡しの確かめと解放の「自分の記録」に数える。PR-2 の直し r6）。回収者の読み直し（§4.3 の 2）は判定した最後の k の次を見る（いつも `h1` を見ると、2 回目の引渡しの子を漏らして S2 が崩れる。模型の壊した版 `relist-h1-only` が赤）
- 混在の間は目印にも写す（§6.1）

### 4.7 札
- 札は今のまま残す。**世代の前に取り、目印を取るまで持ち、目印を取った後に退く**（世代の後すぐ退くと、先頭の別の新版と互いに待つ）。目印を持たない版（M3 の後、§6.3）では、世代の取得（L3 の確かめ）の後に退く
- 新版どうしでは札は公平だけに効き、安全は世代で決まる。札の done の照合 → `mv -f` は新版どうしでは害にならず、旧い版との間の行として残す（`TICKET-DONE`、§6.5）

---

## 5. 補題・条件・不変条件

模型（T1）が見るものは §7、実装の試験は §8。「確かめる所」の `T1（§7.3）` は模型の表から作った §7.3 を指す（どの名前が T1 で確かめられるかは模型が決め、T7 がこの列と比べる）。

| 名 | 文 | 確かめる所 |
|---|---|---|
| L1 | **最大は減らない**。最大の世代は消さない。新しい世代を作れるのは「最大 + 1」で、最大の `end` を見た後だけ。古い一覧の書き手が後で `mkdir` しても、在れば EEXIST、消えていれば最大より小さい番号になる | T1（§7.3） |
| L2 | **判定は変わらない事実だけ**。「`g<M>/end` が在る」「`g<M>` の持ち主が全員死んだ」は一度真になれば真のまま（印は消さない・死んだプロセスは生き返らない。pid の再利用は D7 と P1 のまま）。判定の後にどれだけ止まっても、その操作は同じ意味のまま効く | 模型の網羅（§7.5。人が読む） |
| L3 | **最大でない世代は保有者にならない**。取得の後の一覧で自分より大きい世代を見て身を引く。自分の取得の後に自分より大きい世代は作られない（作るには自分の `end` が要る）ので、この一覧の確かめに窓は無い | T1（§7.3） |
| L4 | **公開と墓は同じ名前を排他で奪い合う**。猶予の判定の後に止まった回収者と、途中から再開した書き手は、どちらも `g<N>/owner` を `link` で作る。勝つのは 1 人だけ | T1（§7.3） |
| L5 | **引渡しの記録は生きた持ち主だけが足す**。子を始める前に親が記録を書き終える（§4.6）。回収者は全員死を見た後に読み直すので、増えていなければそれ以後も増えない | T1（§7.3） |
| C1 | 片付けは一覧のたびに最大を読み直し、`k < 最大` だけを選ぶ（`end` は見ない）。最大は決して消さない | T1（§7.3） |
| C2 | 取得の後の一覧（`.gen` の readdir）は、走査の前から在って走査の間に消えない項目を必ず返す（POSIX の約束）。readdir の約束に頼るのはこの一覧だけ。最大は消えないので見落とさない | T2（APFS。証明ではない） |
| C3 | 回収者の読み直しは、全員死の判定の**後**に 1 回、判定した最後の `h<k>`（k ≥ 0）の次 `h<k+1>` の `lstat` で行う（readdir を使わない。いつも `h1` ではない）。記録を 1 つずつ判定する途中に挟まない | T1（§7.3）・T2 |
| C4 | 世代が消えていた（ENOENT）とき、「`end` が無い」と読んで判定の側へ進んでよい（緩めた形）。誤読は「`end` が無い」側にしか倒れず、その後の操作は作り直された最大でない世代に効くだけ（S3 の範囲）。文字どおりの「消えていたら最初から」は求めない | T1（§7.3） |
| C5 | 世代の名前は `^g[0-9]{12}$` だけ。それ以外は数えない。bash は `10#` で読む。作る書式は 3 実装で同じ | T3 |
| C6 | `.gen` は作った後は消さない（運用の前提）。取得の後の一覧で `.gen` が無い・読めないときは取らない（不明）。bash の `lock_obs_list` は ENOENT を空として返すので、世代の一覧はこの口を使わずに ENOENT を区別する | T2 |
| C7 | パスで名付けたロックの `by-path/<hash>.gen` の hash は、ロックのパスの**親ディレクトリを realpath で解いた**文字列＋ベース名から作る（`/var/folders/…` と `/private/var/folders/…` を同じにする）。3 実装で同じ書き方。同じパスのロックの書き手は同じ root を見る（名前で取るロックの root と同じ前提。PR-3 の bash も同じ root を読む） | T2・T3 |
| C8 | `<name>.gen.tmp/` の tmp の名前は書き手の token と用途と試行の番号を含み（`<token>.<owner\|end\|tomb\|h<k>\|fields>.<k>`。書き込みが失敗して残った tmp に、次の試行が出会わない）、二度と使わない。他者の tmp の片付けは古さ（10 分）だけで選ぶ。消された書き手は `link` が ENOENT になって最初からやり直すだけ（活性） | T2 |
| S1 | **保有者は常に高々 1**: どの時点でも、「取得を返して解放していない生きたプロセスと、その引渡し先のグループ」は高々 1 組（引渡しのグループを 1 人と数える）。停止の長さ・回数に依らない | T1（§7.3）・T2・T4 |
| S2 | **生きた保有者を退かさない**: 生きた保有者の世代に、他者が `end` を付けない（P1 の外の D7 の誤りだけを除く） | T1（§7.3）・T2・T4 |
| S3 | **止まった者が戻っても壊さない**: 手順のどの点で止まった者が戻っても、その操作は判定した世代か、最大でない世代にしか効かない | 模型の網羅（§7.5。人が読む）・T2 |
| S4 | **活性**: 他の者が全員終わった（done か死）状態から、残る 1 者が有限の歩数で保有者になる。死んだ保有者は次の先頭の周で回収され、持ち主の無い世代は猶予の後に墓になる。読みの一時の失敗（EIO 1 回）は次の周で回復し、名指される | T1（§7.3）・T6（EIO） |
| S5 | **混在の間**: 旧い版の書き手から見て、世代の保有者は目印の保有者に見える（旧い版が新版の保有中に取らない）。旧い版との間に残る窓は `mixed` の行（§6.5）にだけある | T5 |

片付けの名前での削除（`rm -rf g<k>`）が無害である理由: C1 の下で選ばれる `g<k>` は「最大より小さい」で、これは一度真なら真のまま（L1）。選んだ後に同じ名前が作り直されていても、それは最大でない世代で、L3 によって保有者にならない。消された書き手は ENOENT で最初からやり直すか、緩めた C4 で判定へ進んで何もしない。

---

## 6. 混在の間（旧い版の書き手が残る間）

旧い版（develop の今の 3 実装・公開済みの cmate-verify 0.7.0／0.8.0・旧い checkout・再起動前のサーバー・公開済みの npm `commandmate`）は `<name>.lock`・その `.gone-*`・札だけを見る。置き場 `~/.commandmate/locks` は他のリポジトリの cmate-verify とも共有なので、混在は長く続く。

**混在の間は、写し・記録の置き場・途中の形の数が増える**（想定どおり）。今の回収の手順は目印の旧い保有者のために全部残り、世代の手順と目印への写し（引渡し・`fields`）が足される。保有の記録の置き場は 2 か所（世代と目印）。減るのは混在が終わった後（新版どうしでは判定の後に名前で動かす組は片付けの 1 組だけ、途中の形は世代の 8〜9 個）。PR-2・PR-3 のレビューでは、この増え方を想定どおりとして確かめる。

### 6.1 目印（`<name>.lock`）の決まり
- **取得の順**: 世代を取る（L3 の確かめまで）→ 目印を今の規約で取る → **取得を返すのは目印を取った後**。目印の待ちの間に死ねば、世代は回収者が `end`（dead）で終わらせる。目印の待ちが期限に達したら、世代に `end`（released）を付けて busy を返す。目印の待ちの期限は手続きの境目でだけ見る（目印の回収の途中で抜けない）
- 目印を触る新版の者は**世代の保有者ただ 1 人**なので、新版どうしで目印の上の競合は起きない
- **引渡し・`fields` の写し（必須）**: 旧い版の先頭・D6 のガードは目印の owner の pid・pgid だけで生死を判定する。順は (1) 世代に `owner.h<k>` を `link` で足す → (2) 目印を今の D4（`handoff-tmp` → `rename('handoff-publish')`）で書き直す → (3) 合図を出す。(1) が失敗したら目印を書かずに今の D4 の失敗と同じ扱い（ゲートを始めない、exit 125）。(2) が失敗しても同じ。(1) だけ書けた状態は「生きうる記録が多い」側で安全。merge-pr の段の `fields` も目印へ写す。**混在の間は保有の記録の置き場が 2 か所**（世代と目印）で、引渡しと `fields` の 2 つの写しが要る
- **解放の順: 目印 → `end`**。D12 は世代の記録で 1 回だけ判定し（§4.2）、released なら目印を自分の解放で外し、それから世代に `end`（released）。間で死ねば、目印は終わった世代の目印として次の保有者が外す。逆の順だと目印が生きた保有と読まれ続ける時間ができる（活性）
- **前の世代の目印を外す**: 目印の owner に `g=<N'>`（N' < 自分の N）があり、`g<N'>` に `end` が在る（片付けで消えていれば「最大より小さい＝終わった」と読む: L1）**うえで**、目印の記録を今の規則で死と判定したとき（pid と pgid）だけ、今の回収の手順で外す。「`end` が在る」は必要条件で、十分条件にしない
- **旧い保有者（M1 を絞った形）**: 新版は、目印の記録が `g=` の無い旧い版の保有者で、**生きている・不明**なら回収しない（`machine-lock-legacy-writer` で名指して待つ。期限で busy）。**死んだと判定した旧い記録は今の手順（読み直しつき）で回収する**（P-4 は `mixed` に残る。develop と同じ窓で、悪くならない）。配備の手順に「残り物の `.gone-*` を名指して片付ける」を入れる
- **D8 の継承**: 混在の間、継承の判定は目印とその `.gone-*` も読む（旧い `daily.sh` が今の形で取って新版の `run-lock.ts` を起こしても継承できる）。継承した側の解放は**旧い形の解放だけ**で、世代の `end` は書かない（書くべき世代が無い）
- **`g=` の codec**: 旧い 3 つの読み手（`readOwner` の JSON・ML の kv・VR の `lock_parse_owner_text`）が知らない鍵を読み飛ばすことを、旧い版の写しの fixture で確かめる（T5）

### 6.2 札（混在の間）
- 旧い版の書き手は札の先頭の規約で待つので、札は旧い版との間の安全の側に残る（§4.7）

### 6.3 混在を短くする形（M0〜M3）と版の印
| 形 | 中身 | 採るか |
|---|---|---|
| M0 | 目印を持ち続ける | run-lock・supervisor.lock は、PR1b・PR1c より前の写しを読み込みうる worktree・常駐のシェルが無いと確かめるまで M0 |
| M1 | 旧い保有者を回収しない | **絞って採る**（§6.1: 生きている・不明だけ回収しない） |
| M2 | 版の印で終わりを決める | M3 と一体（下の塞ぎが印。`.proto` は作らない） |
| M3 | 目印を塞ぎのファイルに替える | `~/.commandmate/locks/<name>.lock`（VR・SJ・TS だけが書く名前）に限って、PR-3 の後の別 PR で |

- **版の印は塞ぎのファイルそのもの**: `<name>.lock` が**通常のファイル**で中身が `cm-lock-block v=1 g=<切替えた世代>` なら「目印を持たない版」。ディレクトリか無いなら「目印を持つ版」。版という 1 つの事実を 1 か所にだけ置くので、印と塞ぎのずれが無い
- 新版は印を**世代を取った後に**読む。切替は世代の保有者だけが行う（`commandmate lock migrate <name> [--revert]` の形）ので、印の読みと切替は世代で直列になる。人が手で `rm` する道は書かない
- **置く**（世代の保有者 X）: 目印を自分の解放で外す → 塞ぎを tmp から `link` で `<name>.lock` に置く。EEXIST（旧い W が間に `mkdir` した）なら置かずに目印の版のまま、W を目印の保有者として待つ。どこで死んでも、印は「塞ぎが在るか」だけなので片方だけ書かれた状態が無い
- **取り消す**（世代の保有者 X）: 塞ぎを自分だけの名前へ `rename` して中身を確かめる（塞ぎの書式でなければ戻す）→ 目印を `mkdir` で取る（EEXIST なら旧い W を待つ）。間で死ねば `<name>.lock` は無い＝目印を持つ版で、次の新版の保有者が目印を取る
- 塞ぎを取らず消さない旧い版は、VR は全ての版、SJ は 0.7.0 以降、TS は全ての版（`SKIP reason=mutex-wait`、exit 22）。VR・SJ・v0.51.0 以降の TS は 3 値の観測で「不明」と読むため。v0.50.0 以前の TS は 3 値を持たないが取らない（設計のときの旧い実物の確かめ。理由は T5 で固定する。v0.50.0 以前の TS の写しを T5 に足し、sha は PR-3 で pin する）。PR1b より前の `run-lock.sh`（`ffcb54d05`）と PR1c より前の `lib.sh`（`5507b811e`）は 1 分より古い塞ぎを消して取るので、M3 をそれらの名前に置かない
- M3 の前提: 常駐 worktree（`../commandmate-agent-health`）の更新が済んでいること。M3 の後は skill の `run-tests.sh` の塞ぎの期待が反転する（M3 の PR で名指す）。他のリポジトリの cmate-verify 0.7.0・0.8.0 のゲートは SKIP し続けるので、人の判断と告知が要る
- 印を置く時期は、counterpart の cmate-verify の公開版が案 A を持ち、この repo の旧い checkout・サーバーの再起動が済んだ後。観測（`machine-lock-legacy-writer`）は時期を決める材料で、終わりの条件にはしない

### 6.4 旧い書き手の一覧
- develop の今の 3 実装、cmate-verify 0.7.0・0.8.0（他のリポジトリ）、≤0.6.0 の VR（pid だけを読む）
- 公開済みの npm `commandmate`: v0.50.0 以前の TS（札も 3 値も無い）、v0.51.0〜v0.55.1 の TS（`44dcf038f`）
- 常駐 `../commandmate-agent-health`（PR1b・PR1c より前）、PR1c より前の worktree、PR1b より前の `run-lock.sh`、PR1c より前の `lib.sh`

### 6.5 `mixed` の行（旧い版との間に残る窓）
状態: `open` は混在の間ずっと残る、`closed` は案 A で閉じた、`later-PR` は後の PR（PR-3 の bash の世代化、または M3）で閉じる・狭める。行は PR ごとに足す（T7 が解析する）。`OLD-W-*` の 5 行は、相手が旧い cmate-verify（他のリポジトリ）・汎用シェルに読み込んだ旧い写しも含むので、PR-3 はこの repo の bash を世代化して狭めるだけで、旧い写しが無くなるまで残る（PR-2 の直し r7、レビュー a2 P3-2・PM の処分 3。表 F の `until` と同じ）。表 F の F71 は旧い書き手の 2 つの操作（`mv -f`・名前で消す）を持つので、操作ごとに `OLD-W-MV`・`OLD-W-APPEND` の 2 行に対応させる（`row65ByOp`）。

| 行 | 相手の版（旧い書き手） | Issue | 状態 | 形 |
|---|---|---|---|---|
| P-1 | 目印の pid・pgid で生死を読む旧い先頭・D6 のガード（#4288 の 1 番以降の VR・SJ・TS） | #4559 | closed | 引渡しを世代だけに書くと、旧い先頭が目印の親 pid を死と読んで回収し、旧い書き手と G の 2 者。目印への引渡しの写しを必須にして閉じた（§6.1） |
| P-1-PIDONLY | pid だけを読む旧い読み手（≤0.6.0 の VR・v0.50.0 以前の TS・PR1b より前の run-lock） | #4559 | open | P-1 と同じ形。目印の親 pid が死ねば、引渡し先の子が生きていても回収する。develop と同じ窓で、悪くならない |
| P-2 | §6.4 のうち死んだ記録を回収する全ての旧い版の回収者と書き手（develop の今の 3 実装・cmate-verify 0.7.0／0.8.0・≤0.6.0 の VR・npm の TS〔v0.50.0 以前・v0.51.0〜v0.55.1〕・PR1b／PR1c より前の写し） | #4559 | open | 前の世代の目印を外す判定と mv の間に、旧い回収者が回収して旧い書き手が取り、それを新版が退かす。UAT の `down`（needs-head）のたびに死んだ目印が残り次の保有者が外すので、毎回通る道 |
| P-3 | 塞ぎより古い写し（0.7.0 より前の SJ・PR1b より前の `run-lock.sh`・PR1c より前の `lib.sh`・汎用シェル） | #4559 | later-PR | 混在を終えて目印を外した後に、旧い書き手が `<name>.lock` を `mkdir` して取る。M3 の塞ぎで 3 値の観測を持つ旧い版は取れなくなる。それより古い写しは残る |
| P-4 | 目印の旧い版の保有者（`g=` の無い記録）と旧い書き手 | #4559 | open | 死んだと判定した旧い記録を新版が今の手順で回収する所に、#4559 の元の形（判定 → 長い停止 → 退かす）が残る。develop と同じ窓 |
| P-5 | §6.4 のうち死んだ記録を回収する全ての旧い版の止まった回収者と旧い書き手（P-2 と同じ版。読み直しの無い古い版ほど起きやすい） | #4559 | open | 止まった旧い回収者が新版の生きた目印を退かし、その間に旧い W が `mkdir` すると W と世代の保有者 X の 2 者。M1 では消えず、M3 を置いた名前でだけ消える |
| STALE-NEST | `run_lock_take_stale`・`product_lock_take_stale` を持つ旧い `run-lock.sh`・`lib.sh` | #4559 | open | 旧い `.stale.*` の戻し（`[ -e "$dir" ] \|\| mv "$aside" "$dir"`）の確かめと mv の間に新版が目印を `mkdir` すると、退避が目印の中に入れ子になる |
| M3-ERASE | PR1b より前の `run-lock.sh`（`ffcb54d05`）・PR1c より前の `lib.sh`（`5507b811e`） | #4559 | later-PR | M3 の塞ぎ（ファイル）を 1 分より古ければ消して取る（止まり無しで 2 者）。M3 を `~/.commandmate/locks` の名前に限って道ごと消す。M3 の PR で行として固定する |
| TICKET-DONE | 札の規約で待つ旧い版の書き手（develop の今の 3 実装） | #4560 | open | 札の done の照合 → `mv -f`（`lock_mark_done`）。新版どうしでは安全を世代が決めるので害にならず、旧い版との間でだけ札の取り違えとして残る |
| OLD-W-MV | 止まった旧い書き手（ticket の無い PR1b より前の `run-lock.sh`・supervisor.lock の書き手・汎用シェルに読み込んだ旧い写し） | #4559 | later-PR | 止まった旧い書き手が戻り、後継の目印の owner を名前で `mv -f` して置き換える（表 F の F49 と、F71 の `mv -f`）。新版の bash（PR-3）が入り、旧い写し（cmate-verify・汎用シェル）が無くなるまで残る |
| OLD-W-APPEND | 止まった PR1a の書き手（`: >` の後に `cat >>`、失敗で `rm -f owner`） | #4559 | later-PR | 札を外された旧い書き手が戻り、後継の目印の owner に名前で追記する・名前で消す（F50 と、F71 の名前で消す操作）。新版の bash（PR-3）が入り、旧い写し（cmate-verify・汎用シェル）が無くなるまで残る |
| OLD-W-INODE | PR1a より前の写し（`printf > owner`、旧い cmate-verify） | #4559 | later-PR | owner を開いた後に止まった旧い書き手が戻り、消された inode へ書いて持ったと信じる（F51）。新版の bash（PR-3）が入り、旧い写し（cmate-verify・汎用シェル）が無くなるまで残る |
| OLD-W-RMRF | 時計が戻った旧い書き手（PR1b より前の `run-lock.sh` など） | #4559 | later-PR | tmp を古いと読まれて外された旧い書き手が戻り、後始末の `rm -rf "$dir"` で後継の目印を名前で消す（F55）。新版の bash（PR-3）が入り、旧い写し（cmate-verify・汎用シェル）が無くなるまで残る |
| OLD-W-UNDO-CREATE | owner を名前で作る旧い書き手（`: >`・`printf >`） | #4559 | later-PR | 目印の公開の取り消し（undo）で owner が退いた瞬間に、旧い書き手が名前で owner を作り、戻しの link が EEXIST になる（F58）。新版の bash（PR-3）が入り、旧い写し（cmate-verify・汎用シェル）が無くなるまで残る |
| OLD-PUTBACK-OVERLAP | 目印の戻しを持つ旧い版（#4288 の 3 実装の旧い写し） | #4559 | later-PR | 新版どうしは L4 で閉じた F69 の形が、目印の上で旧い版の戻しと重なる所に残る（空いた名前への公開と戻しの EEXIST で 2 者。F69）。PR-3（bash の世代化）で閉じる |

---

## 7. 模型（T1）

`tests/unit/verification/lock-generation-model-4559.ts`（抽象の模型。実装のコードではない）と `machine-lock-generation-model-4559.test.ts`。各者は任意の点で任意に遅れ（交互の順の網羅＝停止の長さ・回数に上限なし）、任意の点で死に、片付けは任意の時に走る。

### 7.1 組と結果（開発機、2026-11-26）
模型は引渡しを 1 回の保有につき 2 回まで（`owner.h1`・`owner.h2`。子は 1 つずつ）許し、解放はその保有の終わった子を片付ける。組 (iii) だけ、自分の `owner` を `link` した後に諦める歩（`abort`。§4.1 の諦める道）を入れる。(i)・(iii) は S1・S2 と S4 を 1 回の歩きで確かめる。

| 組 | 結果 | 状態の数（下限） | 活性の始まりの数 |
|---|---|---|---|
| (i) 2 者・2 回・死 1・片付け・世代 3・引渡し 2 回まで | S1・S2・S4 の違反 0 | 4,355,965（4,300,000） | 1,663,112 |
| (ii) 2 者・3 回・死 0・片付け・世代 4 | S1・S2 の違反 0 | 2,382,499（2,350,000） | — |
| (iii) 2 者・1 回・死 1・片付け・世代 3・引渡し 2 回まで・諦める歩 | S1・S2・S4 の違反 0 | 1,084,711（1,050,000） | 347,072 |
| (ii) の引数で、`h1` の子が走っている保有者から始める探索 | S1・S2 の違反 0 | 1,094,277（1,050,000） | — |

到達の数（どれも 1 以上を T1 が確かめる。組の作りで届かないものは「—」）:

| 組 | REC | WD | GCLIVE | TOMBWIN | WRITERWIN | HOREL | LOOSE | LSTATH2 | DEADREC | HOLDERDIE | ABORT |
|---|---|---|---|---|---|---|---|---|---|---|---|
| (i) | 840 | 1,872 | 768 | 27,572 | 103,524 | 118,008 | 18,024 | 22,262 | 6,930 | 290,298 | — |
| (ii) | 3,220 | 4,742 | 972 | 46,454 | 68,854 | — | 28,828 | — | — | — | — |
| (iii) | 992 | 2,028 | 696 | 5,058 | 20,324 | 27,952 | 6,328 | 3,580 | 1,602 | 70,690 | 13,394 |
| (ii) の始まりを変えた探索 | | | | | | 7 | | 1 | 1 | | |

- 到達の数は生まれた遷移の回数（異なる状態の数ではない）。`REC` 作り直し・`WD` 身を引く・`GCLIVE` `end` の無い最大でない世代を片付けで消した（生きた保有者の世代ではない）・`TOMBWIN` 墓が勝つ・`WRITERWIN` 書き手が勝つ・`HOREL` 子の記録を持つ世代の解放（前の周の子を持ち越した解放は数えない）・`LOOSE` 緩めた C4 の枝・`LSTATH2` 回収者の読み直しが `h2` 以降を `lstat` した（`h1` 以降を判定した後。`h2` が在ったかは数えない。§7.5）・`DEADREC` 回収者が記録を持つ世代を終えた・`HOLDERDIE` 保有中の死・`ABORT` 諦める歩
- 元の模型（`gen-model3.mjs` v3.1、`C4_LOOSE=1`）との一致は、移した時（コミット `03ea0b594`）に確かめた（(i) 1,896,871・(ii) 2,382,499、厳しい C4 で (i) 1,908,881。壊した版 5 つも一致）。その後に引渡しを 2 回にし、諦める歩を足したので (i) の数は変わった。(ii) は引渡しも諦める歩も無いので元のまま
- 身を引く場合の `end` を外した形（一覧に入れない。§4.1）は、移した時の模型で (i) 1,899,175・(ii) 2,411,873・(i) 厳しい C4 1,911,185 状態、どれも S1・S2・S4 の違反 0
- 3 者の全体の網羅は入れない（時間の予算の外）

### 7.2 壊した版（どれも赤であること）
この表は模型の `MUTANT_TABLE` から作る（手で直さない。T7 が 1 字も違わないことを確かめる）。T1 の行と題もこの表から作る。模型の中で壊した版を見る所は全部 `pick` を通り、表の「変える歩」以外の歩で呼ばれると投げる。赤の跡は、その壊した版が元と違う決め方をした歩（`*` の付いた歩）を必ず通る。

| 壊した版 | 見る性質 | 組 | 変える歩 | 崩す名前 | 歩きが届く到達の数 | 変える所 | 赤 |
|---|---|---|---|---|---|---|---|
| `gc-max` | S1・S2 | (i) | gc-list | L1・C1 | GCLIVE | 片付けが最大の世代も選ぶ | 5,596 状態で最初の違反 `live holder 1 displaced`。S1 だけ・S2 だけを見ても赤 |
| `no-postcheck` | S1・S2 | (ii) | a3 | L3 | — | 取得の後の一覧を外す（`owner` を `link` したらすぐ保有者） | 100,958 状態で最初の違反 `live holder 1 displaced`。S1 だけ・S2 だけを見ても赤 |
| `tomb-separate` | S1・S2 | (i) | j0 | L4 | — | 墓を `owner` と別の名前にする（主の無い世代に墓を奪い合わずに `end` を書く） | 34,622 状態で最初の違反 `live holder 1 displaced`。S1 だけ・S2 だけを見ても赤 |
| `no-relist` | S1・S2 | (i) | jk | L5・C3 | DEADREC | 全員死の後の読み直しを外す | 21,124 状態で最初の違反 `live holder 1 displaced`。S1 だけ・S2 だけを見ても赤 |
| `relist-h1-only` | S1・S2 | (i) | jr | C3 | LSTATH2 | 読み直しがいつも `h1` を見る（判定した最後の `h<k>` の次ではなく） | 21,158 状態で最初の違反 `live holder 1 displaced`。S1 だけ・S2 だけを見ても赤。対照: 引渡しを 1 回までにすると緑 |
| `release-live-child` | S1・S2 | (i) | h | — | HOREL | 子が走っている間に解放する（§4.2） | 18,552 状態で最初の違反 `live holder 1 displaced`。S1 だけ・S2 だけを見ても赤 |
| `c4-stuck` | S4 | (i) | a1・j0・jr | C4 | — | 消えた世代を永遠に待つ | S4 で輪（安全は 4,344,145 状態で違反 0） |
| `no-tomb` | S4 | (i) | j0 | — | — | 主の無い世代に墓を置かず、そこで待ち続ける（§4.4） | S4 で輪（安全は 1,833,021 状態で違反 0） |
| `abort-no-end` | S4 | (iii) | abort | — | ABORT | `owner` を `link` した後に諦めるとき、自分の世代に `end` を書かない（§4.1） | S4 で輪（安全は 281,609 状態で違反 0） |

- 空振りの壊した版は試験で弾く: T1 は表の全部を流して、記録した数どおりの赤と `*` の歩を求める。一覧にあって赤でないもの・変える歩の外で効くものがあれば T1 が赤
- 新しい壊した版は、模型で赤を確かめてから表に足す（この節は表から作り直す）
- 身を引く場合の `end` を外した形は空振りだったので表に入れない（§4.1・§7.1）

### 7.3 T1 が確かめる名前
この表も模型（`MUTANT_TABLE` の「崩す名前」「見る性質」と、壊した版を使わずに網羅で確かめる名前の鍵 `WALK_CHECKS`）から作る。`WALK_CHECKS` は名前から T1 が流す歩き（`WALK_RUNS` の `walk-i` など。T1 の組の行と題はこの表から作る）への鍵で、その歩きが確かめるもの（S1・S2、活性の歩きは S4）でない名前を置くと模型が読み込みで投げる。§5 の「確かめる所」は模型から作った文と 1 字も違わない（T1 の名前は `T1（§7.3）`、それ以外は模型の `NOT_IN_MODEL` の文）。

| 名 | T1 での確かめ |
|---|---|
| L1 | `gc-max` が赤（§7.2） |
| L3 | `no-postcheck` が赤（§7.2） |
| L4 | `tomb-separate` が赤（§7.2） |
| L5 | `no-relist` が赤（§7.2） |
| C1 | `gc-max` が赤（§7.2） |
| C3 | `no-relist`・`relist-h1-only` が赤（§7.2） |
| C4 | `c4-stuck` が赤（§7.2） |
| S1 | `walk-i`・`walk-ii`・`walk-iii`・`seeded-ii` で違反 0。`gc-max`・`no-postcheck`・`tomb-separate`・`no-relist`・`relist-h1-only`・`release-live-child` が赤（§7.2） |
| S2 | `walk-i`・`walk-ii`・`walk-iii`・`seeded-ii` で違反 0。`gc-max`・`no-postcheck`・`tomb-separate`・`no-relist`・`relist-h1-only`・`release-live-child` が赤（§7.2） |
| S4 | `walk-i`・`walk-iii` で他の者が全員終わった全ての状態から残る 1 者が保有者になる。`c4-stuck`・`no-tomb`・`abort-no-end` が赤（§7.2） |

### 7.4 1 歩にまとめた所と、模型に入れていないもの
- 1 歩にまとめた所は、使う事実が単調（一度真なら真のまま）なので、分けても同じ: 取得の後の一覧と身を引く `end`（`gen-postlist`・`gen-withdraw-end`。「自分より大きい世代が在る」は L1 で真のまま）、一覧と片付けの選び（`gc-list`・`gc-judged`。「最大より小さい」は L1 で真のまま）、引渡しの記録・子の起動・合図（子は記録の後にしか始まらない）。一覧は正確な一覧として扱う（C2 で最大は見落とさない）
- 入れていないもの（T2 へ名指し）: owner の tmp → link の 2 段と tmp の片付け（C8）、`rm -rf` の途中の形（`end` だけ消えた世代・ENOTEMPTY）、readdir の走査中の作成と削除（C2）、目印と旧い版（T5）、EIO の種類（模型の諦める歩が「取得の後の一覧が読めない」の結果だけを表す。T6）、pid の再利用と他ホスト（P1）、札、`fields`、`.gen` の作成（C6）、12 桁の名前の解析（C5）、by-path の名前（C7）、§4.1 の 6 の多重の防御、墓の猶予（模型は猶予ゼロで安全の側）、子の合図の期限、3 回目以降の引渡し（2 回で k ≥ 1 の読み直しに届く）。保有者でない者の解放は回収の核だけ（§4.2）なので、模型の回収者の歩で表す
- 模型の限界: (1) S4 は「他の者が全員終わった状態から」なので、生きた保有者が解放しないまま止まり続ける形は S4 の範囲の外（模型では `HOREL` などの到達の数が 0 になることで一部を捕まえる）。(2) 1 者の子は保有ごとに数え直すが、壊した版 `release-live-child` では前の保有の子が残ったまま同じ者が次の保有者になりうる（S1 の数えで 1 者として数える）。安全の側の数え漏れにはならない。(3) T1 の自己の確かめ（変える所を外した `abort-no-end` が同じ呼び方で緑）は (iii) の歩きと重なる。呼び方の形を固定するために残す

### 7.5 人が読む所（機械で閉じない）
- 模型の網羅に頼るが T1 の確かめに結べない名前（§5 では「模型の網羅（§7.5。人が読む）」）: L2・S3
  - L2（判定は変わらない事実だけ）・S3（止まった者が戻っても壊さない）は、停止の長さ・回数に上限の無い交互の順の網羅（§7.1 の全部の歩き）が裏付けるが、その性質だけを確かめる `it` は無い。網羅が S1・S2 を確かめることと、この 2 つの文が同じことを言っているかを人が読む
- §7.2 の「歩きが届く到達の数」は、その壊した版の組の歩き全体（最初の違反・失敗まで）が数えた到達の数で、赤の跡の上の数ではない。赤の道に変える歩があることは `*` の照合が担う
- 到達の数の意味と、それを数えるコードの対応（例: `LSTATH2` は「読み直しが `h2` 以降を `lstat` した〔`h1` を判定した後〕」で、`h2` が在った道を数えるわけではない。2 回目の引渡しの道に届くことは `relist-h1-only` の赤と対照〔引渡し 1 回で緑〕で示す）
- 壊した版の行の「変える所」の文と、その「変える歩」のコード（`pick` の呼び出し）が同じことを言っているか。`pick` が歩を強制するので、読む所はその歩の 1 か所に限られる
- §7.1 の数（組の状態の数・到達の数）は実測の記録。T1 は下限と 1 以上だけを確かめる（壊した版の数は §7.2 で T1 が完全に確かめる）

---

## 8. 試験の計画

### 8.1 T1〜T7
- **T1 模型の網羅**（PR-1）: §7。S1・S2 の違反 0、到達の数が各 1 以上（組で届かない数は手で作った初期状態から始める探索で埋める）、状態の数が実測より数 % 下の下限を超える、壊した版は模型の表（§7.2）の全部を流し、記録した数・最初の違反・`*` の歩（`pick` が強制する変える歩）・届く到達の数・対照を確かめる（行と題は表から作る）、活性 S4 とその壊した版、引数の検査、変える歩を移した模型の写しが投げること。組の行と題は模型の `WALK_RUNS` から作る。§5 の名前は T1 の確かめ（§7.3。`WALK_CHECKS` の鍵か壊した版）と模型の `NOT_IN_MODEL` に分け、どちらにも結べない名前は模型が読み込みで投げる。模型のソースで壊した版を読むのは `checkConfig` と `pick` だけ、壊した版の名前を書くのは表の行と `pick` の呼び出しだけ、を走査で確かめる（迂回する分岐を足した写しは赤）。各 `it` に明示の timeout
- **T2 実装の行列**（PR-2・PR-3）: 直積はやめ、「各継ぎ目 × 各差し込み（止まる・SIGKILL・EIO 1 回）に少なくとも 1 行」の被覆（T3 が保証）。継ぎ目の案: 取得 `gen-list`・`gen-end-read`・`gen-mkdir`・`owner-tmp-opened`・`owner-tmp-written`・`owner-linked`・`owner-tmp-removed`・`gen-postlist`・`gen-withdraw-end`／回収 `holder-read`・`holder-judged`・`holder-relist`・`end-tmp`・`end-linked`／墓 `ownerless-judged`・`tomb-linked`・`tomb-end`／引渡し `handoff-tmp`・`handoff-linked`／解放 `beacon-release`・`release-end`／片付け `gc-list`・`gc-judged`・`gc-rm`／目印 `beacon-mkdir`・`beacon-published`・`beacon-prev-judged`。交差の順（A 止まる → B 止まる → A 再開 → B 再開）を作るため、SJ の核に `lock_test_pause` と同じ形のファイルの止める口（env で既定は無効、回数つき `pause:<stage>#<n>`）を足し、JS の行為者は別のプロセスで動かす（前例 `tests/unit/verification/fixtures/lock-actor-4277.mjs`）。継ぎ目の名前は 1 か所 1 名。TS は SJ の核を import するので行列から外し、「TS に独自のファイルの操作が無い」ことを走査で固定する。**PR-2 で決まった継ぎ目の名前**（核のソースの `seam('<段>')` と `GEN_WRITES` の表が正。T2 がソースから集めて行と突き合わせる）: 取得 `gen-list`・`gen-parent-mkdir`・`gen-dir-mkdir`・`gen-end-read`・`gen-mkdir`・`gen-tmp-mkdir`・`gen-owner-tmp`・`gen-owner-linked`・`gen-owner-failed`・`gen-postlist`・`gen-withdraw-end`／回収 `holder-read`・`holder-judged`・`holder-relist`・`end-tmp`・`end-linked`／墓 `ownerless-judged`・`tomb-tmp`・`tomb-linked`・`tomb-end`／引渡し `gen-handoff-tmp`・`handoff-linked`／`fields` `fields-rename`／解放 `beacon-release`・`release-end`／片付け `gc-judged`・`gc-rm`・`gc-tmp-rm`／目印 `beacon-prev-judged`。目印の取得の段は #4288 の `owner-lock-made`・`owner-tmp-opened`・`owner-tmp-written`・`owner-linked`・`owner-tmp-removed` のまま（`hooks.onOwnerStage`。名前を変えると既存の試験の止め所が動くので、案の `beacon-mkdir`・`beacon-published` は作らない）。止める口は bash の `lock_test_pause` と同じ env（`CM_VERIFY_TEST_HANDOFF=pause:<段>#<n>`・`CM_VERIFY_TEST_HANDOFF_DIR`。新しい env は足さない）オラクルは行為者の出来事の記録から数え、「取得を返した時点で生きた保有は自分だけ」「生きた保有者の世代に `end` が付かない」を別々に比べる。生死は引渡しの後はグループで数える。`/var`・`/private/var` の 2 通りで同じ `by-path` の名前になる行（C7）、APFS の readdir の行（C2）、合図の無い子が始まらない行（L5）
- **T3 継ぎ目の網羅のガード**（PR-2 の JS・PR-3 の bash）: 前例の生の操作の走査（`lock-observation-scan-4288.ts`）を広げる。名前を変える生の操作（`mkdir`・`link`・`rename`／`mv`・`rm -rf`・`rmdir`・`unlink`）が、表の 1 行（判定・操作・前の継ぎ目・模型の歩）に必ず対応し、操作の直前に継ぎ目が在ることをソースの並びで確かめる。核の外で `end` を作る呼び出しは赤。生の呼び出しを許す関数の一覧を閉じる。自己の確かめ（継ぎ目の無い `rm -rf` を足した写しは赤）。世代の名前の書式（C5）と by-path の hash の書き方（C7）を 3 実装で比べる。**TS は SJ の核をバイトのまま写した生成物（`src/lib/verification/machine-lock-sync-core.generated.ts`）を import する。写しは一致の試験（`machine-lock-sync-core-copy-4559.test.ts`）で固定し、走査は一致を前提に写しを除く**（#4559 コメント 7177395611 の案 F）。表は §8.3。**公開の関数のゲート**（PR-2 の直し r7、PM の処分 1）も T3 に置く: 公開の関数 × 観測点 × 3 値の表を機械で作り（§8.4）、全ての行を確かめる
- **T4 名前のある回帰**: #4559 の元の再現・読み直しの後の停止・戻しの ENOENT の後の `rm -rf` は、develop で赤・案 A で緑の行（旧い書き手が混ざる行は `mixed` として赤のまま）。身を引く操作の再試行などは「同じ停止の順を世代の手順に掛けて S1・S2」を確かめる行。各行に行為者の版（新・旧）を書く
- **T5 混在の間**: 旧い版の写しを `tests/fixtures/machine-lock-legacy/<版>/` に commit する（CI の checkout は depth 1 の見込みで `git show` できない。`2288ff855`〔≤0.6.0〕・`85352db6f`〔0.7.0〕・`cfffb31c9`〔0.8.0〕・`44dcf038f`〔npm TS v0.51.0〜v0.55.1〕・v0.50.0 以前の npm TS〔sha は PR-3 で pin〕・`ffcb54d05`〔旧 run-lock〕・`5507b811e`〔旧 lib.sh〕・develop の今）。写しは拡張子を替えて置き（`machine-lock-sync.mjs.txt` など。lint・tsconfig の設定には触れない）、試験の時に一時のディレクトリへ `.mjs` として書き出す。出所の pin（sha と sha256）を同じ所の `pin.json` に置き、試験で sha256 を確かめる（PM の決定、lead-plan §8）。PR-2 は develop 690caa46a の `machine-lock-sync.mjs`・`machine-lock.ts` だけ、ほかの版は PR-3。`g=` の codec の行、戻しの後も `g` が残る行、M3 の塞ぎを旧 run-lock・旧 lib.sh が消す行、版の印を置く・取り消すの各点で死ぬ行。目印と旧い書き手 1 者の小さな模型で `mixed` の行が赤のまま（名指した窓）であることを固定する
- **T6 一時の失敗**: 新しいファイルにせず、既存の `lock-observation-points-4288.test.ts` の差し込みの表に世代の点を足す。SJ・TS の `hooks.fault` に回数を持たせる。EIO 1 回は次の周で回復して名指し、続くときは取らない・消さない
- **T7 文書のガード**（PR-1）: 照合はどれも完全一致で、行の形の場合分けをしない。§7.2・§7.3 は模型から作った表と 1 字も違わないこと。§6.5（`mixed`）・§5 は設計書が正の表で、解析して書き戻した表が節の表と 1 字も違わないこと（往復。表の範囲は GFM のとおり始まりから最初の空行まで、節の中の表は 1 つ）と、行が名指した窓・模型の名前と一致すること。§2 は節の全文を T7 に持って完全一致。§5 の「確かめる所」は模型から作った文と完全一致。§7.5 は `HUMAN_READ` の行を持つ。照合の前に HTML の注釈を除き（注釈に隠した表・文は描かれない）、使う見出しは 1 つだけ。自己の確かめ: 行・Issue 番号を消した写し、Issue が `—`・小文字の ID・backtick の ID・先頭が空白・空行の直後・`|` の無い直後の行・2 つ目の表・`| C10 |`・名前の書き替え・新しい補題に `T1（§7.3）`・組の書き替え・§7.3 の行の書き替え・保証の文の否定・前提を消す、表の変える歩を書き替えた模型の写し、注釈に隠した §6.5・§7.2 の表と §2 の文、同じ見出しの 2 つ目、§2 に打ち消す文、C5 の T3→T2、§5・§7.3 に足した L6、§7.5 の名前の書き替え、どれも赤。表 F（4288 の文書）との対は PR-2 で足した: 表 F の `mixed` の行（雛形 `machine-lock-owner-atomic-4288.test.ts` の `limit.row65`）がどれも §6.5 の行を 1 つ名指し、名指された行の集まりが §6.5 の `open`・`later-PR` の行（M3 の PR の `M3-ERASE` を除く）と一致し、`closed` の行は名指されない（往復。自己の確かめ: 行を消した §6.5・名指しの無い行・§6.5 に無い行の名指し・`closed` の名指し・誰も名指さない `open` の行）
- すべて `tests/unit/verification/` に置き、既存の unit のゲートに乗せる（新しいゲートは要らない）。共通の台は `tests/unit/verification/lock-generation-4559-harness.ts`（PR-2）

### 8.2 時間の予算
CI は `fileParallelism: false`・負荷が高いので、1 ファイルの単独の走りを開発機で測り、余裕を持って決める。

| ファイル | PR | 予算（開発機の単独の走り） | 実測 |
|---|---|---|---|
| `machine-lock-generation-model-4559.test.ts`（T1） | PR-1 | 90 秒・最大 RSS 1.5 GB | 約 20 秒・約 0.9 GB（2026-11-26。状態は 5 ビットずつ詰めた表に持つ）。PR-2 の後の再走り 19.1 秒・900 MB（34 行、模型は変えていない） |
| `machine-lock-generation-doc-4559.test.ts`（T7） | PR-1 | 5 秒 | 1 秒未満（PR-2 の表 F との対を足して 50 行・0.7 秒） |
| `machine-lock-generation-4559.test.ts`（T2・T4・T6 の JS） | PR-2 | 60 秒（超えるならファイルを分ける） | 13.3 秒・192 MB（98 行。2026-11-26、PR-2 の作業木）。r7 の後 22.6 秒・239 MB（138 行。T2 の交差の行は B が止まるまで最長 8 秒待つ） |
| `machine-lock-generation-seams-4559.test.ts`（T3） | PR-2・PR-3 | 30 秒 | 0.7 秒・177 MB（自分の墓の 3 行を足す前の 8 行。2026-11-26）。r7 の §8.4 のゲート（297 行 × 3 値の走り、壊した写し 2 つ）を足して 6.3 秒・226 MB（20 行）。r8 の届いた回ごとの行（864 行、2 回目以降 239 行）と壊した写し 10 本で 14.9 秒・350 MB（29 行） |
| `machine-lock-generation-mixed-4559.test.ts`（T5） | PR-2（新 JS × 今の bash・旧い JS の写し × 新 JS）・PR-3（bash の新版） | 60 秒（bash の別プロセスの行は 1 マス 1〜2 秒の見込み） | PR-2 の 4 行で 2.5 秒・187 MB（2026-11-26） |

### 8.3 名前を変える操作と直前の継ぎ目（T3 の表。`tests/unit/verification/lock-generation-4559-harness.ts` の `OPS` から作る。手で直さない）
T3 が核のソースを走査して関数・操作・数がこの表と一致し、継ぎ目の列が `—` でない操作の直前の行に `seam('<段>')` が在ることを確かめる。`—` は #4288 の目印の手順（旧い版のために残す、§6）と観測の関数そのもの。

| 関数 | 操作 | 数 | 直前の継ぎ目 | 何を | 模型の歩 |
|---|---|---|---|---|---|
| `makeObserver` | `fs.mkdirSync` | 1 | — | the observer of mkdir (every obs.mkdir) | — |
| `makeObserver` | `fs.renameSync` | 1 | — | the observer of rename | — |
| `makeObserver` | `fs.linkSync` | 1 | — | the observer of link | — |
| `makeObserver` | `fs.unlinkSync` | 1 | — | the observer of unlink | — |
| `makeObserver` | `fs.rmdirSync` | 1 | — | the observer of rmdir | — |
| `rmQuiet` | `fs.rmSync` | 1 | — | the one clean-up delete | — |
| `markDone` | `fs.renameSync` | 1 | — | a ticket marked used (§4.7) | — |
| `markDone` | `rmQuiet` | 1 | — | its tmp | — |
| `takeTicket` | `fs.mkdirSync` | 1 | — | the queue directory | — |
| `takeTicket` | `rmQuiet` | 1 | — | the ticket tmp | — |
| `collectGarbage` | `rmQuiet` | 2 | — | used tickets, old ticket tmps | — |
| `claim` | `obs.mkdir` | 1 | — | the <lock> (beacon, §6.1) | — |
| `publishOwner` | `obs.unlink` | 1 | — | the beacon owner's own tmp | — |
| `publishOwner` | `obs.rmdir` | 1 | — | the own empty <lock> | — |
| `publishOwner` | `obs.link` | 1 | — | the beacon owner | — |
| `undoPublish` | `obs.unlink` | 3 | — | the undo (I2-b) | — |
| `undoPublish` | `obs.rename` | 1 | — | the undo (I2-b) | — |
| `undoPublish` | `obs.rmdir` | 1 | — | the undo (I2-b) | — |
| `undoPublish` | `obs.link` | 1 | — | the undo (I2-b) | — |
| `expireOwnerless` | `obs.unlink` | 1 | — | an owner-less <lock>'s tmps (I3) | — |
| `expireOwnerless` | `obs.rmdir` | 1 | — | an owner-less <lock> (D3) | — |
| `reclaimEmptyOwner` | `obs.rename` | 1 | — | an empty owner aside (I4) | — |
| `reclaimEmptyOwner` | `rmQuiet` | 1 | — | the own aside | — |
| `rmdirQuiet` | `fs.rmdirSync` | 1 | — | an empty directory | — |
| `moveOwnerIn` | `obs.link` | 1 | — | the put-back (§2.7) | — |
| `moveOwnerIn` | `rmQuiet` | 1 | — | the aside after the put-back | — |
| `moveOwnerIn` | `rmdirQuiet` | 1 | — | the put-back's own <lock> | — |
| `restoreFromGone` | `obs.mkdir` | 1 | — | the put-back's <lock> | — |
| `restoreFromGone` | `rmdirQuiet` | 1 | — | the put-back's own <lock> | — |
| `reclaimGone` | `obs.rmdir` | 1 | — | a half put-back | — |
| `reclaimGone` | `obs.rename` | 1 | — | an aside to the own name | — |
| `reclaimGone` | `rmQuiet` | 1 | — | the own aside judged gone | — |
| `settleGone` | `rmdirQuiet` | 1 | — | an empty aside | — |
| `recoverLock` | `obs.rename` | 1 | — | an older holder's <lock> aside (P-4) | — |
| `recoverLock` | `rmQuiet` | 2 | — | the own aside | — |
| `recoverLock` | `obs.mkdir` | 1 | — | the put-back's <lock> | — |
| `recoverLock` | `obs.link` | 1 | — | the put-back | — |
| `recoverLock` | `rmdirQuiet` | 1 | — | the put-back's own <lock> | — |
| `makeRoot` | `obs.mkdir` | 1 | — | the machine-lock root (mkdir -p) before the chain is chosen, observed at gen-root-mkdir (C7-I2, r7) | — |
| `collectGens` | `rmQuiet` | 2 | gc-rm・gc-tmp-rm | rm -rf g<k> (k < the largest listed, C1); an old tmp (C8) | g1 |
| `linkIntoGen` | `obs.mkdir` | 1 | gen-tmp-mkdir | the tmp directory | — |
| `linkIntoGen` | `obs.link` | 1 | <use>-tmp | owner / owner.h<k> / tomb / end into g<N> (L4) | a3・h・j1・j2・r0・a4 |
| `linkIntoGen` | `obs.unlink` | 1 | <use>-linked | the own tmp | — |
| `takeGeneration` | `obs.mkdir` | 3 | gen-parent-mkdir・gen-dir-mkdir・gen-mkdir | the parent of .gen (by-path/, observed: r7); .gen (C6); mkdir g<M+1> | a2 |
| `machineLockAcquisition` | `rmQuiet` | 2 | —・beacon-release | an own tmp of setOwnerFields / handOff; the <lock> at the release (§6.1: before end) | r0 |
| `machineLockAcquisition` | `fs.linkSync` | 1 | — | the ticket's link | — |
| `machineLockAcquisition` | `fs.mkdirSync` | 1 | — | the root of the lock | — |
| `machineLockAcquisition` | `fs.renameSync` | 2 | fields-rename・— | g<N>/fields; the beacon's copy of the fields | — |
| `machineLockAcquisition` | `obs.rename` | 1 | — | the beacon's D4 hand-off (after owner.h<k>, §4.6) | — |
| `asHead` | `fs.linkSync` | 1 | — | the ticket's link | — |

### 8.4 公開の関数 × 観測点 × 届いた回 × 3 値（ゲートの表。`tests/unit/verification/lock-generation-4559-harness.ts` の `buildTable` が作る。手で直さない）
PR-2 の直し r7（PM の処分 1）を、r8（レビュー a3 P2-2 ＝ b3 P2-1）で機械で決まる形にした。
- **関数**: 核のソースを構文で読み（`parseCore`。TypeScript の構文木）、export の全ての書き方（`export function`・`export async function`・`export function*`・`export const X = (…) =>`・`export const X = function`・`export default`・`export { … }`）を拾う。読めない形の export（`export *`・`export class`・分割の `export const` など）は投げる（赤）。拾った名前の集まりは import した module の鍵と完全一致し、関数かどうかも module の値の型と一致する。そのうち、呼び出しが鎖の観測に届く関数と、保有の handle の method（`handle.*`）が公開の関数
- **関数ごとの点**: 同じ構文木で、関数の呼び出しを辿って届く鎖の側の関数（核の「The generation chain」の行より後）の観測点（`obs.<op>('<点>'`・`hooks.fault?.('<点>'`・GEN_WRITES の `put`／`link`・引数で渡す点）を集める。関数ごとに、届きうる点のどれかに行が無ければ赤。行より前の #4288 の関数の点は、観測の表（`lock-observation-points-4288` が点 × 実装の全てに差し込む）の行であることを確かめる
- **場面**（`TABLE_SCENARIOS`）は、その関数の走りを点に届かせる準備だけ（disk の状態と、分岐へ入れる故障 `base`）。行は、場面の resolved の走りで届いた点の**到達の回 k（1 … 届いた回数）ごと**で、その回だけを absent（ENOENT）・unknown（EIO）に替えてもう一度走らせる
- 欄は答えと、走りの前からの disk の変化（`gN end <種類>`・`new gen`〔`open` は `end` が無いまま〕・`lock <token> gone`／`put`・`gN records +k`）
- T3 のゲート（`machine-lock-generation-seams-4559.test.ts`）は全ての行で確かめる: unknown の行（と鎖の選びの点 `gen-realpath`・`gen-root-mkdir` の absent の行）は、その回に届いた時の disk より先の判断（`end`・目印の取り外し・世代の作成・取得／`released`／`removed`／引渡し／`fields`）を進めず、その回に届き、答え（または warn の行・投げた文）が点の名前と errno を名指す（名指しを求めるのは鎖の点〔観測の表の #4559 の行〕。#4288 の目印の点の答えは #4288 のまま）。失敗した回をもう一度読み（その点に resolved の走りより多く届き）resolved と同じ答え・変化になった行は、次の回の行が確かめる。どの欄でも `released` は `end` と一緒（`beacon-gen-end` の absent は世代が消えた＝終わった〔L1〕なので除く）。掃除の点（自分と古い tmp・目印の退避の一覧など）だけは理由つきで `NON_BLOCKING`（7 件）に名指し、unknown でも resolved と同じ答え・変化であることを確かめる
- 壊した写しの赤も試験の中で確かめる: releaseAsHead が鎖の不明の周に目印を外す（5c6ade92d の形）・表に無い公開の関数（export の 7 つの書き方）を足す・保有の記録の unknown を resolved に読む・2 回目の到達の unknown だけを resolved に読む・711f50192 の 3 つの道（読み直しの失敗を捨てる・busy／young／again を終わりと読む・`end` の link の ENOENT を終わりと読む）・`readHolder` が読めない `fields` を越えて世代の保有者を答える／名指さない・引渡しのグループの不明を空と読む

| 関数 | 場面 | 観測点 | 回 | 届いた回数 | resolved | absent | unknown |
|---|---|---|---|---|---|---|---|
| `acquireMachineLockSync` | dead-group-holder | `beacon-gen-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (beacon-gen-end EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `end-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-link EIO) |
| `acquireMachineLockSync` | dead-group-holder | `end-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT) | not acquired (end-tmp EIO) |
| `acquireMachineLockSync` | dead-group-holder | `gen-end-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-end-read EIO) |
| `acquireMachineLockSync` | dead-group-holder | `gen-fields-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-fields-read EIO) |
| `acquireMachineLockSync` | dead-group-holder | `gen-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `acquireMachineLockSync` | dead-group-holder | `gen-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 end dead | not acquired (gen-mkdir EIO); g1 end dead |
| `acquireMachineLockSync` | dead-group-holder | `gen-owner-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 gone, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `gen-owner-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 end dead, new gen | not acquired (gen-owner-tmp EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `gen-postlist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 end dead, new gen | not acquired (gen-postlist EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `gen-realpath` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | dead-group-holder | `gen-realpath` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | dead-group-holder | `gen-root-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `acquireMachineLockSync` | dead-group-holder | `gen-tmp-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-group-holder | `gen-tmp-mkdir` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `acquireMachineLockSync` | dead-group-holder | `gen-tmp-mkdir` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 end dead, new gen | not acquired (gen-tmp-mkdir EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `gen-tmp-unlink` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-group-holder | `gen-tmp-unlink` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-group-holder | `gen-tmp-write` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `acquireMachineLockSync` | dead-group-holder | `gen-tmp-write` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 end dead, new gen | not acquired (gen-tmp-write EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `gen-verify-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `gen-verify-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 end dead, new gen | not acquired (gen-verify-owner EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `group` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (group ENOENT); g1 end dead, new gen | not acquired (group EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `holder-group` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-group ENOENT) | not acquired (holder-group EIO) |
| `acquireMachineLockSync` | dead-group-holder | `holder-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-pid ENOENT) | not acquired (holder-pid EIO) |
| `acquireMachineLockSync` | dead-group-holder | `holder-read` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `acquireMachineLockSync` | dead-group-holder | `holder-read` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `acquireMachineLockSync` | dead-group-holder | `holder-relist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-relist EIO) |
| `acquireMachineLockSync` | dead-group-holder | `list-queue` | 1 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired |
| `acquireMachineLockSync` | dead-group-holder | `list-queue` | 2 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-group-holder | `list-queue` | 3 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `acquireMachineLockSync` | dead-group-holder | `list-queue` | 4 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO); g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-group-holder | `list-root` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `list-root` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-group-holder | `lock-owner` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `lock-owner` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `mkdir-lock` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, new gen | throws EIO; g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `mkdir-lock` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-group-holder | `owner-close` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-group-holder | `owner-create` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-group-holder | `owner-fields` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `acquireMachineLockSync` | dead-group-holder | `owner-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `acquireMachineLockSync` | dead-group-holder | `owner-publish` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-group-holder | `owner-readback` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, lock D gone, lock new put, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-group-holder | `owner-unlink` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-group-holder | `owner-write` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-group-holder | `owner-write-short` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-group-holder | `pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (pid ENOENT); g1 end dead, new gen | not acquired (pid EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `recover-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `acquireMachineLockSync` | dead-group-holder | `rename-aside` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `beacon-gen-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (beacon-gen-end EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `end-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-link EIO) |
| `acquireMachineLockSync` | dead-holder | `end-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT) | not acquired (end-tmp EIO) |
| `acquireMachineLockSync` | dead-holder | `gen-end-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-end-read EIO) |
| `acquireMachineLockSync` | dead-holder | `gen-fields-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-fields-read EIO) |
| `acquireMachineLockSync` | dead-holder | `gen-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `acquireMachineLockSync` | dead-holder | `gen-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 end dead | not acquired (gen-mkdir EIO); g1 end dead |
| `acquireMachineLockSync` | dead-holder | `gen-owner-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 gone, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `gen-owner-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 end dead, new gen | not acquired (gen-owner-tmp EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `gen-postlist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 end dead, new gen | not acquired (gen-postlist EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `gen-realpath` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | dead-holder | `gen-realpath` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | dead-holder | `gen-root-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `acquireMachineLockSync` | dead-holder | `gen-tmp-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder | `gen-tmp-mkdir` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `acquireMachineLockSync` | dead-holder | `gen-tmp-mkdir` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 end dead, new gen | not acquired (gen-tmp-mkdir EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `gen-tmp-unlink` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder | `gen-tmp-unlink` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder | `gen-tmp-write` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `acquireMachineLockSync` | dead-holder | `gen-tmp-write` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 end dead, new gen | not acquired (gen-tmp-write EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `gen-verify-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `gen-verify-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 end dead, new gen | not acquired (gen-verify-owner EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `holder-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-pid ENOENT) | not acquired (holder-pid EIO) |
| `acquireMachineLockSync` | dead-holder | `holder-read` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `acquireMachineLockSync` | dead-holder | `holder-read` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `acquireMachineLockSync` | dead-holder | `holder-relist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-relist EIO) |
| `acquireMachineLockSync` | dead-holder | `list-queue` | 1 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired |
| `acquireMachineLockSync` | dead-holder | `list-queue` | 2 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder | `list-queue` | 3 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `acquireMachineLockSync` | dead-holder | `list-queue` | 4 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO); g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder | `list-root` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `list-root` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder | `lock-owner` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `lock-owner` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `mkdir-lock` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, new gen | throws EIO; g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `mkdir-lock` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder | `owner-close` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder | `owner-create` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder | `owner-fields` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `acquireMachineLockSync` | dead-holder | `owner-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `acquireMachineLockSync` | dead-holder | `owner-publish` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder | `owner-readback` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, lock D gone, lock new put, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder | `owner-unlink` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder | `owner-write` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder | `owner-write-short` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder | `pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (pid ENOENT); g1 end dead, new gen | not acquired (pid EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `recover-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder | `rename-aside` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `beacon-gen-end` | 1 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (beacon-gen-end EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `beacon-gen-end` | 2 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; new gen | not acquired (beacon-gen-end EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `beacon-gen-end` | 3 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (beacon-gen-end EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `end-link` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-link EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `end-link` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-link EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `end-tmp` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT) | not acquired (end-tmp EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `end-tmp` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT) | not acquired (end-tmp EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-end-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-end-read EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-fields-read` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-fields-read EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-fields-read` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-fields-read EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 end dead | not acquired (gen-mkdir EIO); g1 end dead |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-owner-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 gone, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-owner-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 end dead, new gen | not acquired (gen-owner-tmp EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-postlist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 end dead, new gen | not acquired (gen-postlist EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-realpath` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-realpath` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-root-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-mkdir` | 1 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-mkdir` | 2 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-mkdir` | 3 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 end dead, new gen | not acquired (gen-tmp-mkdir EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-unlink` | 1 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-unlink` | 2 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-unlink` | 3 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-write` | 1 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-write` | 2 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-tmp-write` | 3 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 end dead, new gen | not acquired (gen-tmp-write EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-verify-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `gen-verify-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 end dead, new gen | not acquired (gen-verify-owner EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `holder-pid` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-pid ENOENT) | not acquired (holder-pid EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `holder-pid` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-pid ENOENT) | not acquired (holder-pid EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `holder-read` | 1 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `holder-read` | 2 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `holder-read` | 3 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `holder-read` | 4 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `holder-relist` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-relist EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `holder-relist` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-relist EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `list-queue` | 1 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired |
| `acquireMachineLockSync` | dead-holder end-cleaned | `list-queue` | 2 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder end-cleaned | `list-queue` | 3 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `list-queue` | 4 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO); g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `list-root` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `list-root` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `lock-owner` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `lock-owner` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `mkdir-lock` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, new gen | throws EIO; g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `mkdir-lock` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `owner-close` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `owner-create` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `owner-fields` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `owner-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `acquireMachineLockSync` | dead-holder end-cleaned | `owner-publish` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `owner-readback` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, lock D gone, lock new put, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `owner-unlink` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | dead-holder end-cleaned | `owner-write` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `owner-write-short` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (pid ENOENT); g1 end dead, new gen | not acquired (pid EIO); g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `recover-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `acquireMachineLockSync` | dead-holder end-cleaned | `rename-aside` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `gen-end-read` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-end-read EIO); g1 gone |
| `acquireMachineLockSync` | ended-old-tmp | `gen-list` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `acquireMachineLockSync` | ended-old-tmp | `gen-mkdir` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 gone | not acquired (gen-mkdir EIO); g1 gone |
| `acquireMachineLockSync` | ended-old-tmp | `gen-owner-link` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, g2 gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `gen-owner-tmp` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 gone, new gen | not acquired (gen-owner-tmp EIO); g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `gen-postlist` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 gone, new gen | not acquired (gen-postlist EIO); g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `gen-realpath` | 1 | 2 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | ended-old-tmp | `gen-realpath` | 2 | 2 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | ended-old-tmp | `gen-root-mkdir` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `acquireMachineLockSync` | ended-old-tmp | `gen-tmp-list` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ended-old-tmp | `gen-tmp-lstat` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ended-old-tmp | `gen-tmp-mkdir` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 gone, new gen | not acquired (gen-tmp-mkdir EIO); g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `gen-tmp-unlink` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ended-old-tmp | `gen-tmp-write` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 gone, new gen | not acquired (gen-tmp-write EIO); g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `gen-verify-end` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `gen-verify-owner` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 gone, new gen | not acquired (gen-verify-owner EIO); g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `list-queue` | 1 | 3 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired |
| `acquireMachineLockSync` | ended-old-tmp | `list-queue` | 2 | 3 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ended-old-tmp | `list-queue` | 3 | 3 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `acquireMachineLockSync` | ended-old-tmp | `list-root` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `mkdir-lock` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `owner-close` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `owner-create` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `owner-fields` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `acquireMachineLockSync` | ended-old-tmp | `owner-pid` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `acquireMachineLockSync` | ended-old-tmp | `owner-publish` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `owner-readback` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired; g1 gone, lock new put, new gen | throws EIO; g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `owner-unlink` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ended-old-tmp | `owner-write` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `acquireMachineLockSync` | ended-old-tmp | `owner-write-short` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `acquireMachineLockSync` | fresh | `gen-dir-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-dir-mkdir ENOENT) | not acquired (gen-dir-mkdir EIO) |
| `acquireMachineLockSync` | fresh | `gen-list` | 1 | 2 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `acquireMachineLockSync` | fresh | `gen-list` | 2 | 2 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `acquireMachineLockSync` | fresh | `gen-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT) | not acquired (gen-mkdir EIO) |
| `acquireMachineLockSync` | fresh | `gen-owner-link` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); new gen |
| `acquireMachineLockSync` | fresh | `gen-owner-tmp` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); new gen | not acquired (gen-owner-tmp EIO); new gen |
| `acquireMachineLockSync` | fresh | `gen-parent-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-parent-mkdir ENOENT) | not acquired (gen-parent-mkdir EIO) |
| `acquireMachineLockSync` | fresh | `gen-postlist` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); new gen | not acquired (gen-postlist EIO); new gen |
| `acquireMachineLockSync` | fresh | `gen-realpath` | 1 | 2 | acquired; lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | fresh | `gen-realpath` | 2 | 2 | acquired; lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | fresh | `gen-root-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `acquireMachineLockSync` | fresh | `gen-tmp-list` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open |
| `acquireMachineLockSync` | fresh | `gen-tmp-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); new gen | not acquired (gen-tmp-mkdir EIO); new gen |
| `acquireMachineLockSync` | fresh | `gen-tmp-unlink` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open |
| `acquireMachineLockSync` | fresh | `gen-tmp-write` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); new gen | not acquired (gen-tmp-write EIO); new gen |
| `acquireMachineLockSync` | fresh | `gen-verify-end` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); new gen |
| `acquireMachineLockSync` | fresh | `gen-verify-owner` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); new gen | not acquired (gen-verify-owner EIO); new gen |
| `acquireMachineLockSync` | fresh | `list-queue` | 1 | 3 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired |
| `acquireMachineLockSync` | fresh | `list-queue` | 2 | 3 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open |
| `acquireMachineLockSync` | fresh | `list-queue` | 3 | 3 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `acquireMachineLockSync` | fresh | `list-root` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (list-root EIO); new gen |
| `acquireMachineLockSync` | fresh | `mkdir-lock` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `acquireMachineLockSync` | fresh | `owner-close` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `acquireMachineLockSync` | fresh | `owner-create` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `acquireMachineLockSync` | fresh | `owner-fields` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `acquireMachineLockSync` | fresh | `owner-pid` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `acquireMachineLockSync` | fresh | `owner-publish` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `acquireMachineLockSync` | fresh | `owner-readback` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired; lock new put, new gen | throws EIO; new gen |
| `acquireMachineLockSync` | fresh | `owner-unlink` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open |
| `acquireMachineLockSync` | fresh | `owner-write` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `acquireMachineLockSync` | fresh | `owner-write-short` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `acquireMachineLockSync` | ownerless-old | `end-link` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (end-link EIO); g1 records +1 |
| `acquireMachineLockSync` | ownerless-old | `end-tmp` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT); g1 records +1 | not acquired (end-tmp EIO); g1 records +1 |
| `acquireMachineLockSync` | ownerless-old | `gen-end-read` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-end-read EIO) |
| `acquireMachineLockSync` | ownerless-old | `gen-list` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `acquireMachineLockSync` | ownerless-old | `gen-mkdir` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 end dead, g1 records +1 | not acquired (gen-mkdir EIO); g1 end dead, g1 records +1 |
| `acquireMachineLockSync` | ownerless-old | `gen-owner-link` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `gen-owner-tmp` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 end dead, g1 records +1, new gen | not acquired (gen-owner-tmp EIO); g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `gen-postlist` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 end dead, g1 records +1, new gen | not acquired (gen-postlist EIO); g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `gen-realpath` | 1 | 2 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | ownerless-old | `gen-realpath` | 2 | 2 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `acquireMachineLockSync` | ownerless-old | `gen-root-mkdir` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-list` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-mkdir` | 1 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-mkdir` | 2 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 records +1 | not acquired (gen-tmp-mkdir EIO); g1 records +1 |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-mkdir` | 3 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 end dead, g1 records +1, new gen | not acquired (gen-tmp-mkdir EIO); g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-unlink` | 1 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-unlink` | 2 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-unlink` | 3 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-write` | 1 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-write` | 2 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 records +1 | not acquired (gen-tmp-write EIO); g1 records +1 |
| `acquireMachineLockSync` | ownerless-old | `gen-tmp-write` | 3 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 end dead, g1 records +1, new gen | not acquired (gen-tmp-write EIO); g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `gen-verify-end` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `gen-verify-owner` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 end dead, g1 records +1, new gen | not acquired (gen-verify-owner EIO); g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `holder-read` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `acquireMachineLockSync` | ownerless-old | `list-queue` | 1 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired |
| `acquireMachineLockSync` | ownerless-old | `list-queue` | 2 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ownerless-old | `list-queue` | 3 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `acquireMachineLockSync` | ownerless-old | `list-root` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `mkdir-lock` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `owner-close` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `owner-create` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `owner-fields` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `acquireMachineLockSync` | ownerless-old | `owner-pid` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `acquireMachineLockSync` | ownerless-old | `owner-publish` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `owner-readback` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired; g1 end dead, g1 records +1, lock new put, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `owner-unlink` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `acquireMachineLockSync` | ownerless-old | `owner-write` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `owner-write-short` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `acquireMachineLockSync` | ownerless-old | `ownerless-gen-mtime` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (ownerless-gen-mtime EIO) |
| `acquireMachineLockSync` | ownerless-old | `tomb-link` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (tomb-link EIO) |
| `acquireMachineLockSync` | ownerless-old | `tomb-tmp` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (tomb-tmp ENOENT) | not acquired (tomb-tmp EIO) |
| `genDirOf` | by-path | `gen-realpath` | 1 | 2 | chain by-path/<hash>.gen | throws ENOENT | throws EIO |
| `genDirOf` | by-path | `gen-realpath` | 2 | 2 | chain by-path/<hash>.gen | throws ENOENT | throws EIO |
| `genDirOf` | by-path | `gen-root-mkdir` | 1 | 1 | chain by-path/<hash>.gen | throws ENOENT | throws EIO |
| `genDirOf` | named | `gen-realpath` | 1 | 2 | chain x.gen | throws ENOENT | throws EIO |
| `genDirOf` | named | `gen-realpath` | 2 | 2 | chain x.gen | throws ENOENT | throws EIO |
| `genDirOf` | named | `gen-root-mkdir` | 1 | 1 | chain x.gen | throws ENOENT | throws EIO |
| `handle.handOff` | own | `gen-tmp-mkdir` | 1 | 1 | ok; g1 records +1 | not ok (tmp) | not ok (tmp) |
| `handle.handOff` | own | `gen-tmp-unlink` | 1 | 1 | ok; g1 records +1 | ok; g1 records +1 | ok; g1 records +1 |
| `handle.handOff` | own | `gen-tmp-write` | 1 | 1 | ok; g1 records +1 | not ok (tmp) | not ok (tmp) |
| `handle.handOff` | own | `handoff-gen-link` | 1 | 1 | ok; g1 records +1 | not ok (tmp) | not ok (tmp) |
| `handle.handOff` | own | `handoff-gen-tmp` | 1 | 1 | ok; g1 records +1 | not ok (tmp) | not ok (tmp) |
| `handle.handOff` | own | `handoff-publish` | 1 | 1 | ok; g1 records +1 | not ok (mv); g1 records +1 | not ok (mv); g1 records +1 |
| `handle.handOff` | own | `handoff-tmp` | 1 | 1 | ok; g1 records +1 | not ok (tmp); g1 records +1 | not ok (tmp); g1 records +1 |
| `handle.handOff` | own | `handoff-token` | 1 | 1 | ok; g1 records +1 | not ok (token) | not ok (token) |
| `handle.handOff` | own | `handoff-verify` | 1 | 1 | ok; g1 records +1 | not ok (verify); g1 records +1 | not ok (verify); g1 records +1 |
| `handle.release` | handed-back | `group` | 1 | 1 | deferred | deferred | deferred |
| `handle.release` | handed-back | `holder-read` | 1 | 4 | deferred | released; g1 end released, lock new gone | deferred |
| `handle.release` | handed-back | `holder-read` | 2 | 4 | deferred | released; g1 end released, lock new gone | deferred |
| `handle.release` | handed-back | `holder-read` | 3 | 4 | deferred | deferred | deferred |
| `handle.release` | handed-back | `holder-read` | 4 | 4 | deferred | deferred | deferred |
| `handle.release` | handed-back | `release-owner` | 1 | 1 | deferred | deferred | deferred |
| `handle.release` | handed-dead | `group` | 1 | 1 | needs-head | deferred | deferred |
| `handle.release` | handed-dead | `pid` | 1 | 1 | needs-head | deferred | deferred |
| `handle.release` | handed-dead | `release-owner` | 1 | 1 | needs-head | needs-head | needs-head |
| `handle.release` | handed-live | `group` | 1 | 1 | deferred | deferred | deferred |
| `handle.release` | handed-live | `release-owner` | 1 | 1 | deferred | deferred | deferred |
| `handle.release` | own | `end-link` | 1 | 1 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | throws EIO; lock new gone |
| `handle.release` | own | `end-tmp` | 1 | 1 | released; g1 end released, lock new gone | throws ENOENT; lock new gone | throws EIO; lock new gone |
| `handle.release` | own | `gen-tmp-mkdir` | 1 | 1 | released; g1 end released, lock new gone | throws ENOENT; lock new gone | throws EIO; lock new gone |
| `handle.release` | own | `gen-tmp-unlink` | 1 | 1 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | released; g1 end released, lock new gone |
| `handle.release` | own | `gen-tmp-write` | 1 | 1 | released; g1 end released, lock new gone | throws ENOENT; lock new gone | throws EIO; lock new gone |
| `handle.release` | own | `holder-read` | 1 | 2 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | deferred |
| `handle.release` | own | `holder-read` | 2 | 2 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | deferred |
| `handle.release` | own | `release-owner` | 1 | 1 | released; g1 end released, lock new gone | kept; g1 end released | released; g1 end released, lock new gone |
| `handle.release` | own end-cleaned | `beacon-gen-end` | 1 | 2 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `beacon-gen-end` | 2 | 2 | released; g1 end released, lock new gone | released; lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `end-link` | 1 | 2 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `end-link` | 2 | 2 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `end-tmp` | 1 | 2 | released; g1 end released, lock new gone | throws ENOENT; lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `end-tmp` | 2 | 2 | released; g1 end released, lock new gone | throws ENOENT; lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `gen-tmp-mkdir` | 1 | 2 | released; g1 end released, lock new gone | throws ENOENT; lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `gen-tmp-mkdir` | 2 | 2 | released; g1 end released, lock new gone | throws ENOENT; lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `gen-tmp-unlink` | 1 | 2 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | released; g1 end released, lock new gone |
| `handle.release` | own end-cleaned | `gen-tmp-unlink` | 2 | 2 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | released; g1 end released, lock new gone |
| `handle.release` | own end-cleaned | `gen-tmp-write` | 1 | 2 | released; g1 end released, lock new gone | throws ENOENT; lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `gen-tmp-write` | 2 | 2 | released; g1 end released, lock new gone | throws ENOENT; lock new gone | throws EIO; lock new gone |
| `handle.release` | own end-cleaned | `holder-read` | 1 | 2 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | deferred |
| `handle.release` | own end-cleaned | `holder-read` | 2 | 2 | released; g1 end released, lock new gone | released; g1 end released, lock new gone | deferred |
| `handle.release` | own end-cleaned | `release-owner` | 1 | 1 | released; g1 end released, lock new gone | kept; g1 end released | released; g1 end released, lock new gone |
| `handle.setOwnerFields` | own | `gen-fields-read` | 1 | 1 | true | true | true |
| `machineLockAcquisition` | dead-group-holder | `beacon-gen-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (beacon-gen-end EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `end-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-link EIO) |
| `machineLockAcquisition` | dead-group-holder | `end-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT) | not acquired (end-tmp EIO) |
| `machineLockAcquisition` | dead-group-holder | `gen-end-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-end-read EIO) |
| `machineLockAcquisition` | dead-group-holder | `gen-fields-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-fields-read EIO) |
| `machineLockAcquisition` | dead-group-holder | `gen-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `machineLockAcquisition` | dead-group-holder | `gen-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 end dead | not acquired (gen-mkdir EIO); g1 end dead |
| `machineLockAcquisition` | dead-group-holder | `gen-owner-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 gone, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `gen-owner-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 end dead, new gen | not acquired (gen-owner-tmp EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `gen-postlist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 end dead, new gen | not acquired (gen-postlist EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `gen-realpath` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | dead-group-holder | `gen-realpath` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | dead-group-holder | `gen-root-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `machineLockAcquisition` | dead-group-holder | `gen-tmp-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-group-holder | `gen-tmp-mkdir` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `machineLockAcquisition` | dead-group-holder | `gen-tmp-mkdir` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 end dead, new gen | not acquired (gen-tmp-mkdir EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `gen-tmp-unlink` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-group-holder | `gen-tmp-unlink` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-group-holder | `gen-tmp-write` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `machineLockAcquisition` | dead-group-holder | `gen-tmp-write` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 end dead, new gen | not acquired (gen-tmp-write EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `gen-verify-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `gen-verify-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 end dead, new gen | not acquired (gen-verify-owner EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `group` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (group ENOENT); g1 end dead, new gen | not acquired (group EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `holder-group` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-group ENOENT) | not acquired (holder-group EIO) |
| `machineLockAcquisition` | dead-group-holder | `holder-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-pid ENOENT) | not acquired (holder-pid EIO) |
| `machineLockAcquisition` | dead-group-holder | `holder-read` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `machineLockAcquisition` | dead-group-holder | `holder-read` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `machineLockAcquisition` | dead-group-holder | `holder-relist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-relist EIO) |
| `machineLockAcquisition` | dead-group-holder | `list-queue` | 1 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired |
| `machineLockAcquisition` | dead-group-holder | `list-queue` | 2 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-group-holder | `list-queue` | 3 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `machineLockAcquisition` | dead-group-holder | `list-queue` | 4 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO); g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-group-holder | `list-root` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `list-root` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-group-holder | `lock-owner` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `lock-owner` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `mkdir-lock` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, new gen | throws EIO; g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `mkdir-lock` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-group-holder | `owner-close` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-group-holder | `owner-create` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-group-holder | `owner-fields` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `machineLockAcquisition` | dead-group-holder | `owner-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `machineLockAcquisition` | dead-group-holder | `owner-publish` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-group-holder | `owner-readback` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, lock D gone, lock new put, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-group-holder | `owner-unlink` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-group-holder | `owner-write` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-group-holder | `owner-write-short` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-group-holder | `pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (pid ENOENT); g1 end dead, new gen | not acquired (pid EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `recover-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `machineLockAcquisition` | dead-group-holder | `rename-aside` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `beacon-gen-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (beacon-gen-end EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `end-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-link EIO) |
| `machineLockAcquisition` | dead-holder | `end-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT) | not acquired (end-tmp EIO) |
| `machineLockAcquisition` | dead-holder | `gen-end-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-end-read EIO) |
| `machineLockAcquisition` | dead-holder | `gen-fields-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-fields-read EIO) |
| `machineLockAcquisition` | dead-holder | `gen-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `machineLockAcquisition` | dead-holder | `gen-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 end dead | not acquired (gen-mkdir EIO); g1 end dead |
| `machineLockAcquisition` | dead-holder | `gen-owner-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 gone, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `gen-owner-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 end dead, new gen | not acquired (gen-owner-tmp EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `gen-postlist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 end dead, new gen | not acquired (gen-postlist EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `gen-realpath` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | dead-holder | `gen-realpath` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | dead-holder | `gen-root-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `machineLockAcquisition` | dead-holder | `gen-tmp-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder | `gen-tmp-mkdir` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `machineLockAcquisition` | dead-holder | `gen-tmp-mkdir` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 end dead, new gen | not acquired (gen-tmp-mkdir EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `gen-tmp-unlink` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder | `gen-tmp-unlink` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder | `gen-tmp-write` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `machineLockAcquisition` | dead-holder | `gen-tmp-write` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 end dead, new gen | not acquired (gen-tmp-write EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `gen-verify-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `gen-verify-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 end dead, new gen | not acquired (gen-verify-owner EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `holder-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-pid ENOENT) | not acquired (holder-pid EIO) |
| `machineLockAcquisition` | dead-holder | `holder-read` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `machineLockAcquisition` | dead-holder | `holder-read` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `machineLockAcquisition` | dead-holder | `holder-relist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-relist EIO) |
| `machineLockAcquisition` | dead-holder | `list-queue` | 1 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired |
| `machineLockAcquisition` | dead-holder | `list-queue` | 2 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder | `list-queue` | 3 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `machineLockAcquisition` | dead-holder | `list-queue` | 4 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO); g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder | `list-root` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `list-root` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder | `lock-owner` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `lock-owner` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `mkdir-lock` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, new gen | throws EIO; g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `mkdir-lock` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder | `owner-close` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder | `owner-create` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder | `owner-fields` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `machineLockAcquisition` | dead-holder | `owner-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `machineLockAcquisition` | dead-holder | `owner-publish` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder | `owner-readback` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, lock D gone, lock new put, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder | `owner-unlink` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder | `owner-write` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder | `owner-write-short` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder | `pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (pid ENOENT); g1 end dead, new gen | not acquired (pid EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `recover-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder | `rename-aside` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `beacon-gen-end` | 1 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (beacon-gen-end EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `beacon-gen-end` | 2 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; new gen | not acquired (beacon-gen-end EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `beacon-gen-end` | 3 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (beacon-gen-end EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `end-link` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-link EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `end-link` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-link EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `end-tmp` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT) | not acquired (end-tmp EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `end-tmp` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT) | not acquired (end-tmp EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-end-read` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-end-read EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-fields-read` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-fields-read EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-fields-read` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-fields-read EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 end dead | not acquired (gen-mkdir EIO); g1 end dead |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-owner-link` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 gone, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-owner-tmp` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 end dead, new gen | not acquired (gen-owner-tmp EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-postlist` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 end dead, new gen | not acquired (gen-postlist EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-realpath` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-realpath` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-root-mkdir` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-list` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-mkdir` | 1 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-mkdir` | 2 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-mkdir` | 3 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 end dead, new gen | not acquired (gen-tmp-mkdir EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-unlink` | 1 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-unlink` | 2 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-unlink` | 3 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-write` | 1 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-write` | 2 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-tmp-write` | 3 | 3 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 end dead, new gen | not acquired (gen-tmp-write EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-verify-end` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `gen-verify-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 end dead, new gen | not acquired (gen-verify-owner EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `holder-pid` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-pid ENOENT) | not acquired (holder-pid EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `holder-pid` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-pid ENOENT) | not acquired (holder-pid EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `holder-read` | 1 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `holder-read` | 2 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `holder-read` | 3 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `holder-read` | 4 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `holder-relist` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-relist EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `holder-relist` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (holder-relist EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `list-queue` | 1 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired |
| `machineLockAcquisition` | dead-holder end-cleaned | `list-queue` | 2 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder end-cleaned | `list-queue` | 3 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `list-queue` | 4 | 4 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-queue EIO); g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `list-root` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `list-root` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `lock-owner` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `lock-owner` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired (lock-owner EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `mkdir-lock` | 1 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, new gen | throws EIO; g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `mkdir-lock` | 2 | 2 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `owner-close` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `owner-create` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `owner-fields` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `owner-pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `machineLockAcquisition` | dead-holder end-cleaned | `owner-publish` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `owner-readback` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, lock D gone, lock new put, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `owner-unlink` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | dead-holder end-cleaned | `owner-write` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `owner-write-short` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, lock D gone, new gen | throws EIO; g1 end dead, lock D gone, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `pid` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired (pid ENOENT); g1 end dead, new gen | not acquired (pid EIO); g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `recover-owner` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `machineLockAcquisition` | dead-holder end-cleaned | `rename-aside` | 1 | 1 | acquired; g1 end dead, lock D gone, lock new put, new gen, new gen open | not acquired; g1 end dead, new gen | not acquired; g1 end dead, new gen |
| `machineLockAcquisition` | ended-old-tmp | `gen-end-read` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-end-read EIO); g1 gone |
| `machineLockAcquisition` | ended-old-tmp | `gen-list` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `machineLockAcquisition` | ended-old-tmp | `gen-mkdir` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 gone | not acquired (gen-mkdir EIO); g1 gone |
| `machineLockAcquisition` | ended-old-tmp | `gen-owner-link` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, g2 gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `gen-owner-tmp` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 gone, new gen | not acquired (gen-owner-tmp EIO); g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `gen-postlist` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 gone, new gen | not acquired (gen-postlist EIO); g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `gen-realpath` | 1 | 2 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | ended-old-tmp | `gen-realpath` | 2 | 2 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | ended-old-tmp | `gen-root-mkdir` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `machineLockAcquisition` | ended-old-tmp | `gen-tmp-list` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ended-old-tmp | `gen-tmp-lstat` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ended-old-tmp | `gen-tmp-mkdir` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 gone, new gen | not acquired (gen-tmp-mkdir EIO); g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `gen-tmp-unlink` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ended-old-tmp | `gen-tmp-write` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 gone, new gen | not acquired (gen-tmp-write EIO); g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `gen-verify-end` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `gen-verify-owner` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 gone, new gen | not acquired (gen-verify-owner EIO); g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `list-queue` | 1 | 3 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired |
| `machineLockAcquisition` | ended-old-tmp | `list-queue` | 2 | 3 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ended-old-tmp | `list-queue` | 3 | 3 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `machineLockAcquisition` | ended-old-tmp | `list-root` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `mkdir-lock` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `owner-close` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `owner-create` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `owner-fields` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `machineLockAcquisition` | ended-old-tmp | `owner-pid` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `machineLockAcquisition` | ended-old-tmp | `owner-publish` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `owner-readback` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | not acquired; g1 gone, lock new put, new gen | throws EIO; g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `owner-unlink` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ended-old-tmp | `owner-write` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `machineLockAcquisition` | ended-old-tmp | `owner-write-short` | 1 | 1 | acquired; g1 gone, lock new put, new gen, new gen open | throws ENOENT; g1 gone, new gen | throws EIO; g1 gone, new gen |
| `machineLockAcquisition` | fresh | `gen-dir-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-dir-mkdir ENOENT) | not acquired (gen-dir-mkdir EIO) |
| `machineLockAcquisition` | fresh | `gen-list` | 1 | 2 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `machineLockAcquisition` | fresh | `gen-list` | 2 | 2 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `machineLockAcquisition` | fresh | `gen-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT) | not acquired (gen-mkdir EIO) |
| `machineLockAcquisition` | fresh | `gen-owner-link` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); new gen |
| `machineLockAcquisition` | fresh | `gen-owner-tmp` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); new gen | not acquired (gen-owner-tmp EIO); new gen |
| `machineLockAcquisition` | fresh | `gen-parent-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-parent-mkdir ENOENT) | not acquired (gen-parent-mkdir EIO) |
| `machineLockAcquisition` | fresh | `gen-postlist` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); new gen | not acquired (gen-postlist EIO); new gen |
| `machineLockAcquisition` | fresh | `gen-realpath` | 1 | 2 | acquired; lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | fresh | `gen-realpath` | 2 | 2 | acquired; lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | fresh | `gen-root-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `machineLockAcquisition` | fresh | `gen-tmp-list` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open |
| `machineLockAcquisition` | fresh | `gen-tmp-mkdir` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); new gen | not acquired (gen-tmp-mkdir EIO); new gen |
| `machineLockAcquisition` | fresh | `gen-tmp-unlink` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open |
| `machineLockAcquisition` | fresh | `gen-tmp-write` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); new gen | not acquired (gen-tmp-write EIO); new gen |
| `machineLockAcquisition` | fresh | `gen-verify-end` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); new gen |
| `machineLockAcquisition` | fresh | `gen-verify-owner` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); new gen | not acquired (gen-verify-owner EIO); new gen |
| `machineLockAcquisition` | fresh | `list-queue` | 1 | 3 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired |
| `machineLockAcquisition` | fresh | `list-queue` | 2 | 3 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open |
| `machineLockAcquisition` | fresh | `list-queue` | 3 | 3 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `machineLockAcquisition` | fresh | `list-root` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | not acquired (list-root EIO); new gen |
| `machineLockAcquisition` | fresh | `mkdir-lock` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `machineLockAcquisition` | fresh | `owner-close` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `machineLockAcquisition` | fresh | `owner-create` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `machineLockAcquisition` | fresh | `owner-fields` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `machineLockAcquisition` | fresh | `owner-pid` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `machineLockAcquisition` | fresh | `owner-publish` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `machineLockAcquisition` | fresh | `owner-readback` | 1 | 1 | acquired; lock new put, new gen, new gen open | not acquired; lock new put, new gen | throws EIO; new gen |
| `machineLockAcquisition` | fresh | `owner-unlink` | 1 | 1 | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open | acquired; lock new put, new gen, new gen open |
| `machineLockAcquisition` | fresh | `owner-write` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `machineLockAcquisition` | fresh | `owner-write-short` | 1 | 1 | acquired; lock new put, new gen, new gen open | throws ENOENT; new gen | throws EIO; new gen |
| `machineLockAcquisition` | ownerless-old | `end-link` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (end-link EIO); g1 records +1 |
| `machineLockAcquisition` | ownerless-old | `end-tmp` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (end-tmp ENOENT); g1 records +1 | not acquired (end-tmp EIO); g1 records +1 |
| `machineLockAcquisition` | ownerless-old | `gen-end-read` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-end-read EIO) |
| `machineLockAcquisition` | ownerless-old | `gen-list` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-list EIO) |
| `machineLockAcquisition` | ownerless-old | `gen-mkdir` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-mkdir ENOENT); g1 end dead, g1 records +1 | not acquired (gen-mkdir EIO); g1 end dead, g1 records +1 |
| `machineLockAcquisition` | ownerless-old | `gen-owner-link` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 gone, lock new put, new gen, new gen open | not acquired (gen-owner-link EIO); g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `gen-owner-tmp` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-owner-tmp ENOENT); g1 end dead, g1 records +1, new gen | not acquired (gen-owner-tmp EIO); g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `gen-postlist` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-postlist ENOENT); g1 end dead, g1 records +1, new gen | not acquired (gen-postlist EIO); g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `gen-realpath` | 1 | 2 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | ownerless-old | `gen-realpath` | 2 | 2 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-realpath ENOENT) | not acquired (gen-realpath EIO) |
| `machineLockAcquisition` | ownerless-old | `gen-root-mkdir` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-root-mkdir ENOENT) | not acquired (gen-root-mkdir EIO) |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-list` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-mkdir` | 1 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT) | not acquired (gen-tmp-mkdir EIO) |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-mkdir` | 2 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 records +1 | not acquired (gen-tmp-mkdir EIO); g1 records +1 |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-mkdir` | 3 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-mkdir ENOENT); g1 end dead, g1 records +1, new gen | not acquired (gen-tmp-mkdir EIO); g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-unlink` | 1 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-unlink` | 2 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-unlink` | 3 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-write` | 1 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT) | not acquired (gen-tmp-write EIO) |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-write` | 2 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 records +1 | not acquired (gen-tmp-write EIO); g1 records +1 |
| `machineLockAcquisition` | ownerless-old | `gen-tmp-write` | 3 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-tmp-write ENOENT); g1 end dead, g1 records +1, new gen | not acquired (gen-tmp-write EIO); g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `gen-verify-end` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-verify-end EIO); g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `gen-verify-owner` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (gen-verify-owner ESTALE); g1 end dead, g1 records +1, new gen | not acquired (gen-verify-owner EIO); g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `holder-read` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (holder-read EIO) |
| `machineLockAcquisition` | ownerless-old | `list-queue` | 1 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired |
| `machineLockAcquisition` | ownerless-old | `list-queue` | 2 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ownerless-old | `list-queue` | 3 | 3 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (list-queue EIO) |
| `machineLockAcquisition` | ownerless-old | `list-root` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (list-root EIO); g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `mkdir-lock` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `owner-close` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `owner-create` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `owner-fields` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (owner-fields ENOENT) | not acquired (owner-fields EIO) |
| `machineLockAcquisition` | ownerless-old | `owner-pid` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (owner-pid ENOENT) | not acquired (owner-pid EIO) |
| `machineLockAcquisition` | ownerless-old | `owner-publish` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `owner-readback` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired; g1 end dead, g1 records +1, lock new put, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `owner-unlink` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open |
| `machineLockAcquisition` | ownerless-old | `owner-write` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `owner-write-short` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | throws ENOENT; g1 end dead, g1 records +1, new gen | throws EIO; g1 end dead, g1 records +1, new gen |
| `machineLockAcquisition` | ownerless-old | `ownerless-gen-mtime` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (ownerless-gen-mtime EIO) |
| `machineLockAcquisition` | ownerless-old | `tomb-link` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (tomb-link EIO) |
| `machineLockAcquisition` | ownerless-old | `tomb-tmp` | 1 | 1 | acquired; g1 end dead, g1 records +1, lock new put, new gen, new gen open | not acquired (tomb-tmp ENOENT) | not acquired (tomb-tmp EIO) |
| `readHolder` | gen-and-lock | `gen-end-read` | 1 | 1 | holder D g=1 | holder D g=1 | holder L |
| `readHolder` | gen-and-lock | `gen-fields-read` | 1 | 1 | holder D g=1 | holder D g=1 | holder L |
| `readHolder` | gen-and-lock | `gen-list` | 1 | 1 | holder D g=1 | holder L | holder L |
| `readHolder` | gen-and-lock | `gen-realpath` | 1 | 2 | holder D g=1 | holder L | holder L |
| `readHolder` | gen-and-lock | `gen-realpath` | 2 | 2 | holder D g=1 | holder L | holder L |
| `readHolder` | gen-and-lock | `holder-read` | 1 | 2 | holder D g=1 | holder L | holder L |
| `readHolder` | gen-and-lock | `holder-read` | 2 | 2 | holder D g=1 | holder D g=1 | holder L |
| `readHolder` | gen-and-lock genOnly | `gen-end-read` | 1 | 1 | holder D g=1 | holder D g=1 | holder null |
| `readHolder` | gen-and-lock genOnly | `gen-fields-read` | 1 | 1 | holder D g=1 | holder D g=1 | holder null |
| `readHolder` | gen-and-lock genOnly | `gen-list` | 1 | 1 | holder D g=1 | holder null | holder null |
| `readHolder` | gen-and-lock genOnly | `gen-realpath` | 1 | 2 | holder D g=1 | holder null | holder null |
| `readHolder` | gen-and-lock genOnly | `gen-realpath` | 2 | 2 | holder D g=1 | holder null | holder null |
| `readHolder` | gen-and-lock genOnly | `holder-read` | 1 | 2 | holder D g=1 | holder null | holder null |
| `readHolder` | gen-and-lock genOnly | `holder-read` | 2 | 2 | holder D g=1 | holder D g=1 | holder null |
| `recoverIfDead` | dead-group-holding | `beacon-gen-end` | 1 | 1 | removed; g1 end dead, lock T gone | kept; g1 end dead | kept (beacon-gen-end EIO); g1 end dead |
| `recoverIfDead` | dead-group-holding | `end-link` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (end-link EIO) |
| `recoverIfDead` | dead-group-holding | `end-tmp` | 1 | 1 | removed; g1 end dead, lock T gone | kept (end-tmp ENOENT) | kept (end-tmp EIO) |
| `recoverIfDead` | dead-group-holding | `gen-end-read` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (gen-end-read EIO) |
| `recoverIfDead` | dead-group-holding | `gen-fields-read` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (gen-fields-read EIO) |
| `recoverIfDead` | dead-group-holding | `gen-list` | 1 | 1 | removed; g1 end dead, lock T gone | kept | kept (gen-list EIO) |
| `recoverIfDead` | dead-group-holding | `gen-realpath` | 1 | 2 | removed; g1 end dead, lock T gone | kept (gen-realpath ENOENT) | kept (gen-realpath EIO) |
| `recoverIfDead` | dead-group-holding | `gen-realpath` | 2 | 2 | removed; g1 end dead, lock T gone | kept (gen-realpath ENOENT) | kept (gen-realpath EIO) |
| `recoverIfDead` | dead-group-holding | `gen-root-mkdir` | 1 | 1 | removed; g1 end dead, lock T gone | kept (gen-root-mkdir ENOENT) | kept (gen-root-mkdir EIO) |
| `recoverIfDead` | dead-group-holding | `gen-tmp-mkdir` | 1 | 1 | removed; g1 end dead, lock T gone | kept (gen-tmp-mkdir ENOENT) | kept (gen-tmp-mkdir EIO) |
| `recoverIfDead` | dead-group-holding | `gen-tmp-unlink` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone |
| `recoverIfDead` | dead-group-holding | `gen-tmp-write` | 1 | 1 | removed; g1 end dead, lock T gone | kept (gen-tmp-write ENOENT) | kept (gen-tmp-write EIO) |
| `recoverIfDead` | dead-group-holding | `group` | 1 | 1 | removed; g1 end dead, lock T gone | kept (group ENOENT); g1 end dead | kept (group EIO); g1 end dead |
| `recoverIfDead` | dead-group-holding | `holder-group` | 1 | 1 | removed; g1 end dead, lock T gone | kept (holder-group ENOENT) | kept (holder-group EIO) |
| `recoverIfDead` | dead-group-holding | `holder-pid` | 1 | 1 | removed; g1 end dead, lock T gone | kept (holder-pid ENOENT) | kept (holder-pid EIO) |
| `recoverIfDead` | dead-group-holding | `holder-read` | 1 | 2 | removed; g1 end dead, lock T gone | kept | kept (holder-read EIO) |
| `recoverIfDead` | dead-group-holding | `holder-read` | 2 | 2 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (holder-read EIO) |
| `recoverIfDead` | dead-group-holding | `holder-relist` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (holder-relist EIO) |
| `recoverIfDead` | dead-group-holding | `list-queue` | 1 | 3 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | not-head |
| `recoverIfDead` | dead-group-holding | `list-queue` | 2 | 3 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone |
| `recoverIfDead` | dead-group-holding | `list-queue` | 3 | 3 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | not-head (list-queue EIO) |
| `recoverIfDead` | dead-group-holding | `list-root` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | removed (list-root EIO); g1 end dead, lock T gone |
| `recoverIfDead` | dead-group-holding | `lock-owner` | 1 | 2 | removed; g1 end dead, lock T gone | kept; g1 end dead | kept (lock-owner EIO); g1 end dead |
| `recoverIfDead` | dead-group-holding | `lock-owner` | 2 | 2 | removed; g1 end dead, lock T gone | kept; g1 end dead | kept (lock-owner EIO); g1 end dead |
| `recoverIfDead` | dead-group-holding | `pid` | 1 | 1 | removed; g1 end dead, lock T gone | kept (pid ENOENT); g1 end dead | kept (pid EIO); g1 end dead |
| `recoverIfDead` | dead-group-holding | `recover-owner` | 1 | 1 | removed; g1 end dead, lock T gone | kept; g1 end dead | kept; g1 end dead |
| `recoverIfDead` | dead-group-holding | `rename-aside` | 1 | 1 | removed; g1 end dead, lock T gone | absent; g1 end dead | kept; g1 end dead |
| `recoverIfDead` | dead-holding | `beacon-gen-end` | 1 | 1 | removed; g1 end dead, lock T gone | kept; g1 end dead | kept (beacon-gen-end EIO); g1 end dead |
| `recoverIfDead` | dead-holding | `end-link` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (end-link EIO) |
| `recoverIfDead` | dead-holding | `end-tmp` | 1 | 1 | removed; g1 end dead, lock T gone | kept (end-tmp ENOENT) | kept (end-tmp EIO) |
| `recoverIfDead` | dead-holding | `gen-end-read` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (gen-end-read EIO) |
| `recoverIfDead` | dead-holding | `gen-fields-read` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (gen-fields-read EIO) |
| `recoverIfDead` | dead-holding | `gen-list` | 1 | 1 | removed; g1 end dead, lock T gone | kept | kept (gen-list EIO) |
| `recoverIfDead` | dead-holding | `gen-realpath` | 1 | 2 | removed; g1 end dead, lock T gone | kept (gen-realpath ENOENT) | kept (gen-realpath EIO) |
| `recoverIfDead` | dead-holding | `gen-realpath` | 2 | 2 | removed; g1 end dead, lock T gone | kept (gen-realpath ENOENT) | kept (gen-realpath EIO) |
| `recoverIfDead` | dead-holding | `gen-root-mkdir` | 1 | 1 | removed; g1 end dead, lock T gone | kept (gen-root-mkdir ENOENT) | kept (gen-root-mkdir EIO) |
| `recoverIfDead` | dead-holding | `gen-tmp-mkdir` | 1 | 1 | removed; g1 end dead, lock T gone | kept (gen-tmp-mkdir ENOENT) | kept (gen-tmp-mkdir EIO) |
| `recoverIfDead` | dead-holding | `gen-tmp-unlink` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone |
| `recoverIfDead` | dead-holding | `gen-tmp-write` | 1 | 1 | removed; g1 end dead, lock T gone | kept (gen-tmp-write ENOENT) | kept (gen-tmp-write EIO) |
| `recoverIfDead` | dead-holding | `holder-pid` | 1 | 1 | removed; g1 end dead, lock T gone | kept (holder-pid ENOENT) | kept (holder-pid EIO) |
| `recoverIfDead` | dead-holding | `holder-read` | 1 | 2 | removed; g1 end dead, lock T gone | kept | kept (holder-read EIO) |
| `recoverIfDead` | dead-holding | `holder-read` | 2 | 2 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (holder-read EIO) |
| `recoverIfDead` | dead-holding | `holder-relist` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | kept (holder-relist EIO) |
| `recoverIfDead` | dead-holding | `list-queue` | 1 | 3 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | not-head |
| `recoverIfDead` | dead-holding | `list-queue` | 2 | 3 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone |
| `recoverIfDead` | dead-holding | `list-queue` | 3 | 3 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | not-head (list-queue EIO) |
| `recoverIfDead` | dead-holding | `list-root` | 1 | 1 | removed; g1 end dead, lock T gone | removed; g1 end dead, lock T gone | removed (list-root EIO); g1 end dead, lock T gone |
| `recoverIfDead` | dead-holding | `lock-owner` | 1 | 2 | removed; g1 end dead, lock T gone | kept; g1 end dead | kept (lock-owner EIO); g1 end dead |
| `recoverIfDead` | dead-holding | `lock-owner` | 2 | 2 | removed; g1 end dead, lock T gone | kept; g1 end dead | kept (lock-owner EIO); g1 end dead |
| `recoverIfDead` | dead-holding | `pid` | 1 | 1 | removed; g1 end dead, lock T gone | kept (pid ENOENT); g1 end dead | kept (pid EIO); g1 end dead |
| `recoverIfDead` | dead-holding | `recover-owner` | 1 | 1 | removed; g1 end dead, lock T gone | kept; g1 end dead | kept; g1 end dead |
| `recoverIfDead` | dead-holding | `rename-aside` | 1 | 1 | removed; g1 end dead, lock T gone | absent; g1 end dead | kept; g1 end dead |
| `recoverIfDead` | live-handoff | `beacon-gen-end` | 1 | 2 | kept | kept | kept (beacon-gen-end EIO) |
| `recoverIfDead` | live-handoff | `beacon-gen-end` | 2 | 2 | kept | removed; lock HC gone | kept (beacon-gen-end EIO) |
| `recoverIfDead` | live-handoff | `gen-end-read` | 1 | 1 | kept | kept | kept (gen-end-read EIO) |
| `recoverIfDead` | live-handoff | `gen-fields-read` | 1 | 1 | kept | kept | kept |
| `recoverIfDead` | live-handoff | `gen-list` | 1 | 1 | kept | kept | kept (gen-list EIO) |
| `recoverIfDead` | live-handoff | `gen-realpath` | 1 | 2 | kept | kept (gen-realpath ENOENT) | kept (gen-realpath EIO) |
| `recoverIfDead` | live-handoff | `gen-realpath` | 2 | 2 | kept | kept (gen-realpath ENOENT) | kept (gen-realpath EIO) |
| `recoverIfDead` | live-handoff | `gen-root-mkdir` | 1 | 1 | kept | kept (gen-root-mkdir ENOENT) | kept (gen-root-mkdir EIO) |
| `recoverIfDead` | live-handoff | `holder-pid` | 1 | 2 | kept | kept (holder-pid ENOENT) | kept (holder-pid EIO) |
| `recoverIfDead` | live-handoff | `holder-pid` | 2 | 2 | kept | kept (holder-pid ENOENT) | kept (holder-pid EIO) |
| `recoverIfDead` | live-handoff | `holder-read` | 1 | 4 | kept | kept | kept (holder-read EIO) |
| `recoverIfDead` | live-handoff | `holder-read` | 2 | 4 | kept | kept | kept (holder-read EIO) |
| `recoverIfDead` | live-handoff | `holder-read` | 3 | 4 | kept | kept | kept (holder-read EIO) |
| `recoverIfDead` | live-handoff | `holder-read` | 4 | 4 | kept | kept | kept (holder-read EIO) |
| `recoverIfDead` | live-handoff | `list-queue` | 1 | 3 | kept | kept | not-head |
| `recoverIfDead` | live-handoff | `list-queue` | 2 | 3 | kept | kept | kept |
| `recoverIfDead` | live-handoff | `list-queue` | 3 | 3 | kept | kept | not-head (list-queue EIO) |
| `recoverIfDead` | live-handoff | `list-root` | 1 | 1 | kept | kept | kept (list-root EIO) |
| `recoverIfDead` | live-handoff | `lock-owner` | 1 | 1 | kept | kept | kept (lock-owner EIO) |
| `recoverIfDead` | live-handoff | `pid` | 1 | 1 | kept | kept (pid ENOENT) | kept (pid EIO) |
| `recoverIfDead` | ownerless-old | `end-link` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | absent (end-link EIO); g1 records +1 |
| `recoverIfDead` | ownerless-old | `end-tmp` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent (end-tmp ENOENT); g1 records +1 | absent (end-tmp EIO); g1 records +1 |
| `recoverIfDead` | ownerless-old | `gen-end-read` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | absent (gen-end-read EIO) |
| `recoverIfDead` | ownerless-old | `gen-list` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent | absent (gen-list EIO) |
| `recoverIfDead` | ownerless-old | `gen-realpath` | 1 | 2 | absent; g1 end dead, g1 records +1 | kept (gen-realpath ENOENT) | kept (gen-realpath EIO) |
| `recoverIfDead` | ownerless-old | `gen-realpath` | 2 | 2 | absent; g1 end dead, g1 records +1 | kept (gen-realpath ENOENT) | kept (gen-realpath EIO) |
| `recoverIfDead` | ownerless-old | `gen-root-mkdir` | 1 | 1 | absent; g1 end dead, g1 records +1 | kept (gen-root-mkdir ENOENT) | kept (gen-root-mkdir EIO) |
| `recoverIfDead` | ownerless-old | `gen-tmp-mkdir` | 1 | 2 | absent; g1 end dead, g1 records +1 | absent (gen-tmp-mkdir ENOENT) | absent (gen-tmp-mkdir EIO) |
| `recoverIfDead` | ownerless-old | `gen-tmp-mkdir` | 2 | 2 | absent; g1 end dead, g1 records +1 | absent (gen-tmp-mkdir ENOENT); g1 records +1 | absent (gen-tmp-mkdir EIO); g1 records +1 |
| `recoverIfDead` | ownerless-old | `gen-tmp-unlink` | 1 | 2 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 |
| `recoverIfDead` | ownerless-old | `gen-tmp-unlink` | 2 | 2 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 |
| `recoverIfDead` | ownerless-old | `gen-tmp-write` | 1 | 2 | absent; g1 end dead, g1 records +1 | absent (gen-tmp-write ENOENT) | absent (gen-tmp-write EIO) |
| `recoverIfDead` | ownerless-old | `gen-tmp-write` | 2 | 2 | absent; g1 end dead, g1 records +1 | absent (gen-tmp-write ENOENT); g1 records +1 | absent (gen-tmp-write EIO); g1 records +1 |
| `recoverIfDead` | ownerless-old | `holder-read` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | absent (holder-read EIO) |
| `recoverIfDead` | ownerless-old | `list-queue` | 1 | 3 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | not-head |
| `recoverIfDead` | ownerless-old | `list-queue` | 2 | 3 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 |
| `recoverIfDead` | ownerless-old | `list-queue` | 3 | 3 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | not-head (list-queue EIO) |
| `recoverIfDead` | ownerless-old | `list-root` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | absent (list-root EIO); g1 end dead, g1 records +1 |
| `recoverIfDead` | ownerless-old | `lock-list` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | kept; g1 end dead, g1 records +1 |
| `recoverIfDead` | ownerless-old | `lock-owner` | 1 | 2 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | kept (lock-owner EIO); g1 end dead, g1 records +1 |
| `recoverIfDead` | ownerless-old | `lock-owner` | 2 | 2 | absent; g1 end dead, g1 records +1 | absent; g1 end dead, g1 records +1 | kept; g1 end dead, g1 records +1 |
| `recoverIfDead` | ownerless-old | `ownerless-gen-mtime` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent | absent (ownerless-gen-mtime EIO) |
| `recoverIfDead` | ownerless-old | `tomb-link` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent | absent (tomb-link EIO) |
| `recoverIfDead` | ownerless-old | `tomb-tmp` | 1 | 1 | absent; g1 end dead, g1 records +1 | absent (tomb-tmp ENOENT) | absent (tomb-tmp EIO) |
| `releaseAsHead` | dead-group-holding | `beacon-gen-end` | 1 | 1 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); g1 end dead, lock T gone | deferred (beacon-gen-end EIO); g1 end dead, lock T gone |
| `releaseAsHead` | dead-group-holding | `end-link` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (end-link EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `end-tmp` | 1 | 1 | released; g1 end dead, lock T gone | deferred (end-tmp ENOENT); lock T gone | deferred (end-tmp EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `gen-end-read` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-end-read EIO) |
| `releaseAsHead` | dead-group-holding | `gen-end-read` | 2 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-end-read EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `gen-fields-read` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-fields-read EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `gen-list` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-list EIO) |
| `releaseAsHead` | dead-group-holding | `gen-list` | 2 | 2 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (gen-list EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `gen-realpath` | 1 | 2 | released; g1 end dead, lock T gone | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | dead-group-holding | `gen-realpath` | 2 | 2 | released; g1 end dead, lock T gone | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | dead-group-holding | `gen-root-mkdir` | 1 | 1 | released; g1 end dead, lock T gone | deferred (gen-root-mkdir ENOENT) | deferred (gen-root-mkdir EIO) |
| `releaseAsHead` | dead-group-holding | `gen-tmp-mkdir` | 1 | 1 | released; g1 end dead, lock T gone | deferred (gen-tmp-mkdir ENOENT); lock T gone | deferred (gen-tmp-mkdir EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `gen-tmp-unlink` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-group-holding | `gen-tmp-write` | 1 | 1 | released; g1 end dead, lock T gone | deferred (gen-tmp-write ENOENT); lock T gone | deferred (gen-tmp-write EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `group` | 1 | 1 | released; g1 end dead, lock T gone | deferred (group ENOENT) | deferred (group EIO) |
| `releaseAsHead` | dead-group-holding | `holder-group` | 1 | 2 | released; g1 end dead, lock T gone | deferred (holder-group ENOENT) | deferred (holder-group EIO) |
| `releaseAsHead` | dead-group-holding | `holder-group` | 2 | 2 | released; g1 end dead, lock T gone | deferred (holder-group ENOENT); lock T gone | deferred (holder-group EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `holder-pid` | 1 | 2 | released; g1 end dead, lock T gone | deferred (holder-pid ENOENT) | deferred (holder-pid EIO) |
| `releaseAsHead` | dead-group-holding | `holder-pid` | 2 | 2 | released; g1 end dead, lock T gone | deferred (holder-pid ENOENT); lock T gone | deferred (holder-pid EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `holder-read` | 1 | 6 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO) |
| `releaseAsHead` | dead-group-holding | `holder-read` | 2 | 6 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO) |
| `releaseAsHead` | dead-group-holding | `holder-read` | 3 | 6 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `holder-read` | 4 | 6 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `holder-read` | 5 | 6 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `holder-read` | 6 | 6 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `holder-relist` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-relist EIO); lock T gone |
| `releaseAsHead` | dead-group-holding | `list-queue` | 1 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | not-head |
| `releaseAsHead` | dead-group-holding | `list-queue` | 2 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-group-holding | `list-queue` | 3 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | not-head (list-queue EIO) |
| `releaseAsHead` | dead-group-holding | `lock-owner` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-group-holding | `pid` | 1 | 1 | released; g1 end dead, lock T gone | deferred (pid ENOENT) | deferred (pid EIO) |
| `releaseAsHead` | dead-group-holding | `recover-owner` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-group-holding | `release-list` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-group-holding | `release-owner` | 1 | 1 | released; g1 end dead, lock T gone | missing; g1 end dead | unknown (release-owner EIO) |
| `releaseAsHead` | dead-group-holding | `rename-aside` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding | `beacon-gen-end` | 1 | 1 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); g1 end dead, lock T gone | deferred (beacon-gen-end EIO); g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding | `end-link` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (end-link EIO); lock T gone |
| `releaseAsHead` | dead-holding | `end-tmp` | 1 | 1 | released; g1 end dead, lock T gone | deferred (end-tmp ENOENT); lock T gone | deferred (end-tmp EIO); lock T gone |
| `releaseAsHead` | dead-holding | `gen-end-read` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-end-read EIO) |
| `releaseAsHead` | dead-holding | `gen-end-read` | 2 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-end-read EIO); lock T gone |
| `releaseAsHead` | dead-holding | `gen-fields-read` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-fields-read EIO); lock T gone |
| `releaseAsHead` | dead-holding | `gen-list` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-list EIO) |
| `releaseAsHead` | dead-holding | `gen-list` | 2 | 2 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (gen-list EIO); lock T gone |
| `releaseAsHead` | dead-holding | `gen-realpath` | 1 | 2 | released; g1 end dead, lock T gone | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | dead-holding | `gen-realpath` | 2 | 2 | released; g1 end dead, lock T gone | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | dead-holding | `gen-root-mkdir` | 1 | 1 | released; g1 end dead, lock T gone | deferred (gen-root-mkdir ENOENT) | deferred (gen-root-mkdir EIO) |
| `releaseAsHead` | dead-holding | `gen-tmp-mkdir` | 1 | 1 | released; g1 end dead, lock T gone | deferred (gen-tmp-mkdir ENOENT); lock T gone | deferred (gen-tmp-mkdir EIO); lock T gone |
| `releaseAsHead` | dead-holding | `gen-tmp-unlink` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding | `gen-tmp-write` | 1 | 1 | released; g1 end dead, lock T gone | deferred (gen-tmp-write ENOENT); lock T gone | deferred (gen-tmp-write EIO); lock T gone |
| `releaseAsHead` | dead-holding | `holder-pid` | 1 | 2 | released; g1 end dead, lock T gone | deferred (holder-pid ENOENT) | deferred (holder-pid EIO) |
| `releaseAsHead` | dead-holding | `holder-pid` | 2 | 2 | released; g1 end dead, lock T gone | deferred (holder-pid ENOENT); lock T gone | deferred (holder-pid EIO); lock T gone |
| `releaseAsHead` | dead-holding | `holder-read` | 1 | 6 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO) |
| `releaseAsHead` | dead-holding | `holder-read` | 2 | 6 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO) |
| `releaseAsHead` | dead-holding | `holder-read` | 3 | 6 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding | `holder-read` | 4 | 6 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding | `holder-read` | 5 | 6 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding | `holder-read` | 6 | 6 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding | `holder-relist` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-relist EIO); lock T gone |
| `releaseAsHead` | dead-holding | `list-queue` | 1 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | not-head |
| `releaseAsHead` | dead-holding | `list-queue` | 2 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding | `list-queue` | 3 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | not-head (list-queue EIO) |
| `releaseAsHead` | dead-holding | `lock-owner` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding | `pid` | 1 | 1 | released; g1 end dead, lock T gone | deferred (pid ENOENT) | deferred (pid EIO) |
| `releaseAsHead` | dead-holding | `recover-owner` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding | `release-list` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding | `release-owner` | 1 | 1 | released; g1 end dead, lock T gone | missing; g1 end dead | unknown (release-owner EIO) |
| `releaseAsHead` | dead-holding | `rename-aside` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding end-cleaned | `beacon-gen-end` | 1 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (beacon-gen-end EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `beacon-gen-end` | 2 | 3 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (beacon-gen-end EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `beacon-gen-end` | 3 | 3 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); g1 end dead, lock T gone | deferred (beacon-gen-end EIO); g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `end-link` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (end-link EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `end-link` | 2 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (end-link EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `end-tmp` | 1 | 2 | released; g1 end dead, lock T gone | deferred (end-tmp ENOENT); lock T gone | deferred (end-tmp EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `end-tmp` | 2 | 2 | released; g1 end dead, lock T gone | deferred (end-tmp ENOENT); lock T gone | deferred (end-tmp EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-end-read` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-end-read EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `gen-end-read` | 2 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-end-read EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-fields-read` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-fields-read EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-fields-read` | 2 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-fields-read EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-list` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-list EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `gen-list` | 2 | 2 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (gen-list EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-realpath` | 1 | 2 | released; g1 end dead, lock T gone | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `gen-realpath` | 2 | 2 | released; g1 end dead, lock T gone | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `gen-root-mkdir` | 1 | 1 | released; g1 end dead, lock T gone | deferred (gen-root-mkdir ENOENT) | deferred (gen-root-mkdir EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `gen-tmp-mkdir` | 1 | 2 | released; g1 end dead, lock T gone | deferred (gen-tmp-mkdir ENOENT); lock T gone | deferred (gen-tmp-mkdir EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-tmp-mkdir` | 2 | 2 | released; g1 end dead, lock T gone | deferred (gen-tmp-mkdir ENOENT); lock T gone | deferred (gen-tmp-mkdir EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-tmp-unlink` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-tmp-unlink` | 2 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-tmp-write` | 1 | 2 | released; g1 end dead, lock T gone | deferred (gen-tmp-write ENOENT); lock T gone | deferred (gen-tmp-write EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `gen-tmp-write` | 2 | 2 | released; g1 end dead, lock T gone | deferred (gen-tmp-write ENOENT); lock T gone | deferred (gen-tmp-write EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-pid` | 1 | 3 | released; g1 end dead, lock T gone | deferred (holder-pid ENOENT) | deferred (holder-pid EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `holder-pid` | 2 | 3 | released; g1 end dead, lock T gone | deferred (holder-pid ENOENT); lock T gone | deferred (holder-pid EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-pid` | 3 | 3 | released; g1 end dead, lock T gone | deferred (holder-pid ENOENT); lock T gone | deferred (holder-pid EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-read` | 1 | 8 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `holder-read` | 2 | 8 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `holder-read` | 3 | 8 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-read` | 4 | 8 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-read` | 5 | 8 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-read` | 6 | 8 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-read` | 7 | 8 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-read` | 8 | 8 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-relist` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-relist EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `holder-relist` | 2 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-relist EIO); lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `list-queue` | 1 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | not-head |
| `releaseAsHead` | dead-holding end-cleaned | `list-queue` | 2 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `list-queue` | 3 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | not-head (list-queue EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `lock-owner` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding end-cleaned | `pid` | 1 | 1 | released; g1 end dead, lock T gone | deferred (pid ENOENT) | deferred (pid EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `recover-owner` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding end-cleaned | `release-list` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding end-cleaned | `release-owner` | 1 | 1 | released; g1 end dead, lock T gone | missing; g1 end dead | unknown (release-owner EIO) |
| `releaseAsHead` | dead-holding end-cleaned | `rename-aside` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding owner-vanished | `beacon-gen-end` | 1 | 1 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); g1 end dead, lock T gone | deferred (beacon-gen-end EIO); g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `end-link` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (end-link EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `end-tmp` | 1 | 1 | released; g1 end dead, lock T gone | deferred (end-tmp ENOENT); lock T gone | deferred (end-tmp EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `gen-end-read` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-end-read EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `gen-end-read` | 2 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-end-read EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `gen-fields-read` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-fields-read EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `gen-list` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (gen-list EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `gen-list` | 2 | 2 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (gen-list EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `gen-realpath` | 1 | 2 | released; g1 end dead, lock T gone | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `gen-realpath` | 2 | 2 | released; g1 end dead, lock T gone | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `gen-root-mkdir` | 1 | 1 | released; g1 end dead, lock T gone | deferred (gen-root-mkdir ENOENT) | deferred (gen-root-mkdir EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `gen-tmp-mkdir` | 1 | 2 | released; g1 end dead, lock T gone | deferred (gen-tmp-mkdir ENOENT); lock T gone | deferred (gen-tmp-mkdir EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `gen-tmp-mkdir` | 2 | 2 | released; g1 end dead, lock T gone | deferred (gen-tmp-mkdir ENOENT); lock T gone | deferred (gen-tmp-mkdir EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `gen-tmp-unlink` | 1 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `gen-tmp-unlink` | 2 | 2 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `gen-tmp-write` | 1 | 2 | released; g1 end dead, lock T gone | deferred (gen-tmp-write ENOENT); lock T gone | deferred (gen-tmp-write EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `gen-tmp-write` | 2 | 2 | released; g1 end dead, lock T gone | deferred (gen-tmp-write ENOENT); lock T gone | deferred (gen-tmp-write EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `holder-pid` | 1 | 2 | released; g1 end dead, lock T gone | deferred (holder-pid ENOENT) | deferred (holder-pid EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `holder-pid` | 2 | 2 | released; g1 end dead, lock T gone | deferred (holder-pid ENOENT); lock T gone | deferred (holder-pid EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `holder-read` | 1 | 7 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `holder-read` | 2 | 7 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `holder-read` | 3 | 7 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `holder-read` | 4 | 7 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `holder-read` | 5 | 7 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `holder-read` | 6 | 7 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `holder-read` | 7 | 7 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-read EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `holder-relist` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | deferred (holder-relist EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `list-queue` | 1 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | not-head |
| `releaseAsHead` | dead-holding owner-vanished | `list-queue` | 2 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `list-queue` | 3 | 3 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | not-head (list-queue EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `lock-owner` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding owner-vanished | `ownerless-gen-mtime` | 1 | 1 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (ownerless-gen-mtime EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `pid` | 1 | 1 | released; g1 end dead, lock T gone | deferred (pid ENOENT) | deferred (pid EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `recover-owner` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding owner-vanished | `release-list` | 1 | 1 | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone | released; g1 end dead, lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `release-owner` | 1 | 1 | released; g1 end dead, lock T gone | missing; g1 end dead | unknown (release-owner EIO) |
| `releaseAsHead` | dead-holding owner-vanished | `rename-aside` | 1 | 1 | released; g1 end dead, lock T gone | kept | kept |
| `releaseAsHead` | dead-holding owner-vanished | `tomb-link` | 1 | 1 | released; g1 end dead, lock T gone | deferred (beacon-gen-end EAGAIN); lock T gone | deferred (tomb-link EIO); lock T gone |
| `releaseAsHead` | dead-holding owner-vanished | `tomb-tmp` | 1 | 1 | released; g1 end dead, lock T gone | deferred (tomb-tmp ENOENT); lock T gone | deferred (tomb-tmp EIO); lock T gone |
| `releaseAsHead` | first-alive | `gen-end-read` | 1 | 1 | deferred | deferred | deferred (gen-end-read EIO) |
| `releaseAsHead` | first-alive | `gen-list` | 1 | 1 | deferred | deferred (beacon-gen-end EAGAIN); lock HB gone | deferred (gen-list EIO) |
| `releaseAsHead` | first-alive | `gen-realpath` | 1 | 2 | deferred | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | first-alive | `gen-realpath` | 2 | 2 | deferred | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | first-alive | `gen-root-mkdir` | 1 | 1 | deferred | deferred (gen-root-mkdir ENOENT) | deferred (gen-root-mkdir EIO) |
| `releaseAsHead` | first-alive | `holder-pid` | 1 | 1 | deferred | deferred (holder-pid ENOENT) | deferred (holder-pid EIO) |
| `releaseAsHead` | first-alive | `holder-read` | 1 | 3 | deferred | deferred (beacon-gen-end EAGAIN); lock HB gone | deferred (holder-read EIO) |
| `releaseAsHead` | first-alive | `holder-read` | 2 | 3 | deferred | deferred | deferred (holder-read EIO) |
| `releaseAsHead` | first-alive | `holder-read` | 3 | 3 | deferred | deferred | deferred (holder-read EIO) |
| `releaseAsHead` | first-alive | `list-queue` | 1 | 3 | deferred | deferred | not-head |
| `releaseAsHead` | first-alive | `list-queue` | 2 | 3 | deferred | deferred | deferred |
| `releaseAsHead` | first-alive | `list-queue` | 3 | 3 | deferred | deferred | not-head (list-queue EIO) |
| `releaseAsHead` | first-alive | `pid` | 1 | 1 | deferred | deferred (pid ENOENT) | deferred (pid EIO) |
| `releaseAsHead` | first-alive | `release-owner` | 1 | 1 | deferred | missing | unknown (release-owner EIO) |
| `releaseAsHead` | live-handoff | `gen-end-read` | 1 | 1 | deferred | deferred | deferred (gen-end-read EIO) |
| `releaseAsHead` | live-handoff | `gen-list` | 1 | 1 | deferred | deferred (beacon-gen-end EAGAIN); lock HC gone | deferred (gen-list EIO) |
| `releaseAsHead` | live-handoff | `gen-realpath` | 1 | 2 | deferred | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | live-handoff | `gen-realpath` | 2 | 2 | deferred | deferred (gen-realpath ENOENT) | deferred (gen-realpath EIO) |
| `releaseAsHead` | live-handoff | `gen-root-mkdir` | 1 | 1 | deferred | deferred (gen-root-mkdir ENOENT) | deferred (gen-root-mkdir EIO) |
| `releaseAsHead` | live-handoff | `holder-pid` | 1 | 2 | deferred | deferred (holder-pid ENOENT) | deferred (holder-pid EIO) |
| `releaseAsHead` | live-handoff | `holder-pid` | 2 | 2 | deferred | deferred (holder-pid ENOENT) | deferred (holder-pid EIO) |
| `releaseAsHead` | live-handoff | `holder-read` | 1 | 4 | deferred | deferred (beacon-gen-end EAGAIN); lock HC gone | deferred (holder-read EIO) |
| `releaseAsHead` | live-handoff | `holder-read` | 2 | 4 | deferred | deferred (beacon-gen-end EAGAIN); lock HC gone | deferred (holder-read EIO) |
| `releaseAsHead` | live-handoff | `holder-read` | 3 | 4 | deferred | deferred | deferred (holder-read EIO) |
| `releaseAsHead` | live-handoff | `holder-read` | 4 | 4 | deferred | deferred | deferred (holder-read EIO) |
| `releaseAsHead` | live-handoff | `list-queue` | 1 | 3 | deferred | deferred | not-head |
| `releaseAsHead` | live-handoff | `list-queue` | 2 | 3 | deferred | deferred | deferred |
| `releaseAsHead` | live-handoff | `list-queue` | 3 | 3 | deferred | deferred | not-head (list-queue EIO) |
| `releaseAsHead` | live-handoff | `pid` | 1 | 1 | deferred | deferred (pid ENOENT) | deferred (pid EIO) |
| `releaseAsHead` | live-handoff | `release-owner` | 1 | 1 | deferred | missing | unknown (release-owner EIO) |
| `resolveGenDir` | by-path | `gen-realpath` | 1 | 2 | chain by-path/<hash>.gen | unknown (gen-realpath ENOENT) | unknown (gen-realpath EIO) |
| `resolveGenDir` | by-path | `gen-realpath` | 2 | 2 | chain by-path/<hash>.gen | unknown (gen-realpath ENOENT) | unknown (gen-realpath EIO) |
| `resolveGenDir` | named | `gen-realpath` | 1 | 2 | chain x.gen | unknown (gen-realpath ENOENT) | unknown (gen-realpath EIO) |
| `resolveGenDir` | named | `gen-realpath` | 2 | 2 | chain x.gen | unknown (gen-realpath ENOENT) | unknown (gen-realpath EIO) |

---

## 9. PR の切り方

- **PR-1**: この文書＋T1＋T7（振る舞いは変えない）
- **PR-2**: SJ の核（世代の手順を export。今の回収は目印の旧い版の保有者のためだけに残す）＋TS の import（重複する手順を消す。TS の配布物に SJ の核が bundle されることを確かめる）＋目印＋`fields` の写し＋D8 の継承＋T2・T4・T6 の JS の行＋T3 の JS の部分＋T5 の「新 JS × 今の bash」の組。`docs/design/machine-lock-owner-atomic-4288.md` の保証の文・I8・表 F を書き直し、T7 に表 F との対を足す。`changelog.d/4559.md` を閉じた版の説明へ替える
- **PR-3**: bash（`verify-run.sh` と `.agents` の鏡）＋sync-map の pin 3 つ（cmate-verify の `SKILL.md`・`scripts/tests/run-tests.sh`・`scripts/verify-run.sh`）＋SKILL.md のロックの規約の表＋`scripts/lib/machine-lock.sh`（`lock_release_held` を世代の解放の順に、needs-head を世代の回収に寄せる）＋`scripts/uat/run-lock.sh`＋T2 の bash の行＋T3 の bash の部分＋T5
- 外の読み手（merge-pr・merge-train・`lib.sh` の `product_lock_kind`・`src/lib/agent-health/run-lock.ts`）は核の「今の保有者を読む」口へ移す（PR-2・PR-3 の該当する方）
- PR-2 の TS は SJ の核をバイトのまま写した生成物を import する（案 F）。写しは一致の試験で固定し、T3 の走査は一致を前提に写しを除く。`run-lock.ts` は配布物に入らないので SJ を直に import したまま
- M2／M3 の切替の手順（§6.3）は PR-3 の後の別 PR。常駐 worktree の更新が済んでから。counterpart（skills 側）の移植は別（PM・人）
- 既存の試験の期待を変えてよいのは、人の決定（2026-11-25）の一覧の 6 件だけで、PR-2・PR-3 で変える。PR-1 はどれも変えない

---

## 10. 書く途中で見つけた食い違いと決まり

- **D-1 身を引く `end`（決まった。PM の処分 (a)）**: 身を引く `end` を外した版は、(i)・(ii)・厳しい C4・片付け無しのどの組でも S1・S2・S4 に違反しなかった。手順は v3.1 のまま（書く）で、身を引く `end` を「安全・活性に要らない、診断と片付けの目印」と書いた（§4.1）。壊した版の一覧から外し、活性の壊した版の 2 本目に `no-tomb` を足した（§7.2）。「要らない」は自分より大きい世代を見て身を引く場合に限る。それ以外の諦める道は自分の世代に `end` を書く（§4.1。壊した版 `abort-no-end` が S4 で赤）
- **D-2 `HOREL` の数え方（決まった）**: 元の模型は「子が走っている間の解放」を数えていて、§4.2 の決まりの下では壊した版 `release-live-child` でしか届かない（変えない版で 0）。T1 は「子の記録を持つ世代の解放」を数える（前の周の子を持ち越した解放は数えない。§7.1）
- **D-3 `release-live-child` の最初の違反（模型の限界として記録）**: 元の模型では S1（2 人）、親が終わった者は `child-exit` だけを歩く直しの後は S2（生きた保有者の世代が終わらされる）。S1 だけを見ても赤なので、赤の理由は両方を比べた。模型は 1 者の子を保有ごとに数え直すが、この壊した版では前の保有の子が残ったまま同じ者が次の保有者になりうる（§7.4 の限界 (2)）。安全の側の数え漏れにはならない
