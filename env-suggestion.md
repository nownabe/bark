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
