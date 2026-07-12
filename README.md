# knowledge-share-app（ナレッジ保存）

気になった記事を、Androidの共有シートから **3タップ** でGoogle Driveにカテゴリ別ストックする個人用ツールです。
LINE WORKS掲示板で行っていた「URL+一言コメントのカテゴリ別ストック」運用の移行先で、保存先がDriveなのでAI(Claude)からも直接参照できます。

**操作の流れ（実機）**
1. ブラウザの共有ボタン（⤴）をタップ
2. 共有先から「ナレッジ」を選択
3. カテゴリボタンをタップ → 自動保存 → 画面を閉じる

保存されるもの: `マイドライブ/ナレッジ/<カテゴリ名>/YYYY-MM-DD_記事タイトル.md`（タイトル・URL・保存日時・カテゴリ、共有時のコメントがあればメモとして記録）

## 構成

| レイヤー | 実体 | 役割 |
|---------|------|------|
| フロントエンド | `index.html` + `manifest.json` + `sw.js`（PWA） | Web Share Target APIで共有シートに登録。カテゴリ選択UI |
| バックエンド | `gas/Code.gs`（GAS Webアプリ） | タイトル自動取得（失敗時はURLで代替）とDrive保存 |
| ホスティング | Vercel（静的配信） | PWAはHTTPS配信が必須のため |

```
knowledge-share-app/
├── index.html            # PWA本体（1枚のHTML）
├── manifest.json         # share_target 定義を含むPWAマニフェスト
├── sw.js                 # サービスワーカー（インストール要件用の最小実装）
├── icons/                # アプリアイコン（scripts/generate_icons.js で生成）
├── gas/Code.gs           # GASバックエンド（GASエディタに貼り付けて使う）
├── scripts/
│   ├── generate_icons.js # アイコン生成（Node組み込みのみ）
│   └── dev_server.js     # ローカル動作確認用サーバ
└── test/                 # 自動テスト（node --test）
```

## セットアップ手順

### Step 1: GAS（バックエンド）のデプロイ

1. [script.google.com](https://script.google.com) で「新しいプロジェクト」を作成（名前例: ナレッジ保存API）
2. エディタに `gas/Code.gs` の内容を貼り付けて保存
3. 合言葉を設定する（推奨。URLを知られても第三者に書き込まれないための簡易保護）
   - 左メニュー「プロジェクトの設定」→「スクリプト プロパティ」→「プロパティを追加」
   - プロパティ: `SHARED_TOKEN` ／ 値: 好きな合言葉（例: ランダムな英数字）
4. 右上「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**（合言葉で保護する前提。Googleアカウント制限にするとPWAからのfetchが通らないため）
5. 「デプロイ」を押し、権限承認ダイアログで承認（Drive書き込み・外部URL取得の2スコープ）
6. 表示された **WebアプリURL**（`https://script.google.com/macros/s/…/exec`）を控える

動作確認: WebアプリURLをブラウザで開き `{"ok":true,...}` が表示されればOK。

> コードを修正したら「デプロイ」→「デプロイを管理」→ 鉛筆アイコン → バージョン「新バージョン」で更新する（URLは変わらない）。

### Step 2: PWA（フロントエンド）のVercelデプロイ

1. [vercel.com](https://vercel.com) にGitHubアカウントでログイン
2. 「Add New…」→「Project」→ このリポジトリ（`knowledge-share-app`）をImport
3. Framework Preset は「Other」のまま、設定変更なしで「Deploy」（ビルド不要の静的サイト）
4. 発行されたURL（`https://….vercel.app`）を控える

> リポジトリが非公開でもVercelのデプロイは可能です。以後は `main` にプッシュするたび自動デプロイされます。

### Step 3: 実機（Pixel 9a）でのインストールと共有シート登録

1. Chromeで Step 2 のURLを開く
2. 初回起動時に設定画面が出るので入力して「保存する」
   - GAS WebアプリのURL: Step 1-6 のURL
   - 合言葉: Step 1-3 で設定した値
3. Chromeのメニュー（⋮）→「**ホーム画面に追加**」→「**インストール**」を選択
   - ※「ショートカットを追加」ではなく「インストール」であること。インストール型で入れると共有シートに登録される
4. インストール後、適当な記事ページで共有ボタン（⤴）→ 共有先一覧に「**ナレッジ**」が出ることを確認
   - 出ない場合: 一覧を左にスクロール／「その他」を開く。それでも無ければ一度アプリを開いてから再確認

### 実機での投稿テスト

1. Chromeで任意の記事を開く → 共有（⤴）→「ナレッジ」
2. カテゴリボタン（例: PC系）をタップ
3. 「保存しました！」表示を確認
4. Google Driveの `ナレッジ/PC系/` に `YYYY-MM-DD_記事タイトル.md` ができていることを確認

## カテゴリ一覧

LINE WORKS掲示板の構成をそのまま踏襲（カテゴリ名 = Driveフォルダ名）:

業務マニュアル ／ 自由掲示板 ／ PC系 ／ DTP系 ／ その他PC学習、スキル ／ PCニュース ／ 語学系 ／ 英語・中国語 ／ レシピ、お店 ／ TOCO/お知らせ

カテゴリを変更する場合は `index.html` と `gas/Code.gs` の **両方** の `CATEGORIES` を揃えて変更する（ズレると自動テストが落ちます）。変更後はGASの再デプロイ（新バージョン）とVercelへのプッシュが必要。

## 開発

```powershell
npm test        # 自動テスト（GASロジック・クライアントロジック計30件）
npm run dev     # ローカルサーバ起動（http://localhost:8765/）
npm run icons   # アイコンPNGの再生成
```

共有シート起動の模擬（ローカル）: `http://localhost:8765/?shared_text=記事タイトル%20https://example.com/article`

※ Web Share Target（共有シート登録）自体はHTTPS+インストール済みPWAが要件のため、ローカルでは確認できません。実機はVercel配信のURLで確認します。

## 設計メモ

- **認証**: GASは「全員」公開 + スクリプトプロパティ `SHARED_TOKEN` の合言葉照合による簡易保護。個人利用前提の最小構成（本格的な認証基盤は意図的に持たない）
- **CORS**: PWA→GASのPOSTは `Content-Type: text/plain` で送ることでプリフライト(OPTIONS)を回避（GASはOPTIONSに応答できない）
- **URLの受け取り**: Androidの共有シートはアプリによってURLを `url`/`text`/`title` のどこに入れるかが揺れるため、`shared_url` → `shared_text` → `shared_title` の順で探索。`shared_text` のURL以外の部分は一言コメントとしてメモ欄に保存
- **タイトル取得のフォールバック**: 通信失敗・HTTP 4xx/5xx・`<title>` 不在時は og:title → URLそのもの、の順で代替
- **ファイル名**: `YYYY-MM-DD_タイトル.md`。Windows禁止文字を除去、60文字で切り詰め、同名衝突時は時刻を付与して上書き回避
