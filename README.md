# 洋書リーダー（Project Gutenberg）

Project Gutenberg の名作を原文で読み、AIで日本語訳・語句の意味・あらすじ・作品解説を調べられる、iPhoneのホーム画面で使うWebアプリです。

- 約7万作品の目録から、題名・作家名・ジャンルで探せる
- 段落をタップすると日本語訳が原文の下に出る／章ごとにまとめて訳す（訳は端末に保存）
- 文を選ぶと「意味」（発音・品詞・文脈での意味・構文）、「訳す」、「保存」
- 目次、あらすじ（読んだところまで／全体）、作品解説、論文（OpenAlex・J-STAGE）と論点整理
- 本棚・★評価・保存したことばをもとにAIがおすすめ（英語の難しさつき）
- AIは自分のAPIキー（Google / Anthropic / OpenAI）

## 公開する（青空リーダーと同じ手順）

1. GitHubで新しいリポジトリ `gutenberg-reader` を **Public** で作る（READMEはOff）。
2. 「uploading an existing file」から、このフォルダの中身をドラッグして「Commit changes」。
   `index.html` `app.js` `sw.js` `manifest.webmanifest` `README.md` と `icons` フォルダ、`cloudflare` フォルダ。
3. 「Add file」→「Create new file」。ファイル名に `.github/workflows/catalog.yml` と入力し、
   `catalog.yml` の中身を貼り付けて「Commit changes」。
4. 「Actions」タブで「目録を更新」に緑のチェックが付くまで待つ（2〜3分）。`catalog.json` が増えれば成功。
5. 「Settings」→「Pages」で Branch を `main`、`/ (root)` にして「Save」。
   `https://（ユーザー名）.github.io/gutenberg-reader/` がアプリのURLです。

## 本文の取得先を作る（Cloudflare・無料・一度だけ）

Project Gutenberg は、ほかのWebページから本文を直接読み込むことを許可していません。
そこで、作品番号を受け取って本文を返すだけの小さな中継プログラムを Cloudflare に置きます。

1. https://dash.cloudflare.com/sign-up で無料アカウントを作ります（クレジットカードは不要）。
2. 左のメニューの「Workers & Pages」（または「Compute (Workers)」）→「Create」→「Hello World」のひな形を選びます。
3. 名前を `gutenberg-proxy` にして「Deploy」。
4. 「Edit code」を開き、中身をすべて消して `cloudflare/worker.js` の中身を貼り付け、右上の「Deploy」。
5. 表示されたURL（`https://gutenberg-proxy.〇〇.workers.dev`）をコピーします。
6. アプリの「設定」→「本文の取得先」に貼り付けて「保存して確認」。
   「使えます（『高慢と偏見』を取得できました）」と出れば完了です。

この中継は作品番号（数字）しか受け付けないので、ほかのサイトの中継には使えません。
無料枠は1日10万回で、個人の読書なら十分です。読んだ本文は端末に保存されるので、同じ本で何度も通信しません。

## iPhoneに入れる

Safariでアプリを開き、共有ボタン →「ホーム画面に追加」。

## AI

「設定」でサービスを選び、APIキーを貼り付けて「保存して接続テスト」。Googleならモデル名は空欄のままで大丈夫です。
翻訳の文体は「自然な文芸訳」と「原文に忠実（学習向け）」から選べます。

## データの出どころ

- 目録：Project Gutenberg の pg_catalog.csv と人気ランキング（GitHub Actions が毎週 catalog.json に変換）
- 本文：Project Gutenberg（Cloudflare Worker 経由）
- 論文：OpenAlex、J-STAGE
- 作品解説の下地：Wikipedia英語版

Project Gutenberg の作品は米国でパブリックドメインです。お住まいの国の著作権法もご確認ください。
