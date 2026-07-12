// ============================================================
// ナレッジ保存 バックエンド (Google Apps Script Webアプリ)
//
//   PWA(共有シート)から URL とカテゴリ名を POST で受け取り、
//   ページタイトルを自動取得して Google Drive の
//   「ナレッジ/<カテゴリ名>/」フォルダに Markdown で保存する。
//
//   デプロイ方法: GASエディタに貼り付け →「デプロイ」→「ウェブアプリ」
//     - 次のユーザーとして実行: 自分
//     - アクセスできるユーザー: 全員
//   ※「全員」で公開するため、スクリプトプロパティ SHARED_TOKEN に
//     合言葉を設定し、PWA側の設定画面にも同じ値を入れること。
// ============================================================

// ---- 定数 --------------------------------------------------

// Drive 上のルートフォルダ名（この直下にカテゴリ別フォルダを作る）
var ROOT_FOLDER_NAME = 'ナレッジ';

// 許可するカテゴリ一覧（PWA側のボタンと一致させる。Driveフォルダ名も同一）
var CATEGORIES = [
  '業務マニュアル',
  '自由掲示板',
  'PC系',
  'DTP系',
  'その他PC学習、スキル',
  'PCニュース',
  '語学系',
  '英語・中国語',
  'レシピ、お店',
  'TOCO/お知らせ'
];

// ファイル名に使うタイトルの最大文字数（長すぎると一覧で読みにくいため）
var FILENAME_TITLE_MAX = 60;

// タイムゾーン（保存日時・ファイル名の日付に使用）
var TIME_ZONE = 'Asia/Tokyo';

// ---- エントリポイント ---------------------------------------

/**
 * 動作確認用の GET エンドポイント。
 * ブラウザでWebアプリURLを開くと稼働確認メッセージを返す。
 */
function doGet(e) {
  return jsonResponse_({
    ok: true,
    message: 'ナレッジ保存APIは稼働中です。保存は POST で行います。'
  });
}

/**
 * PWA からの保存リクエストを受け取るエントリポイント。
 * 期待するボディ(JSON): { "url": "...", "category": "...", "memo": "...", "token": "..." }
 * memo と token は省略可（token はスクリプトプロパティ設定時のみ必須）。
 */
function doPost(e) {
  try {
    // ステップ1: リクエストの解析と検証
    var params = parseRequest_(e);

    // ステップ2: 合言葉の確認（SHARED_TOKEN が設定されている場合のみ）
    checkToken_(params.token);

    // ステップ3: ページタイトルの自動取得（失敗時は URL をそのまま使う）
    var title = fetchPageTitle_(params.url);

    // ステップ4: Drive のカテゴリフォルダへ Markdown ファイルとして保存
    var saved = saveToDrive_(params.category, params.url, title, params.memo);

    // ステップ5: 保存結果を返す
    return jsonResponse_({
      ok: true,
      title: title,
      fileName: saved.fileName,
      folderPath: ROOT_FOLDER_NAME + '/' + params.category
    });
  } catch (err) {
    // エラー内容を日本語メッセージで返す（PWA側で表示する）
    return jsonResponse_({
      ok: false,
      error: String((err && err.message) || err)
    });
  }
}

// ---- リクエスト処理 -----------------------------------------

/**
 * POST ボディを解析し、必須項目を検証して返す。
 * 不正な場合は日本語メッセージ付きの Error を投げる。
 */
function parseRequest_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('リクエストボディがありません');
  }

  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (parseErr) {
    throw new Error('リクエストボディのJSONが不正です');
  }

  var url = String(body.url || '').trim();
  var category = String(body.category || '').trim();
  var memo = String(body.memo || '').trim();
  var token = String(body.token || '');

  // URL の検証: http/https のみ許可（javascript: 等の混入を防ぐ）
  if (!url) {
    throw new Error('URLが指定されていません');
  }
  if (!/^https?:\/\/\S+$/i.test(url)) {
    throw new Error('URLの形式が不正です: ' + url);
  }

  // カテゴリの検証: 許可リストに完全一致するもののみ受け付ける
  // （フォルダ名として使うため、任意文字列を通すとパス汚染の恐れがある）
  if (!category) {
    throw new Error('カテゴリが指定されていません');
  }
  if (CATEGORIES.indexOf(category) === -1) {
    throw new Error('不明なカテゴリです: ' + category);
  }

  return { url: url, category: category, memo: memo, token: token };
}

/**
 * スクリプトプロパティ SHARED_TOKEN が設定されている場合、
 * リクエストの token と一致するか確認する。未設定なら素通し。
 */
function checkToken_(token) {
  var expected = '';
  try {
    expected = PropertiesService.getScriptProperties().getProperty('SHARED_TOKEN') || '';
  } catch (e) {
    expected = '';
  }
  if (expected && token !== expected) {
    throw new Error('合言葉が一致しません。PWAの設定画面を確認してください');
  }
}

// ---- タイトル取得 -------------------------------------------

/**
 * URL 先のページからタイトルを取得する。
 * <title> → og:title の順で探し、どちらも取れなければ URL を返す。
 * 通信エラー・タイムアウト等はすべて握りつぶして URL フォールバック。
 */
function fetchPageTitle_(url) {
  try {
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      // 一般的なブラウザに近い UA を名乗る（ボット扱いで拒否されるサイト対策）
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) KnowledgeShareBot/1.0' }
    });

    if (response.getResponseCode() >= 400) {
      return url;
    }

    // 文字コードの判定: Content-Type ヘッダ → meta タグ の順で charset を探す
    var html = response.getContentText(); // まず UTF-8 として読む
    var charset = detectCharset_(response.getHeaders(), html);
    if (charset && charset.toLowerCase() !== 'utf-8') {
      // UTF-8 以外なら正しい文字コードで読み直す（Shift_JIS のサイト等の文字化け対策）
      html = response.getContentText(charset);
    }

    var title = extractTitle_(html);
    return title || url;
  } catch (fetchErr) {
    // 取得失敗時は URL そのものをタイトル代わりに使う（仕様のフォールバック）
    return url;
  }
}

/**
 * Content-Type ヘッダまたは HTML の meta タグから charset を検出する。
 * 見つからなければ空文字を返す（= UTF-8 のまま扱う）。
 */
function detectCharset_(headers, html) {
  // ヘッダのキー名は環境により大文字小文字が揺れるため両方見る
  var contentType = String(headers['Content-Type'] || headers['content-type'] || '');
  var m = contentType.match(/charset=["']?([\w-]+)/i);
  if (m) {
    return m[1];
  }
  // <meta charset="..."> または <meta http-equiv="Content-Type" content="...; charset=...">
  m = html.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (m) {
    return m[1];
  }
  return '';
}

/**
 * HTML 文字列からページタイトルを抽出する純粋関数。
 * <title> タグを優先し、無ければ og:title を探す。
 * 見つからなければ空文字を返す。
 */
function extractTitle_(html) {
  if (!html) {
    return '';
  }

  // <title> タグ（属性付きの <title data-x="..."> にも対応）
  var m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  var title = m ? m[1] : '';

  // <title> が空なら og:title を探す（content 属性が前後どちらにあっても拾う）
  if (!title.replace(/\s/g, '')) {
    m = html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']*)["']/i) ||
        html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*property=["']og:title["']/i);
    title = m ? m[1] : '';
  }

  // HTML実体参照を戻し、改行・連続空白を1つのスペースにまとめる
  return decodeEntities_(title).replace(/\s+/g, ' ').trim();
}

/**
 * 代表的な HTML 実体参照（&amp; &lt; 等）と数値文字参照（&#x27; 等）を
 * 通常の文字に戻す純粋関数。
 */
function decodeEntities_(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, function (all, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    })
    .replace(/&#(\d+);/g, function (all, dec) {
      return String.fromCharCode(parseInt(dec, 10));
    })
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // &amp; は最後に戻す（二重デコード防止）
}

// ---- Drive 保存 ---------------------------------------------

/**
 * 「ナレッジ/<カテゴリ名>/」フォルダ（無ければ自動作成）に
 * 1記事1ファイルの Markdown として保存する。
 * 戻り値: { fileName: 実際に保存したファイル名, fileId: DriveのファイルID }
 */
function saveToDrive_(category, url, title, memo) {
  // ステップ1: ルートフォルダ「ナレッジ」を取得（無ければ作成）
  var rootFolder = getOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);

  // ステップ2: カテゴリフォルダを取得（無ければ作成）
  var categoryFolder = getOrCreateFolder_(rootFolder, category);

  // ステップ3: ファイル名を組み立てる（日付 + タイトル。重複時は時刻を付けて回避）
  var now = new Date();
  var dateStr = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  var fileName = buildFileName_(dateStr, title);
  if (categoryFolder.getFilesByName(fileName).hasNext()) {
    // 同名ファイルが既にある場合は時刻を付けて別ファイルにする（上書き防止）
    var timeStr = Utilities.formatDate(now, TIME_ZONE, 'HHmmss');
    fileName = buildFileName_(dateStr + '_' + timeStr, title);
  }

  // ステップ4: Markdown 本文を組み立てて保存
  var savedAt = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm');
  var content = buildMarkdown_(title, url, savedAt, category, memo);
  var file = categoryFolder.createFile(fileName, content, 'text/markdown');

  return { fileName: fileName, fileId: file.getId() };
}

/**
 * 親フォルダ直下から名前一致のフォルダを探し、無ければ作成して返す。
 */
function getOrCreateFolder_(parentFolder, name) {
  var folders = parentFolder.getFoldersByName(name);
  if (folders.hasNext()) {
    return folders.next();
  }
  return parentFolder.createFolder(name);
}

/**
 * 「YYYY-MM-DD_タイトル.md」形式のファイル名を組み立てる純粋関数。
 * Drive/OS で問題になりうる記号を除去し、長すぎるタイトルは切り詰める。
 */
function buildFileName_(datePart, title) {
  var safe = sanitizeFileName_(title);
  if (!safe) {
    safe = '無題';
  }
  if (safe.length > FILENAME_TITLE_MAX) {
    safe = safe.substring(0, FILENAME_TITLE_MAX) + '…';
  }
  return datePart + '_' + safe + '.md';
}

/**
 * ファイル名に使えない・紛らわしい文字を除去する純粋関数。
 * （Windows 禁止文字 + 制御文字 + 先頭末尾のドット/空白）
 */
function sanitizeFileName_(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|]/g, ' ')      // Windows で使えない記号をスペースへ
    .replace(/[\x00-\x1f\x7f]/g, '')     // 制御文字を除去
    .replace(/\s+/g, ' ')                // 連続空白を1つに
    .replace(/^[\s.]+|[\s.]+$/g, '');    // 先頭末尾の空白・ドットを除去
}

/**
 * 保存する Markdown 本文を組み立てる純粋関数。
 * タイトル・URL・保存日時・カテゴリ（+任意のメモ）を含める。
 */
function buildMarkdown_(title, url, savedAt, category, memo) {
  var lines = [
    '# ' + title,
    '',
    '- URL: ' + url,
    '- 保存日時: ' + savedAt,
    '- カテゴリ: ' + category
  ];
  if (memo) {
    lines.push('');
    lines.push('## メモ');
    lines.push('');
    lines.push(memo);
  }
  lines.push('');
  return lines.join('\n');
}

// ---- レスポンス ---------------------------------------------

/**
 * オブジェクトを JSON レスポンスとして返す共通関数。
 */
function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
