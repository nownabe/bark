# Environment improvement suggestions

このファイルは AI エージェントが環境/サンドボックス起因の不足を見つけたときの
**提案置き場**です(CLAUDE.md「When a sandboxed command fails」準拠)。ユーザーが
レビューして適用します。エージェントは設定ファイルを直接編集しません。

---

## openssh が `devbox shell --pure` に無い → `git push` (ssh remote) が失敗

- **症状**: `git push origin <branch>` が `cannot run ssh: No such file or directory / fatal: unable to fork` で失敗。
- **原因**: origin が `ssh://git@github.com/...` だが、`--pure` シェルに `ssh` バイナリが無い(devbox.json に openssh 未宣言)。
- **回避(今回)**: `git -c credential.helper='!gh auth git-credential' push https://github.com/nownabe/mkprev.git <ref>` で https + gh トークンを使って一回限り push。
- **提案(最小)**: `devbox.json` の packages に **`openssh@latest`** を追加する。
  これで既存の ssh remote 経由の `git push`/`git fetch` が pure シェルからも動く。
  - 注: `git push` はポリシー上 `ask` ゲートのまま(本提案は ssh バイナリの有無の話で、push の許可とは別)。

---

## サンドボックスから `api.github.com` に届かない → 実 API 統合テストが network 不可

- **症状**: `bun scripts/check-integration.ts`(GitHub REST を直接叩く)が sandbox 内で network エラー。
- **原因**: `sandbox.network.allowedDomains` に `api.github.com` が無い(現状 `registry.npmjs.org` のみ)。
- **回避(今回)**: `direnv exec . bun ...` を `dangerouslyDisableSandbox` で一回限り実行(read 専用、GH_PAT はユーザー提供)。
- **提案(最小)**: `.claude/settings.json` の `sandbox.network.allowedDomains` に **`api.github.com`** を追加する。
  これで拡張のロジック(取得・投稿)を実 API で統合テストでき、毎回 sandbox を外さずに済む。
  - トークンは `.envrc` の `GH_PAT`(direnv)から渡す。settings 反映は次回セッションから。

---

## `bun install`/`bun add` 後に全 bash が bwrap 初期化失敗(`.cache/bun/...` を mkdir できない)

- **症状**: `bwrap: Can't mkdir parents for .../.cache/bun/<pkg>@@@1/...: No such file or directory`。
  git を含むあらゆる bash が(セッション途中で)実行不能になる。
- **原因(確定)**: bun のキャッシュ(`.cache/bun`)は **絶対パス向きの dir symlink** を多数(現状 435 個)生成する。
  例: `.cache/bun/postcss/8.5.15@@@1 -> /home/nownabe/src/github.com/nownabe/mkprev/.cache/bun/postcss@8.5.15@@@1`。
  一方 sandbox は `denyRead: ["~/"]` で home 全体を隠した上で `allowRead: ["."]` でプロジェクトを再公開する
  構成。プロジェクトは `~/` の**配下**にあるため、再公開時に「ターゲットが(文字列上)denied な `~/` 配下を指す
  絶対 symlink」を bwrap が個別ファイル単位で再マウントしようとし、symlink を経由した
  `mkdir parents .../8.5.15@@@1/lib/tokenize.js` が ENOENT で失敗 → 以降の全 bash(git 含む)が落ちる。
  - 検証: symlink もターゲット実体(`tokenize.js`)も**壊れていない**(`readlink -f` で解決可)。
    壊れているのは bwrap の名前空間再構築であって、キャッシュの中身ではない。
  - セッション開始時に派生した bind リストが `bun add/install` 後に陳腐化する側面もあるが、根本は上記の
    「`~/` denied 配下を指す絶対 symlink」。restart だけでは再発する(symlink は永続するため)。
- **回避(今回)**: 当該コマンドを `dangerouslyDisableSandbox` で実行。restart は一時的な解消にしかならない。
- **検証で潰した選択肢**:
  - bun env で symlink を相対化: **不可**。`BUN_INSTALL_CACHE_DIR` を相対パス(`.cache/bun`)で渡しても
    bun が絶対パスに解決し、絶対 symlink を生成する。bun に symlink 構造を無効化/相対化する env は無い。
  - キャッシュ無効化(`[install.cache] disable = true`): **不可**。絶対 symlink が消えるのではなく
    `node_modules/.cache/` に作り直されるだけ(検証で絶対 symlink 1 件確認)。in-project なので状況は悪化。
    絶対 symlink は「キャッシュの中身そのもの」で、bun はキャッシュをどこに置いても必ず生成する。
    → 解決には「キャッシュを `~/` 配下の再公開領域の外に出す」か「sandbox にそのパスを辿らせない」のどちらか。
    なお現 `node_modules` 本体は相対 symlink のみ(絶対 0)で sandbox 上問題なし。壊すのは `.cache/bun` だけ。
  - symlink を install 後に相対化(`scripts/relativize-bun-cache.sh` + postinstall): 動くが**対症療法**。
    bun の内部レイアウトを毎回書き換える/取りこぼすと再発、で筋が悪い。フックを通さない install で復活する。
- **提案A(推奨・in-project 維持)**: `.claude/settings.json` の `sandbox.filesystem.denyRead` に
  **`.cache/bun`** を追加(`["~/", ".cache/bun"]`)。denyRead は bind 生成より前に処理されるため、
  Claude Code が `.cache/bun` 内の symlink を辿って per-file bind を作る処理ごとスキップし init が通る。
  キャッシュは**プロジェクト dir 内のまま**・設定1行・フック不要・bun の内部と戦わない。
  - トレードオフ: sandbox 内からキャッシュが**読めなくなる**(書込は可)ため、sandbox 内の `bun install` は
    毎回 `registry.npmjs.org` から再取得。`bun run`/`test`(node_modules 使用)と sandbox 外利用は無影響。
  - 注: 挙動は公式ドキュメント未記載でソース/issue ベースの推測(関連 issue #40133, #18631)。次セッションで要検証。
- **提案B(キャッシュを `~/` の外へ)**: in-project に拘らないなら **`BUN_INSTALL_CACHE_DIR` を `~/` 外**
  (`${TMPDIR:-/tmp}/mkprev-bun-cache` 等、sandbox 既定で読書可能な temp)へ移す。絶対 symlink のターゲットが
  非 denied 領域に入り、sandbox 内でもキャッシュが効く(install が速い)。揮発しても取得先は許可済み。
- **当面の回避**: 当該コマンドを `dangerouslyDisableSandbox` で実行。restart は一時しのぎ(symlink は永続し再発)。
- **上流**: 「`~/` を deny しつつ配下のプロジェクトを再公開」構成 × プロジェクト内に絶対 symlink を撒く bun
  キャッシュの相性問題。sandbox が「プロジェクト内に閉じた絶対 symlink」を1枚の再帰 bind で扱えれば本来不要
  (バグ報告筋。また `CLAUDE_CODE_SANDBOX_DEBUG` 相当で生成 bwrap argv を出せる機能も要望余地)。

---

## `PreToolUse:TaskCreate` フックエラー(= sandbox 内で `chikuwa hook` が失敗)

- **症状**: TaskCreate(エージェント起動)時に `PreToolUse:TaskCreate hook error` が出る。
- **原因**: `TaskCreate` にマッチする PreToolUse フックはグローバル設定の **matcher 無しエントリ
  `chikuwa hook` 1つだけ**。`chikuwa` は `~/.local/bin/chikuwa` にありホスト側テレメトリ用だが、
  `sandbox.excludedCommands` に入っていない(現状 `git`, `gh` のみ)ため **sandbox 経由で実行**される。
  検証: sandbox 無効なら `exit=0`、sandbox 経由だと `.cache/bun` の bwrap 失敗(上記 #3)で落ちる。
  加えて `denyRead: ["~/"]` 下では sandbox から `~/.local/bin/chikuwa` 自体が読めない。
  → TaskCreate のフックエラーは「sandbox 内 chikuwa の失敗」であり、別物ではない。
- **回避(今回)**: なし(フックなので毎回走る)。bun キャッシュ問題はセッション再起動で解消。
- **提案(最小)**: `~/.claude/settings.json`(home-manager 管理)の `sandbox.excludedCommands` に
  **`chikuwa`** を追加し、`git`/`gh` と同様にフックをホスト側(非 sandbox)で実行する。
  これで bun キャッシュ問題に依存せず、全フック(SessionStart/UserPromptSubmit/PreToolUse 等)の
  sandbox 起因エラーが解消する。`chikuwa` は読み取り・記録のみでネットワーク/書き込み境界を必要としない。
  - 注: グローバル設定は Nix(home-manager)管理で read-only のため、変更は Nix 設定経由。次回セッションから反映。

---

## `.devbox` プロファイルの dir symlink で bwrap 初期化失敗(= 全 bash が起動不能)

- **症状**: あらゆる sandbox 内 bash が
  `bwrap: Can't mkdir parents for .../.devbox/nix/profile/default-9-link/share/gnupg/sks-keyservers.netCA.pem: No such file or directory`
  で失敗。`dangerouslyDisableSandbox` なら正常動作。→ sandbox ON で死に、OFF で動く。
- **原因(確定)**: **#3 と同じ根本原因**(プロジェクト内の symlink を bwrap が per-file bind で貫けない)。
  今回のトリガーは `.cache/bun` ではなく **devbox プロファイル**。
  `.devbox/nix/profile/default-9-link -> /nix/store/<hash>-profile` という dir symlink があり、
  その配下の `share/gnupg`・`share/man`・`share/git/contrib` のファイル(/nix/store 実体・world-readable)を
  sandbox が個別 bind しようとする。bind 先パスが symlink (`default-9-link`/`default`) を貫くため
  `mkdir parents .../share/gnupg/...` が ENOENT → 以降の全 bash(git 含む)が落ちる。
  - 検証: ファイル実体も symlink も壊れていない(`readlink -f` で
    `/nix/store/<hash>-gnupg-2.4.9/share/gnupg/sks-keyservers.netCA.pem` に解決)。壊れるのは bwrap の名前空間再構築のみ。
  - 個別 bind 対象は `share/*`(docs/man/contrib)のみで **`bin`/`lib` は含まれない**(= ツールチェーン exec 自体は無関係)。
- **回避(今回)**: 当該コマンドを `dangerouslyDisableSandbox` で実行。
- **提案A(却下・検証で失敗)**: `sandbox.filesystem.denyRead` に
  **`.devbox/nix/profile/default-9-link/share`** と **`.devbox/nix/profile/default/share`** を追加。
  「denyRead は bind 生成より前に処理されるので per-file bind をスキップして init が通る」という想定だった。
  - **検証結果(2026-06-15, 反映後セッション)**: **効かない。** エラーが
    `Can't mkdir .../default-9-link/share`(= 今 deny に足したパスそのもの)へ**1段浅く移動しただけ**で、
    sandbox は依然起動しない。
  - **判明した事実(=提案Aの前提が誤り)**: denyRead は「bind を作らない」のではなく
    「そのパスを**隠すための mount を新ルートに張る**」動作。その隠しマウントの**マウント先も**
    `default-9-link`(symlink)の下に `mkdir` する必要があり、bind だろうが deny だろうが
    **symlink の下にマウント先を作る限り同じ ENOENT で落ちる**。
  - **波及**: 同じ理屈の **#3 の提案A(denyRead `.cache/bun`)も効かない公算が高い**(未再検証だが要警戒)。
    「symlink を貫くパスを deny で回避」という発想自体が原理的に不可。
- **提案B(現実的に残る方向)**: 回避先は「symlink の**下**にマウント先を作らせない」しかない。候補:
  1. symlink を貫かない実ディレクトリ(`.devbox/nix` など real dir の階層)単位で deny できるか。ただし
     その配下に `bin`/`lib` が含まれるとツールチェーンが見えなくなるため、**ツールチェーン破壊との両立可否は要検証**。
  2. symlink 自体(`.devbox/nix/profile/default` / `default-9-link`)を deny。symlink の「下」ではなく
     symlink そのものを隠すので mkdir 貫通は起きない可能性があるが、`bin`/`lib` も巻き添えで隠れ
     **`bun`/`jq` が動かなくなる**懸念。`ls`/`cat` 等は動くかもしれず、切り分け用の実験としてのみ価値あり。
  3. **本命=上流対応**: Claude Code sandbox が、プロジェクト内 symlink を「symlink のまま 1 枚 bind」
     あるいは `.devbox/nix/profile`(または `/nix/store`)を「1 枚の再帰 bind」として扱えば、
     symlink 配下に per-file マウント先を作る処理自体が消え、本問題と #3 の両方が解決する。
- **当面の運用**: denyRead での回避は不可と確定。sandbox は壊れたまま運用し、必要時に
  `dangerouslyDisableSandbox` で個別実行する(根本解決は上流待ち)。
- **上流**: #3 と同じく「`~/` を deny しつつ配下プロジェクトを再公開」× 「プロジェクト内の(/nix/store や `~/` 配下を指す)
  symlink を bwrap が per-file bind で貫こうとする」相性問題。bun キャッシュと devbox プロファイルの両方で再現。
