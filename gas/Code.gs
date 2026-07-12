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

// カテゴリ一覧を保存するスクリプトプロパティのキー
// （PWAから追加・削除できるようにするため、固定配列ではなくプロパティで管理する）
var CATEGORIES_PROPERTY = 'CATEGORIES_JSON';

// 初回アクセス時にスクリプトプロパティへ書き込む初期カテゴリ一覧
// （LINE WORKS掲示板の構成を踏襲。Driveフォルダ名もカテゴリ名と同一にする）
var DEFAULT_CATEGORIES = [
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

// 検索用インデックス（Googleスプレッドシート）関連の定数
var INDEX_SHEET_ID_PROPERTY = 'INDEX_SHEET_ID'; // スクリプトプロパティに保存するID
var INDEX_SHEET_NAME = 'ナレッジ一覧';
var INDEX_HEADER = ['日時', 'カテゴリ', 'タイトル', 'URL', 'メモ'];
var INDEX_COL = { SAVED_AT: 1, CATEGORY: 2, TITLE: 3, URL: 4, MEMO: 5 };

// 一覧APIで一度に返す最大件数（際限なく巨大なレスポンスになるのを防ぐ簡易上限）
var LIST_MAX_ITEMS = 500;

// ---- エントリポイント ---------------------------------------

/**
 * GET エンドポイント。
 * - パラメータ無し: 動作確認用メッセージを返す
 * - ?action=list&category=xxx : そのカテゴリの保存済み記事一覧を返す
 * - ?action=categories : カテゴリ一覧とDriveの「ナレッジ」フォルダURLを返す
 */
function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'list') {
    return handleList_(e.parameter.category);
  }
  if (action === 'categories') {
    return handleCategories_();
  }
  return jsonResponse_({
    ok: true,
    message: 'ナレッジ保存APIは稼働中です。保存は POST で行います。'
  });
}

/**
 * カテゴリ一覧と、Driveの「ナレッジ」フォルダを直接開くためのURLを返す。
 * PWAの起動時・設定画面・一覧画面でカテゴリボタンを動的に描画するために使う。
 */
function handleCategories_() {
  try {
    var rootFolder = getOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
    return jsonResponse_({
      ok: true,
      categories: getCategories_(),
      rootFolderUrl: rootFolder.getUrl()
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * 指定カテゴリの保存済み記事一覧を、検索用インデックス（Sheets）から新しい順に返す。
 */
function handleList_(category) {
  try {
    if (!category || getCategories_().indexOf(category) === -1) {
      throw new Error('不明なカテゴリです: ' + category);
    }

    var rootFolder = getOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
    var sheet = getOrCreateIndexSheet_(rootFolder);
    var values = sheet.getDataRange().getValues(); // values[0] はヘッダ行

    var items = [];
    // 新しい順（末尾の行から）に走査し、上限件数に達したら打ち切る
    for (var i = values.length - 1; i >= 1 && items.length < LIST_MAX_ITEMS; i--) {
      var row = values[i];
      if (row[INDEX_COL.CATEGORY - 1] === category) {
        items.push({
          savedAt: row[INDEX_COL.SAVED_AT - 1],
          title: row[INDEX_COL.TITLE - 1],
          url: row[INDEX_COL.URL - 1],
          memo: row[INDEX_COL.MEMO - 1] || ''
        });
      }
    }

    return jsonResponse_({ ok: true, category: category, items: items });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * PWA からのPOSTリクエストを受け取るエントリポイント。
 * body.action で処理を振り分ける（省略時は 'save' = 記事の保存）。
 *   - save          : { url, category, memo? } を保存
 *   - addCategory   : { name } をカテゴリ一覧に追加
 *   - removeCategory: { name } をカテゴリ一覧から削除（保存済みデータは残す）
 * すべての action 共通で token（合言葉）を検証する。
 */
function doPost(e) {
  try {
    var body = parseJsonBody_(e);
    checkToken_(String(body.token || ''));

    var action = String(body.action || 'save');
    switch (action) {
      case 'save':
        return jsonResponse_(handleSave_(body));
      case 'addCategory':
        return jsonResponse_(handleAddCategory_(body));
      case 'removeCategory':
        return jsonResponse_(handleRemoveCategory_(body));
      default:
        throw new Error('不明なactionです: ' + action);
    }
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
 * POST ボディのJSONを解析する。不正な場合は日本語メッセージ付きの Error を投げる。
 */
function parseJsonBody_(e) {
  if (!e || !e.postData || !e.postData.contents) {
    throw new Error('リクエストボディがありません');
  }
  try {
    return JSON.parse(e.postData.contents);
  } catch (parseErr) {
    throw new Error('リクエストボディのJSONが不正です');
  }
}

/**
 * 記事保存(action=save)のリクエストを検証し、保存処理を実行する。
 */
function handleSave_(body) {
  var params = validateSaveParams_(body);

  // ステップ1: ページタイトルの自動取得（失敗時は URL をそのまま使う）
  var title = fetchPageTitle_(params.url);

  // ステップ2: Drive のカテゴリフォルダへ Markdown ファイルとして保存
  var saved = saveToDrive_(params.category, params.url, title, params.memo);

  // ステップ3: 検索用インデックス（Sheets）に1行追記する
  // インデックスへの追記に失敗しても、Markdown本体の保存は成功しているため
  // ユーザーには成功として返す（インデックスは検索補助であり本体ではない）
  try {
    var rootFolder = getOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
    appendIndexRow_(rootFolder, saved.savedAt, params.category, title, params.url, params.memo);
  } catch (indexErr) {
    console.error('インデックスへの追記に失敗しました: ' + indexErr);
  }

  return {
    ok: true,
    title: title,
    fileName: saved.fileName,
    folderPath: ROOT_FOLDER_NAME + '/' + params.category
  };
}

/**
 * save リクエストの必須項目を検証して返す。不正な場合は日本語メッセージ付きの Error を投げる。
 */
function validateSaveParams_(body) {
  var url = String(body.url || '').trim();
  var category = String(body.category || '').trim();
  var memo = String(body.memo || '').trim();

  // URL の検証: http/https のみ許可（javascript: 等の混入を防ぐ）
  if (!url) {
    throw new Error('URLが指定されていません');
  }
  if (!/^https?:\/\/\S+$/i.test(url)) {
    throw new Error('URLの形式が不正です: ' + url);
  }

  // カテゴリの検証: 現在のカテゴリ一覧に完全一致するもののみ受け付ける
  // （フォルダ名として使うため、任意文字列を通すとパス汚染の恐れがある）
  if (!category) {
    throw new Error('カテゴリが指定されていません');
  }
  if (getCategories_().indexOf(category) === -1) {
    throw new Error('不明なカテゴリです: ' + category);
  }

  return { url: url, category: category, memo: memo };
}

/**
 * カテゴリを1件追加する(action=addCategory)。同名が既にあればエラー。
 */
function handleAddCategory_(body) {
  var name = sanitizeCategoryName_(body.name);
  if (!name) {
    throw new Error('カテゴリ名が指定されていません');
  }

  var categories = getCategories_();
  if (categories.indexOf(name) !== -1) {
    throw new Error('同名のカテゴリが既にあります: ' + name);
  }

  categories.push(name);
  saveCategories_(categories);
  return { ok: true, categories: categories };
}

/**
 * カテゴリを1件削除する(action=removeCategory)。
 * カテゴリ一覧（選択肢）から外すだけで、Drive上の保存済みファイルや
 * Sheetsの過去の行は削除しない（非破壊。改名は別カテゴリの削除+追加で代用する）。
 */
function handleRemoveCategory_(body) {
  var name = String(body.name || '').trim();
  var categories = getCategories_();
  var index = categories.indexOf(name);
  if (index === -1) {
    throw new Error('存在しないカテゴリです: ' + name);
  }

  categories.splice(index, 1);
  saveCategories_(categories);
  return { ok: true, categories: categories };
}

/**
 * カテゴリ名として使える形に整える純粋関数。
 * Driveのフォルダ名としても使うため、区切り文字と誤認されうる / \ を置換する。
 */
function sanitizeCategoryName_(name) {
  return String(name || '').trim().replace(/[\\/]/g, '・');
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

// ---- カテゴリ一覧の永続化（スクリプトプロパティ） --------------

/**
 * 現在のカテゴリ一覧を返す。未初期化なら初期カテゴリで初期化してから返す。
 */
function getCategories_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(CATEGORIES_PROPERTY);

  if (!raw) {
    var initial = DEFAULT_CATEGORIES.slice();
    saveCategories_(initial);
    return initial;
  }

  try {
    var list = JSON.parse(raw);
    if (Object.prototype.toString.call(list) === '[object Array]' && list.length > 0) {
      return list;
    }
  } catch (parseErr) {
    // 壊れていた場合は初期カテゴリへフォールバック（下で再初期化する）
  }

  var fallback = DEFAULT_CATEGORIES.slice();
  saveCategories_(fallback);
  return fallback;
}

/** カテゴリ一覧をスクリプトプロパティへ保存する。 */
function saveCategories_(categories) {
  PropertiesService.getScriptProperties().setProperty(CATEGORIES_PROPERTY, JSON.stringify(categories));
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

  // ステップ3: ファイル名を組み立てる（タイトル + 日付。重複時は時刻を付けて回避）
  // タイトルを先頭にするのは、Driveの一覧表示（幅が狭いと末尾が省略される）で
  // 日付に隠れず記事内容がひと目でわかるようにするため。
  var now = new Date();
  var dateStr = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd');
  var fileName = buildFileName_(title, dateStr);
  if (categoryFolder.getFilesByName(fileName).hasNext()) {
    // 同名ファイルが既にある場合は時刻を付けて別ファイルにする（上書き防止）
    var timeStr = Utilities.formatDate(now, TIME_ZONE, 'HHmmss');
    fileName = buildFileName_(title, dateStr + '_' + timeStr);
  }

  // ステップ4: Markdown 本文を組み立てて保存
  var savedAt = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm');
  var content = buildMarkdown_(title, url, savedAt, category, memo);
  var file = categoryFolder.createFile(fileName, content, 'text/markdown');

  return { fileName: fileName, fileId: file.getId(), savedAt: savedAt };
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
 * 「タイトル_YYYY-MM-DD.md」形式のファイル名を組み立てる純粋関数。
 * Drive/OS で問題になりうる記号を除去し、長すぎるタイトルは切り詰める。
 */
function buildFileName_(title, datePart) {
  var safe = sanitizeFileName_(title);
  if (!safe) {
    safe = '無題';
  }
  if (safe.length > FILENAME_TITLE_MAX) {
    safe = safe.substring(0, FILENAME_TITLE_MAX) + '…';
  }
  return safe + '_' + datePart + '.md';
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

// ---- 検索用インデックス（Sheets） -----------------------------

/**
 * 検索用インデックス・スプレッドシートの1枚目のシートを取得する。
 * スクリプトプロパティに保存済みのIDがあればそれを開き、
 * 無い（または削除されて開けない）場合は新規作成して「ナレッジ」フォルダに格納する。
 */
function getOrCreateIndexSheet_(rootFolder) {
  var props = PropertiesService.getScriptProperties();
  var sheetId = props.getProperty(INDEX_SHEET_ID_PROPERTY);

  if (sheetId) {
    try {
      return SpreadsheetApp.openById(sheetId).getSheets()[0];
    } catch (openErr) {
      // 保存されていたIDのファイルが見つからない（手動削除等）→ 作り直す
    }
  }

  var spreadsheet = SpreadsheetApp.create(INDEX_SHEET_NAME);

  // 既定ではマイドライブ直下に作られるため、「ナレッジ」フォルダの中へ移動する
  var file = DriveApp.getFileById(spreadsheet.getId());
  rootFolder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);

  var sheet = spreadsheet.getSheets()[0];
  sheet.appendRow(INDEX_HEADER);
  sheet.setFrozenRows(1);

  props.setProperty(INDEX_SHEET_ID_PROPERTY, spreadsheet.getId());
  return sheet;
}

/**
 * インデックスシートに1行追記する。タイトル列は元記事URLへのHYPERLINKにする。
 */
function appendIndexRow_(rootFolder, savedAt, category, title, url, memo) {
  var sheet = getOrCreateIndexSheet_(rootFolder);
  sheet.appendRow([savedAt, category, title, url, memo || '']);

  var lastRow = sheet.getLastRow();
  var titleCell = sheet.getRange(lastRow, INDEX_COL.TITLE);
  titleCell.setFormula(
    '=HYPERLINK("' + escapeFormulaString_(url) + '","' + escapeFormulaString_(title) + '")'
  );
}

/**
 * スプレッドシートの数式文字列リテラル内に安全に埋め込めるよう、
 * ダブルクォートをエスケープする純粋関数。
 */
function escapeFormulaString_(text) {
  return String(text).replace(/"/g, '""');
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
