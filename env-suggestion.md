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
- **原因(推定)**: サンドボックス設定はセッション開始時の `.cache/bun` の中身を基に個別ファイルを
  bind-mount しようとするが、`bun add`/`bun install` がキャッシュ構成を作り替えるとパスが食い違い、
  以降の全コマンドで bwrap 初期化に失敗する。
- **回避(今回)**: 当該 git コマンドを `dangerouslyDisableSandbox` で実行。
- **提案**: (a) bun でキャッシュ更新(`bun add`/`install`)を行ったら**セッションを再起動**して
  サンドボックス設定を現在のキャッシュに再導出する運用にする。または (b) サンドボックスが
  `.cache/`(と `node_modules/`)配下を個別ファイル列挙せず丸ごと扱うよう設定できるか検討する。
