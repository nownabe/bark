# Design Doc: DocReview — GitHub PR 向け Markdown レビューツール

> ステータス: Draft / 作成日: 2026-06-06
> ※ プロダクト名「DocReview」は仮称。

## 1. 概要 (Overview)

GitHub Pull Request 上の Markdown ドキュメントを、Google Docs のような使用感でレビューできる Chrome 拡張機能。PR の変更箇所だけでなくドキュメント全体を対象に、任意の範囲をドラッグして選択し、コメント・Suggestion を付けられる。レビュワーの提案は GitHub の Suggestion として、author 自身の編集は明示的なコミットとして GitHub に反映される。

**バックエンドサーバーを持たず**、すべての永続化を「ローカル（下書き層）」と「GitHub API（共有の真実）」の二層で完結させる。

レビュワーも author も同じツールを通してレビューを見る前提とする。GitHub はあくまで保存・同期先であり、コメントの位置・スレッド・履歴といった体験はツール側が完全に再構築する。レビューと修正は何度か往復することを想定し、「どのレビューに対しどう直したか」を追え、前回からの変更点を視覚的に示すことを重視する。

## 2. 背景と動機 (Motivation)

GitHub の "Files changed" は diff（行ベース・差分中心）の確認には優れるが、散文の Markdown を「読みもの」としてレビューするには弱い:

- 変更行しか見えず、ドキュメント全体の流れの中で文章を評価しにくい
- 行単位のコメントしか付けられず、「この一文のこの語」のような細かい指摘がしづらい
- レンダリング後の見た目でレビューできない

Google Docs の「選択してコメント」「提案モード」のような体験を、GitHub のレビューワークフローを壊さずに持ち込むことが狙い。

## 3. ゴール / 非ゴール (Goals / Non-Goals)

### ゴール

- PR に含まれる変更済み `.md` ファイルを、レンダリング済みの形で全文レビューできる
- 任意のテキスト範囲をドラッグ選択してコメントを付けられる（行ではなく範囲指定）
- レビュワーが Suggestion（置換提案）を作成でき、GitHub の Suggestion として反映される
- author が Web UI 上でドキュメントを編集し、明示操作で PR ブランチにコミットできる
- コメント・Suggestion はローカルで下書きし、まとめて GitHub に反映できる（GitHub の "Start a review → Submit" 相当）
- レビュー↔修正の反復履歴（どのレビューにどのコミットで対応したか）をツール上で追える
- 前回レビュー時点（または任意のコミット）からの変更点を、本文上で視覚的に表示できる
- サーバーレス（拡張機能と GitHub API だけで完結）

### 非ゴール

- リアルタイム共同編集（CRDT / WebSocket 等）。今回は非同期で十分
- GitHub Enterprise / GHES 対応（v1 では github.com のみ）
- Markdown 以外のファイル形式のレビュー
- GitHub 外（GitLab 等）のサポート

## 4. ペルソナと主要フロー

### 4.1 レビュワー

1. PR ページの "Files changed" 付近に挿入された「Open in DocReview」ボタンを押す
2. 拡張機能の SPA が開き、変更された `.md` がレンダリング表示される
3. 気になる箇所をドラッグ選択 → サイドにコメント or Suggestion を入力
4. 指摘はローカルに「pending（下書き）」として溜まる
5. 「Submit review」で、まとめて 1 件の PR レビューとして GitHub に反映

### 4.2 Author

1. 同じ DocReview ビューを開く
2. レビュワーの Suggestion を確認し、編集モードで本文を直接編集
3. 「Commit」を押した時点で、変更が PR の head ブランチにコミットされる
4. Suggestion を受け入れる操作も、最終的には author のコミットとして反映

## 5. 要件 (Requirements)

| ID  | 要件                                                                  | 優先度 |
| --- | --------------------------------------------------------------------- | ------ |
| R1  | 変更済み `.md` をレンダリング表示し全文レビュー可能                   | Must   |
| R2  | 任意範囲選択へのコメント                                              | Must   |
| R3  | Suggestion（範囲置換提案）の作成 → GitHub Suggestion 化               | Must   |
| R4  | コメント/Suggestion のローカル下書き → GitHub 一括反映                | Must   |
| R5  | author による本文編集 → 明示コミット                                  | Must   |
| R6  | 既存の GitHub レビューコメントの取り込み・表示                        | Should |
| R7  | コミット更新時のコメント再アンカリング                                | Should |
| R8  | 複数 `.md` ファイル間の横断ナビゲーション                             | Could  |
| R9  | レビュー↔修正の反復履歴の追跡（レビュー・コミット・対応状況の時系列） | Must   |
| R10 | 前回（基準コミット）からの変更点を本文上で視覚表示                    | Must   |

## 6. アーキテクチャ (Architecture)

```
┌─────────────────────── Chrome Extension (MV3) ───────────────────────┐
│                                                                       │
│  Content Script (github.com/*/pull/*)                                 │
│    └─ PR ページに「Open in DocReview」エントリポイントを注入          │
│                                                                       │
│  Extension SPA Page (chrome-extension://.../review.html)              │
│    ├─ Document Renderer  (remark/mdast → レンダリング + 位置マップ)    │
│    ├─ Comment / Suggestion Layer (選択 → アンカー解決)                 │
│    ├─ Editor (author 編集モード)                                      │
│    └─ Review Tray (pending 下書きの一覧 / Submit)                      │
│                                                                       │
│  Background Service Worker                                            │
│    ├─ Auth (トークン管理)                                             │
│    ├─ GitHub API Client (fetch / retry / ETag キャッシュ)             │
│    └─ Local Store I/O (chrome.storage / IndexedDB)                    │
│                                                                       │
└──────────────────────────────┬────────────────────────────────────────┘
                               │ HTTPS (CORS)
                               ▼
                        api.github.com
              (PR / contents / reviews / comments)
```

- **ローカル層 = 下書きと精密アンカーのメタデータ**: pending のコメント・Suggestion、文字単位の選択範囲情報、設定、トークンを保持
- **GitHub = 共有の真実**: 確定したレビューコメント・Suggestion・コミット

非同期前提なので、共有状態の「最新」は常に GitHub から取得し直す。複数人の同時編集衝突解決の仕組みは持たない。

## 7. 詳細設計 (Detailed Design)

### 7.1 アンカリング — 本設計の核

**課題**: 「レンダリング済み Markdown 上の任意の文字範囲」と「GitHub の行ベース・かつ diff ハンク内に限られるコメント」をどう橋渡しするか。

**方針**: ソース Markdown を正準（canonical）とし、レンダリング時に**ソース位置マップ**を保持する。

1. `remark` で Markdown を mdast にパース。各ノードは `position`（start/end の line・column・offset）を持つ
2. レンダリング時、DOM ノードに対応するソース offset を `data-*` 属性等で紐付ける
3. ユーザーの選択（DOM Range）を、ソース上の `{ path, startOffset, endOffset, startLine, endLine, quotedText }` に解決する

GitHub へ反映する際のマッピング:

- **選択範囲がある行が PR の diff ハンク内にある場合** → ネイティブのレビューコメント（単一行 / `start_line`〜`line` の複数行）として送信。`side`（LEFT/RIGHT）も解決
- **diff の外（無変更行など）にある場合** → 該当スニペットを引用したパーミャリンク付き（`.../blob/{sha}/{path}#Lx-Ly`）の**通常 PR コメント**として投稿する（既定挙動）
- **文字単位の精度**: GitHub は行粒度までしか保持できないため、GitHub 上の表示は行に丸まる。ただし精密範囲はツールが復元する（下記）

**ツールによる完全再現（重要）**: レビュワーも author も同じツールでレビューを見るため、GitHub の表示の制約に縛られない。投稿する各コメント本文の末尾に、ツールが読み取る構造化メタデータを不可視マーカー（HTML コメント）として埋め込む:

```text
<!-- docreview:v1 {"cid":"...","path":"docs/spec.md","range":{"sl":12,"sc":4,"el":12,"ec":20},"quote":"...","sha":"abc123","thread":"t1"} -->
```

これにより、

- diff 内/外を問わず、ツールは**文字単位の精密アンカー**でハイライトを復元できる
- スレッド（thread id）でコメントの会話をまとめ、Google Docs 風のスレッド表示を再現できる
- GitHub 上では普通のコメント/レビューコメントとして読め、ツール未導入のユーザーにも壊れない（マーカーは HTML コメントなので非表示）

GitHub は「保存・同期のトランスポート」、ツールは「体験の再構築層」という役割分担になる。

### 7.2 コメント

- 選択 → サイドパネルに入力 → ローカルに `pending` として保存
- データ構造（ローカル / メタデータと共通）:
  ```jsonc
  {
    "id": "local-uuid",
    "path": "docs/spec.md",
    "anchor": {
      "startLine": 12,
      "endLine": 12,
      "startCol": 4,
      "endCol": 20,
      "quotedText": "...",
      "createdAtSha": "abc123",
    },
    "body": "ここは曖昧では?",
    "kind": "comment", // comment | suggestion
    "threadId": "t1", // 会話のまとまり
    "status": "open", // pending | open | addressed | resolved | outdated
    "addressedBySha": null, // 後続コミットで対応されたら記録
  }
  ```
- `createdAtSha` で「どの時点のドキュメントに対する指摘か」を固定し、履歴追跡（7.9）の基礎にする
- Submit 時、`POST /repos/{owner}/{repo}/pulls/{n}/reviews` の `comments[]` にまとめて載せ、1 つのレビューとして送信（イベントは COMMENT を既定）

### 7.3 Suggestion

- レビュワーが範囲を選択し、置換後のソーステキストを入力
- 対象のソース行範囲を解決し、GitHub のレビューコメント本文に Suggestion ブロックを生成:
  ````text
  ```suggestion
  <置換後のソース行>
  ```
  ````
- 複数行は `start_line`/`line` の範囲指定で送信。GitHub UI 側に「Apply suggestion」ボタンが出る
- diff 外への Suggestion は GitHub のクリック可能な Suggestion にはできないため、提案テキストを fenced block で含む通常コメントに降格し、その旨を表示

### 7.4 Author の編集とコミット

- author は編集モードで本文を編集。**ソースを正準とし、編集は触れた範囲に限定**して diff ノイズを最小化する（全文の再シリアライズによる無関係な差分を避ける）
- 「Commit」押下時:
  - 単一ファイル: `PUT /repos/{owner}/{repo}/contents/{path}`（既存 `sha` + `branch` 指定）
  - 複数ファイルを 1 コミットにまとめる場合: Git Data API（blob → tree → commit → ref 更新）
- Suggestion の受け入れも、最終的には author のこの編集→コミット経路に集約する（レビュワーが直接ブランチを書き換えない）

### 7.5 レンダリング / エディタ技術選定

Google Docs風の「読みやすいレンダリング＋余白コメント＋提案」を、PR の diff をきれいに保ったまま実現するため:

- **レビュー面（読む・コメントする）**: `remark`/`rehype` でレンダリングしたビュー + 位置マップ。コメント範囲はデコレーション（ハイライト）で表現
- **編集面（author）**: ソース正準の編集体験を優先し、CodeMirror 6（ソース + ライブプレビュー）を第一候補とする
- フル WYSIWYG（ProseMirror/TipTap）は Docs 体験に最も近いが、Markdown 往復のシリアライズで差分ノイズが出やすく、PR 用途とは相性が悪い。将来拡張として「触れた範囲だけ書き戻す」制約付きで検討

> Docs らしさの本質は「選択してコメント」「提案モードと採否」「整形済みの読み心地」であり、これらはレンダリング面 + 範囲アンカーで十分再現できる。フル WYSIWYG は必須ではない。

### 7.6 認証 (Auth) — サーバーレス制約下

- **v1**: fine-grained PAT をユーザーが発行し、拡張に登録（`contents: read/write`, `pull requests: read/write` を対象リポジトリに付与）。`chrome.storage.local` に保存
- **v2（UX 改善 / #6 実装）**: **GitHub App** の **Device Flow** を採用。`client_id` のみで完結し client secret 不要
  - App 設定で「Expire user authorization tokens」を無効化すると、リフレッシュ不要の**非有効期限 user-to-server トークン**が得られる（Device Flow のトークン交換自体も secret 不要）。これにより当初 OAuth App を選んだ理由（GitHub App は refresh に secret が要る）が解消されるため D10 を更新
  - GitHub App ならインストール時に**ユーザーがリポジトリを選択**でき、`Contents` / `Pull requests`（read/write）の細かい権限だけを付与できる（OAuth App の粗い `repo` スコープより最小権限）
  - `client_id` はビルド時の env 変数 `BARK_GITHUB_CLIENT_ID`（公開値・secret ではない）から注入する。`.envrc.local`（direnv）で設定し、`BARK_` prefix のみバンドルに露出させることで `GH_PAT` 等の secret が混入しないようにする
  - 認可（Device Flow）と**インストール（リポジトリ選択）は別ステップ**。認可だけ済んでも App が対象リポジトリに未インストールだと初回ロードが 404 になる。そこで初回ロードが 404/403 のときは、レビュー UI にエラー通知を出すのではなく**認証ゲートと同様の専用画面に切り替え**、App のインストール導線（`https://github.com/apps/<slug>/installations/new`）と Retry を提示する。slug は公開値の env 変数 `BARK_GITHUB_APP_SLUG` から注入する
- api.github.com は CORS を返すため、トークンを `Authorization` ヘッダに載せてブラウザから直接呼べる。一方 github.com の device エンドポイント（`/login/device/code`, `/login/oauth/access_token`）は CORS を返さないため、その fetch は host_permissions で CORS を回避できる background service worker で実行する

### 7.7 ローカルストレージ設計

- `chrome.storage.local`: トークン、設定、軽量メタデータ
- IndexedDB: PR ごとの pending コメント/Suggestion、ドキュメントスナップショット、位置マップキャッシュ
- キー設計: `pr:{owner}/{repo}#{number}` 配下に下書き群をぶら下げる

### 7.8 再アンカリング (R7)

- head が新しいコミットで進んだ場合、保存済みアンカーを `quotedText` ベースのファジーマッチ（近傍 diff）で再解決
- 見つからない場合は `outdated` とマークし、UI 上で「元の位置が変更されました」と提示

### 7.9 レビュー履歴・ラウンドの追跡 (R9)

レビューと修正は何度か往復する。これを「ラウンド」という単位で時系列に追えるようにする。サーバーを持たないので、履歴は **GitHub 上のデータ + 埋め込みメタデータから再構成**する。

**ラウンドの定義と取得元**:

- PR レビューは GitHub 上で `commit_id`（どの時点のコミットに対するレビューか）と `submitted_at` を持つ（`GET /pulls/{n}/reviews`）。これをラウンドの基準点として使う
- コミット列は `GET /pulls/{n}/commits`、差分は `GET /compare/{base}...{head}` で取得
- これらとコメントメタデータの `createdAtSha` / `threadId` を突き合わせ、タイムラインを構築する

**対応状況（status）の自動判定**:

- あるコメントのアンカー領域が、その `createdAtSha` より後のコミットで変更されていれば `addressed`（`addressedBySha` を記録）
- スレッドが GitHub 上で resolve されていれば `resolved`（GraphQL の review thread 解決状態 / または解決を表すメタデータ）
- 領域が消えて再アンカリングに失敗したら `outdated`

**履歴ビュー（UI）**:

```
Round 1  @ abc123  (reviewer: 5 comments / 2 suggestions)
  ├─ "ここは曖昧では?"        → addressed in def456
  ├─ "用語がぶれている"        → resolved
  └─ ...
Commit def456 (author) — 3 files changed
Round 2  @ def456  (reviewer: 1 comment)
  └─ ...
```

- コメントから「この指摘がどのコミットで直されたか」へ 1 タップで飛べる
- 各ラウンドは基準コミットを持つため、「Round 1 時点」と「現在」を 7.10 の変更表示の基準として選べる

### 7.10 前回からの変更点の視覚化 (R10)

「前回レビュー時点（基準コミット）から現在までに本文がどう変わったか」を、レンダリング本文上に赤入れ（redline）として重ねて表示する。

- **基準（baseline）の選択**: 既定は「自分が最後に見た／レビューした時点の SHA」。ほかに「特定ラウンドの基準コミット」「PR の base」も選べる。各ユーザーの最終閲覧 SHA はローカルに保持
- **初回閲覧時**: 基準となる過去 SHA がまだ無いため、変更表示は行わない（素のレンダリング）。関心はあくまで「レビューを経てどう変化したか」であり、PR base との差分は既定では出さない。閲覧を記録した次回以降、前回 SHA を基準に redline を表示する
- **差分の算出**: 基準 SHA と現在 head の両方のソースを取得し、**クライアント側で文字/語レベル diff**（例: diff-match-patch 等）を取る。行レベルの GitHub diff より細かい粒度で、文章の語句変更を捉える
- **表示**: レンダリング本文に対し、追加は下線＋強調、削除は取り消し線、変更は置換ハイライトでデコレーション表示（Google Docs の変更履歴の見た目に寄せる）。位置マップ（7.1）経由でソース diff を DOM 上に投影する
- **トグル**: 「変更を表示／非表示」「変更箇所だけにジャンプ」を用意
- コメントのアンカー領域がこの差分に重なる場合、7.9 の `addressed` 判定と連動してハイライトする

## 8. 同期モデル

```
[ローカル下書き] --Submit--> [GitHub レビュー/コメント/Suggestion]
[ローカル編集]   --Commit--> [GitHub head ブランチ]
[GitHub]         --Fetch -->  [表示の最新化]
```

- 非同期前提。開くたびに GitHub から最新を取得して表示
- 競合は「最後の取得が正」。同時編集のマージは行わず、コミット時に `sha` 不一致を検出したら再取得を促す
- 履歴（ラウンド）は永続化せず、取得時に GitHub のレビュー（`commit_id`/`submitted_at`）・コミット列・埋め込みメタデータから毎回再構成する（サーバー不要）

## 9. セキュリティ / プライバシー

- トークンは拡張ローカルに保存。XSS 等での漏洩リスクがあるため、保存範囲・権限を最小化し、削除導線を用意
- fine-grained PAT は対象リポジトリ・権限を限定して発行するようガイド
- ドキュメント本文・下書きは外部サーバーに送らない（ノーサーバーの利点）
- 入力された Markdown のレンダリングは sanitize（`rehype-sanitize` 等）して XSS を防ぐ

## 10. Manifest V3 / 権限

- `host_permissions`: `https://github.com/*`, `https://api.github.com/*`
- `permissions`: `storage`, `scripting`（content script 注入）
- Background は service worker。長時間処理は分割し、終了に備えて状態を IndexedDB に永続化
- レート制限: 認証時 5,000 req/h。ETag による条件付きリクエストでキャッシュし、バッチ送信で節約

## 11. マイルストーン

- **M0 (PoC)**: PR の単一 `.md` をレンダリング表示 + 行内コメントを 1 件ずつ GitHub に投稿
- **M1**: 任意範囲選択 + ローカル下書き + Submit 一括反映（R1, R2, R4）
- **M2**: Suggestion（R3）、既存コメント取り込み（R6）
- **M3**: author 編集 + コミット（R5）、再アンカリング（R7）
- **M4**: 前回からの変更の視覚化（R10）、レビュー↔修正の履歴ビュー（R9）
- **M5**: Device Flow 認証、複数ファイル横断（R8）

## 12. リスクと未解決点 (Risks / Open Questions)

1. ~~diff 外コメントのフォールバック既定値~~ → **確定: 通常 PR コメント（引用＋パーミャリンク）+ 埋め込みメタデータで完全再現**
2. **トークン保管のセキュリティ**: 拡張ローカル保存の許容度。セッション限定保存や WebAuthn ゲートの要否
3. **再アンカリングの堅牢性**: force-push / rebase 後にどこまで追従できるか
4. **編集モードの diff ノイズ**: 「触れた範囲だけ書き戻す」をどの粒度で実装するか
5. **複数レビュワーの非同期衝突**: 取得時点差による表示ズレの UX
6. **大きいドキュメント / 大量コメント時の描画性能**
7. ~~変更視覚化の基準の既定~~ → **確定: 既定は「自分の最終閲覧 SHA」、初回は基準なしのため変更表示なし。PR base との差分は既定で出さない**
8. **メタデータ改ざん/欠損耐性**: 埋め込みメタデータが手で編集・削除された場合のフォールバック（行アンカーへの degrade）

## 13. 検討した代替案 (Alternatives Considered)

- **GitHub の Files changed DOM に直接オーバーレイ**: 既存 UI に寄り添えるが、diff DOM 上で Docs風の全文レビュー・任意範囲選択を実現するのは脆く、レイアウト変更に弱い。専用 SPA を採用
- **コメントを全てローカルのみに保持**: 共有不可で R6/チーム利用と相反。「両対応」を採用
- **フル WYSIWYG（ProseMirror）を正準にする**: Docs 体験に最も近いが Markdown 往復で差分が荒れ、PR レビュー用途を損なう。ソース正準 + レンダリング面を採用
