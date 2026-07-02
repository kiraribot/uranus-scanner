# uranus-scanner

在庫管理シート（スプレッドシートID: `1knSllsHeEML_zDU4DrEeVWsjSf38PWvmqszjrN_7BQw`）のH列（在庫数量）をバーコードスキャンで更新するWebアプリ。

## 機能

- **販売モード**: スキャンごとに在庫数量を指定数量分マイナス
- **補充モード**: スキャンごとに在庫数量を指定数量分プラス
- **手動入力モード**: カメラを使わずバーコードとその在庫数量を直接入力（絶対値で上書き）
- **オフライン検知**: `navigator.onLine` とネットワークエラーを監視し、オフライン時はスキャンをブラウザのlocalStorageにキューイング。オンライン復帰時に自動で一括送信
- **カメラスキャン**: [ZXing](https://github.com/zxing-js/library) (`@zxing/library`) をCDN経由で読み込み、EAN/UPC/CODE128等のバーコードを認識

## シートの前提構成

デフォルトでは以下の列構成を想定しています（`.env` で変更可能）:

| 列 | 内容 |
|---|---|
| A | バーコード |
| B | 商品名 |
| H | 在庫数量 |

シート（タブ）名はデフォルトで `在庫管理` を想定しています。実際のタブ名や列構成が異なる場合は `.env` の `SHEET_NAME` / `BARCODE_COLUMN` / `NAME_COLUMN` / `STOCK_COLUMN` を調整してください。

## セットアップ

### 1. 依存関係のインストール

```bash
npm install
```

### 2. Google Sheets APIの認証情報を用意する

このアプリはGoogleサービスアカウントでスプレッドシートに書き込みます。

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成（または既存のものを使用）
2. 「APIとサービス」→「ライブラリ」から **Google Sheets API** を有効化
3. 「APIとサービス」→「認証情報」→「認証情報を作成」→「サービスアカウント」でサービスアカウントを作成
4. 作成したサービスアカウントの「キー」タブから JSON形式の鍵を作成・ダウンロード
5. ダウンロードしたJSONファイルを `credentials.json` としてプロジェクトルートに配置（ローカル開発用、`.gitignore` 済みでコミットされません）
6. 対象のスプレッドシートを開き、「共有」からサービスアカウントのメールアドレス（`xxx@xxx.iam.gserviceaccount.com` の形式）を **編集者** 権限で共有

本番（Render）ではファイルの代わりに `GOOGLE_SERVICE_ACCOUNT_JSON` 環境変数にJSONの中身を1行文字列として設定します。

### 3. 環境変数

```bash
cp .env.example .env
```

必要に応じて `.env` を編集してください。

### 4. ローカル起動

```bash
npm start
```

`http://localhost:3000` にアクセス。カメラスキャンはブラウザのセキュアコンテキスト（`https://` または `localhost`）が必要です。

## GitHubへのpush

```bash
git remote add origin https://github.com/<GitHubアカウント>/uranus-scanner.git
git push -u origin main
```

## Renderへのデプロイ

1. [Render](https://dashboard.render.com/) でアカウントにログインし、「New +」→「Web Service」
2. 先ほどpushしたGitHubリポジトリを接続（`render.yaml` を検出してBuild/Start Commandは自動設定されます）
3. 環境変数タブで `GOOGLE_SERVICE_ACCOUNT_JSON` にサービスアカウントJSONの中身を1行で貼り付け
4. デプロイ完了後に発行されるURL（例: `https://uranus-scanner.onrender.com`）にアクセス

## APIエンドポイント

- `GET /api/health` — ヘルスチェック
- `POST /api/scan` — `{ barcode, mode: "sale"|"restock"|"manual", quantity }` を受け取りシートを更新
- `POST /api/scan/batch` — オフラインキューの一括同期用。`{ scans: [{ barcode, mode, quantity, clientId }] }`
