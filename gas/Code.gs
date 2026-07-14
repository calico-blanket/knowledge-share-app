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

// ルートフォルダ「ナレッジ」のIDを保存するスクリプトプロパティのキー
// （毎回マイドライブ全体から名前検索すると数百ms〜数秒かかるため、
//   一度見つけたフォルダのIDを覚えておき、以後はIDで直接開いて高速化する）
var ROOT_FOLDER_ID_PROPERTY = 'ROOT_FOLDER_ID';

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
var INDEX_HEADER = ['日時', 'カテゴリ', 'タイトル', 'URL', 'メモ', 'Driveファイル'];
var INDEX_COL = { SAVED_AT: 1, CATEGORY: 2, TITLE: 3, URL: 4, MEMO: 5, FILE: 6 };

// 一覧APIで一度に返す件数（1ページ分）。
// 件数が増えてもレスポンスが重くならないよう50件で区切り、
// 続きは offset パラメータで取得する（PWA側の「さらに読み込む」ボタン用）
var LIST_PAGE_SIZE = 50;

// ---- エントリポイント ---------------------------------------

/**
 * GET エンドポイント。
 * - パラメータ無し: 動作確認用メッセージを返す（合言葉不要の稼働確認）
 * - ?action=list&category=xxx&token=xxx : そのカテゴリの保存済み記事一覧を返す
 * - ?action=categories&token=xxx : カテゴリ一覧とDriveの「ナレッジ」フォルダURLを返す
 * データを返す action は、POSTと同様に SHARED_TOKEN（設定時）の照合を必須とする。
 * 記事一覧はタイトル・URL・メモといった個人の閲覧記録に近い情報を含むため、
 * WebアプリURLを知られただけでは読めないようにしておく。
 */
function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  var token = String((e && e.parameter && e.parameter.token) || '');
  if (action === 'list') {
    return handleList_(e.parameter.category, token, e.parameter.offset);
  }
  if (action === 'categories') {
    return handleCategories_(token);
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
function handleCategories_(token) {
  try {
    checkToken_(token);
    return jsonResponse_({
      ok: true,
      categories: getCategories_(),
      rootFolderUrl: getOrCreateRootFolder_().getUrl()
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * 指定カテゴリの保存済み記事一覧を、検索用インデックス（Sheets）から新しい順に返す。
 * 一度に返すのは LIST_PAGE_SIZE 件まで。offset（新しい順で何件目から）を指定すると
 * 続きのページを返し、まだ続きがある場合はレスポンスに hasMore: true を含める。
 */
function handleList_(category, token, offsetParam) {
  try {
    checkToken_(token);
    if (!category || getCategories_().indexOf(category) === -1) {
      throw new Error('不明なカテゴリです: ' + category);
    }

    // offset の検証（未指定・不正値は 0 = 先頭ページとして扱う）
    var offset = parseInt(offsetParam, 10);
    if (isNaN(offset) || offset < 0) {
      offset = 0;
    }

    var sheet = getOrCreateIndexSheet_();
    var values = sheet.getDataRange().getValues(); // values[0] はヘッダ行

    // Driveファイル列の数式（=HYPERLINK("…/document/d/{fileId}/edit","開く")）を取得し、
    // 各記事の編集キーとなる fileId を抽出できるようにする。
    // getValues では数式セルは表示値（"開く"）になり fileId が取れないため、別途 getFormulas で取る。
    // fileFormulas[k] がシートの (k+2) 行目（＝ values[k+1]）に対応する。
    var fileFormulas = values.length >= 2
      ? sheet.getRange(2, INDEX_COL.FILE, values.length - 1, 1).getFormulas()
      : [];

    var items = [];
    var matched = 0;   // このカテゴリで何件目まで見たか（offsetの読み飛ばし用）
    var hasMore = false;
    // 新しい順（末尾の行から）に走査し、offset分を読み飛ばして1ページ分集める
    for (var i = values.length - 1; i >= 1; i--) {
      var row = values[i];
      if (row[INDEX_COL.CATEGORY - 1] !== category) {
        continue;
      }
      matched++;
      if (matched <= offset) {
        continue; // 前のページで返却済み
      }
      if (items.length >= LIST_PAGE_SIZE) {
        hasMore = true; // 1ページ分を超える該当行がまだある
        break;
      }
      var fileFormula = fileFormulas[i - 1] ? fileFormulas[i - 1][0] : '';
      items.push({
        savedAt: row[INDEX_COL.SAVED_AT - 1],
        title: row[INDEX_COL.TITLE - 1],
        url: row[INDEX_COL.URL - 1],
        memo: row[INDEX_COL.MEMO - 1] || '',
        fileId: extractFileIdFromFormula_(fileFormula)
      });
    }

    return jsonResponse_({
      ok: true, category: category, items: items, offset: offset, hasMore: hasMore
    });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String((err && err.message) || err) });
  }
}

/**
 * PWA からのPOSTリクエストを受け取るエントリポイント。
 * body.action で処理を振り分ける（省略時は 'save' = 記事の保存）。
 *   - save             : { url, category, memo? } を保存
 *   - addCategory      : { name } をカテゴリ一覧に追加
 *   - removeCategory   : { name } をカテゴリ一覧から削除（保存済みデータは残す）
 *   - reorderCategories: { categories } の順にカテゴリの並び順を変更
 *   - update           : { fileId, title, url, memo? } 保存済み記事の内容を編集
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
      case 'reorderCategories':
        return jsonResponse_(handleReorderCategories_(body));
      case 'update':
        return jsonResponse_(handleUpdate_(body));
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

  // ステップ1: 共有された URL を実URLへ解決する
  // （Androidの共有機能が生成する share.google 等の短縮/リダイレクトリンクのままだと、
  //   後で人間やAIが開く際に不便な上、短縮リンクは将来失効するリスクもあるため）
  var resolvedUrl = resolveFinalUrl_(params.url);

  // ステップ2: ページのタイトルと本文テキストを取得（失敗時はタイトル=URL、本文=空）
  var details = fetchPageDetails_(resolvedUrl);

  // ステップ3: メモがタイトルと重複している場合は捨てる
  // （Android共有時に「タイトル文字列」がそのままメモ扱いで送られてくることが多く、
  //   タイトルと同じ内容が本文中に二重表示されるのを防ぐ）
  var memo = isDuplicateMemo_(params.memo, details.title) ? '' : params.memo;

  // ステップ4: Drive のカテゴリフォルダへ Googleドキュメントとして保存
  // （プレーンテキスト/Markdownファイルは、クラウド版Claudeの Google Drive
  //   連携（自然言語での自動読み込み）が直接サポートするMIMEタイプに含まれておらず、
  //   確実に内容を読ませるには Google Docs 形式にする必要があるため）
  var saved = saveToDrive_(
    params.category, resolvedUrl, details.title, memo, details.bodyText, params.url
  );

  // ステップ5: 検索用インデックス（Sheets）に1行追記する
  // インデックスへの追記に失敗しても、Doc本体の保存は成功しているため
  // ユーザーには成功として返す（インデックスは検索補助であり本体ではない）
  try {
    appendIndexRow_(
      saved.savedAt, params.category, details.title, resolvedUrl, memo, saved.fileUrl
    );
  } catch (indexErr) {
    console.error('インデックスへの追記に失敗しました: ' + indexErr);
  }

  return {
    ok: true,
    title: details.title,
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
 * カテゴリの並び順を変更する(action=reorderCategories)。
 * body.categories（新しい並び順の配列）が「現在のカテゴリ一覧の並び替え」に
 * なっていることを検証してから保存する（追加・削除・改名の混入を防ぐ）。
 * 並び順はカテゴリ一覧そのもの（配列の順序）として永続化されるため、
 * 保存画面・一覧画面・設定画面のすべてに同じ順序が反映される。
 */
function handleReorderCategories_(body) {
  var requested = body.categories;
  if (Object.prototype.toString.call(requested) !== '[object Array]') {
    throw new Error('並び替え後のカテゴリ一覧が指定されていません');
  }

  var normalized = requested.map(function (name) { return String(name); });
  var current = getCategories_();

  // 要素の集合が完全一致するか（順序だけの違いか）をソート済みJSONで比較する
  var sortedRequested = JSON.stringify(normalized.slice().sort());
  var sortedCurrent = JSON.stringify(current.slice().sort());
  if (normalized.length !== current.length || sortedRequested !== sortedCurrent) {
    throw new Error('並び替えの内容が現在のカテゴリ一覧と一致しません。画面を開き直してからやり直してください');
  }

  saveCategories_(normalized);
  return { ok: true, categories: normalized };
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

// ---- URL解決 --------------------------------------------------

// 一般的なブラウザに近い UA を名乗る（ボット扱いで拒否されるサイト対策）
var DEFAULT_USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) KnowledgeShareBot/1.0';

// リダイレクト解決の最大ホップ数（無限リダイレクト対策）
var MAX_REDIRECT_HOPS = 5;

/**
 * 短縮/リダイレクトリンク（share.google 等）を実際の記事URLへ解決する。
 * 3xxレスポンスの Location ヘッダを最大 MAX_REDIRECT_HOPS 回まで辿る。
 * 解決できなければ（通信エラー・Locationヘッダ無し等）、その時点のURLを返す。
 */
function resolveFinalUrl_(url) {
  var currentUrl = url;
  for (var i = 0; i < MAX_REDIRECT_HOPS; i++) {
    var response;
    try {
      response = UrlFetchApp.fetch(currentUrl, {
        muteHttpExceptions: true,
        followRedirects: false,
        headers: { 'User-Agent': DEFAULT_USER_AGENT }
      });
    } catch (fetchErr) {
      return currentUrl;
    }

    var code = response.getResponseCode();
    if (code < 300 || code >= 400) {
      return currentUrl;
    }

    var headers = response.getHeaders();
    var location = headers['Location'] || headers['location'];
    if (!location) {
      return currentUrl;
    }
    currentUrl = resolveRelativeUrl_(currentUrl, location);
  }
  return currentUrl;
}

/**
 * Location ヘッダの値（絶対URLとは限らない）を、遷移元URLを基準に絶対URLへ直す純粋関数。
 */
function resolveRelativeUrl_(baseUrl, location) {
  if (/^https?:\/\//i.test(location)) {
    return location;
  }
  var m = baseUrl.match(/^(https?:\/\/[^/]+)/i);
  var origin = m ? m[1] : '';
  if (location.charAt(0) === '/') {
    return origin + location;
  }
  return origin + '/' + location;
}

// ---- タイトル・本文取得 -----------------------------------------

// 本文自動抽出の最大文字数（ファイルサイズ・実行時間対策の簡易上限）
var BODY_TEXT_MAX = 4000;

/**
 * URL 先のページからタイトルと本文テキストを取得する。
 * タイトルは <title> → og:title の順、どちらも取れなければ URL をタイトル代わりに使う。
 * 本文は簡易的なHTML→テキスト変換（ナビ・広告等の除去は行わない素朴な実装）。
 * 通信エラー・タイムアウト等はすべて握りつぶし、タイトル=URL・本文=空 で返す。
 */
function fetchPageDetails_(url) {
  try {
    var response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'User-Agent': DEFAULT_USER_AGENT }
    });

    if (response.getResponseCode() >= 400) {
      return { title: url, bodyText: '' };
    }

    // 文字コードの判定: Content-Type ヘッダ → meta タグ の順で charset を探す
    var html = response.getContentText(); // まず UTF-8 として読む
    var charset = detectCharset_(response.getHeaders(), html);
    if (charset && charset.toLowerCase() !== 'utf-8') {
      // UTF-8 以外なら正しい文字コードで読み直す（Shift_JIS のサイト等の文字化け対策）
      html = response.getContentText(charset);
    }

    var title = extractTitle_(html) || url;
    var bodyText = extractBodyText_(html);
    return { title: title, bodyText: bodyText };
  } catch (fetchErr) {
    // 取得失敗時は URL そのものをタイトル代わりに使う（仕様のフォールバック）
    return { title: url, bodyText: '' };
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

/**
 * HTML から本文らしきテキストを抽出する純粋関数。
 *
 * 抽出手順:
 *   1. script/style/コメントと、本文でないことが明らかな構造要素
 *      （nav/header/footer/aside = メニュー・ランキング・フッター等）を除去
 *   2. <article> または <main> があればその中身だけを対象にする
 *      （実運用で、サイト共通部品が本文より先に来て4000文字上限を圧迫する
 *        事例があったため。セマンティックタグの無いサイトはページ全体で代替）
 *   3. ブロック要素の境目で改行を入れてから残りのタグを剥がす
 * Readability相当の高度な本文判定ではない点、X/Twitter等JS描画に依存する
 * サイトでは本文がほぼ取れない点は従来と同じ。
 * 長すぎる場合は BODY_TEXT_MAX で打ち切る。
 */
function extractBodyText_(html) {
  if (!html) {
    return '';
  }

  // ステップ1: 非本文要素の除去
  var work = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ');

  // ステップ2: article/main があればそこだけを本文候補にする
  var m = work.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
          work.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  var target = m ? m[1] : work;

  // ステップ3: ブロック要素の開始位置に改行を入れ（段落感を残すため）、残りのタグを除去
  var text = target
    .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  text = decodeEntities_(text);
  text = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (text.length > BODY_TEXT_MAX) {
    text = text.substring(0, BODY_TEXT_MAX) + '…（以下省略）';
  }
  return text;
}

/**
 * メモがタイトルと実質同じ内容かどうかを判定する純粋関数。
 * Android共有時に「タイトル文字列」がそのままメモとして送られてくることが多く、
 * それをそのまま保存すると本文とメモが同じ内容の二重表示になるため、判定して除外する。
 */
function isDuplicateMemo_(memo, title) {
  var normalizedMemo = String(memo || '').trim();
  var normalizedTitle = String(title || '').trim();
  return !!normalizedMemo && normalizedMemo === normalizedTitle;
}

// ---- Drive 保存 ---------------------------------------------

/**
 * 「ナレッジ/<カテゴリ名>/」フォルダ（無ければ自動作成）に
 * 1記事1ファイルの Googleドキュメントとして保存する。
 *
 * プレーンテキスト/Markdownファイル（text/markdown）ではなく Google Docs
 * ネイティブ形式にしているのは、クラウド版Claudeの Google Drive 連携（自然言語での
 * 自動読み込み）がサポートするMIMEタイプに text/markdown・text/plain が含まれておらず、
 * プレーンテキストのままだとAIがファイルを開けない（スクリーンショット等の代替手段が
 * 必要になる）ことが実運用で判明したため。内容自体はこれまで通りMarkdown記法の文字列を
 * そのままドキュメント本文に流し込む（見た目上は#等の記号が残るプレーンテキスト表示だが、
 * AI・人間どちらにも構造は読み取れる）。
 *
 * url は解決済みの実URL、originalUrl は共有時点の（短縮/リダイレクトの可能性がある）URL。
 * 両者が同じ場合、本文内に共有元URLの行は出さない。
 * 戻り値: { fileName, fileId, fileUrl, savedAt }
 */
function saveToDrive_(category, url, title, memo, bodyText, originalUrl) {
  // ステップ1: ルートフォルダ「ナレッジ」を取得（無ければ作成）
  var rootFolder = getOrCreateRootFolder_();

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

  // ステップ4: 本文を組み立てる
  var savedAt = Utilities.formatDate(now, TIME_ZONE, 'yyyy-MM-dd HH:mm');
  var content = buildMarkdown_(title, url, savedAt, category, memo, bodyText, originalUrl);

  // ステップ5: Googleドキュメントとして作成し、カテゴリフォルダへ移動する
  // （DocumentApp.create は既定でマイドライブ直下に作るため、Sheetsインデックスの
  //   作成と同じ要領で addFile/removeFile により目的のフォルダへ移す）
  var doc = DocumentApp.create(fileName);
  var file = DriveApp.getFileById(doc.getId());
  categoryFolder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);
  doc.getBody().setText(content);
  doc.saveAndClose();

  return { fileName: fileName, fileId: doc.getId(), fileUrl: doc.getUrl(), savedAt: savedAt };
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
 * ルートフォルダ「ナレッジ」を取得する（無ければ作成）。
 * 名前検索（getFoldersByName）はマイドライブが大きいと遅いため、
 * 一度見つけたフォルダのIDをスクリプトプロパティに記憶し、
 * 2回目以降はIDで直接開く（カテゴリ一覧・記事一覧APIの応答高速化）。
 * IDのフォルダが削除・ゴミ箱行きになっていた場合は名前検索からやり直す。
 */
function getOrCreateRootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var cachedId = props.getProperty(ROOT_FOLDER_ID_PROPERTY);

  if (cachedId) {
    try {
      var cached = DriveApp.getFolderById(cachedId);
      if (!cached.isTrashed()) {
        return cached;
      }
    } catch (openErr) {
      // IDのフォルダが開けない（削除された等）→ 下の名前検索にフォールバック
    }
  }

  var folder = getOrCreateFolder_(DriveApp.getRootFolder(), ROOT_FOLDER_NAME);
  props.setProperty(ROOT_FOLDER_ID_PROPERTY, folder.getId());
  return folder;
}

/**
 * 「タイトル_YYYY-MM-DD」形式のドキュメント名を組み立てる純粋関数。
 * Googleドキュメントとして保存するため拡張子は付けない
 * （Markdownファイル時代の .md はドキュメント名としては紛らわしいだけなので廃止）。
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
  return safe + '_' + datePart;
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
 * タイトル・URL・保存日時・カテゴリ（+任意のメモ・本文）を含める。
 * originalUrl が url と異なる場合のみ「共有時のURL」行を追加する
 * （share.google 等の短縮/リダイレクトリンクだった場合の記録用）。
 */
function buildMarkdown_(title, url, savedAt, category, memo, bodyText, originalUrl) {
  var lines = [
    '# ' + title,
    '',
    '- URL: ' + url
  ];
  if (originalUrl && originalUrl !== url) {
    lines.push('- 共有時のURL（短縮/リダイレクト元）: ' + originalUrl);
  }
  lines.push('- 保存日時: ' + savedAt);
  lines.push('- カテゴリ: ' + category);

  if (memo) {
    lines.push('');
    lines.push('## メモ');
    lines.push('');
    lines.push(memo);
  }

  if (bodyText) {
    lines.push('');
    lines.push('## 本文（自動抽出・参考）');
    lines.push('');
    lines.push(bodyText);
  }

  lines.push('');
  return lines.join('\n');
}

// ---- 検索用インデックス（Sheets） -----------------------------

/**
 * 検索用インデックス・スプレッドシートの1枚目のシートを取得する。
 * スクリプトプロパティに保存済みのIDがあればそれを開き、
 * 無い（または削除されて開けない）場合は新規作成して「ナレッジ」フォルダに格納する。
 * ルートフォルダの取得は新規作成時にしか必要ないため、その場合だけ行う
 * （一覧APIの通常経路からDriveのフォルダ検索を無くして高速化するため）。
 */
function getOrCreateIndexSheet_() {
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
  getOrCreateRootFolder_().addFile(file);
  DriveApp.getRootFolder().removeFile(file);

  var sheet = spreadsheet.getSheets()[0];
  sheet.appendRow(INDEX_HEADER);
  sheet.setFrozenRows(1);

  props.setProperty(INDEX_SHEET_ID_PROPERTY, spreadsheet.getId());
  return sheet;
}

/**
 * インデックスシートに1行追記する。
 * タイトル列は元記事URLへのHYPERLINK、Driveファイル列は保存したGoogleドキュメントへの
 * HYPERLINKにする（後者は、Drive全文検索のインデックス反映を待たずにAIがファイルへ
 * 直接ジャンプできるようにするための導線）。
 */
function appendIndexRow_(savedAt, category, title, url, memo, fileUrl) {
  var sheet = getOrCreateIndexSheet_();
  // 自由入力由来の値（タイトル・メモ・カテゴリ）はセル値としてサニタイズする。
  // GASの appendRow/setValue は先頭が = の文字列を数式として解釈するため、
  // ページタイトルや共有メモに =IMPORTXML(...) 等が入っていると実行されてしまう。
  sheet.appendRow([
    savedAt,
    sanitizeCellText_(category),
    sanitizeCellText_(title),
    url,
    sanitizeCellText_(memo || ''),
    ''
  ]);
  var lastRow = sheet.getLastRow();

  var titleCell = sheet.getRange(lastRow, INDEX_COL.TITLE);
  titleCell.setFormula(
    '=HYPERLINK("' + escapeFormulaString_(url) + '","' + escapeFormulaString_(title) + '")'
  );

  if (fileUrl) {
    var fileCell = sheet.getRange(lastRow, INDEX_COL.FILE);
    fileCell.setFormula('=HYPERLINK("' + escapeFormulaString_(fileUrl) + '","開く")');
  }
}

/**
 * スプレッドシートの数式文字列リテラル内に安全に埋め込めるよう、
 * ダブルクォートをエスケープする純粋関数。
 */
function escapeFormulaString_(text) {
  return String(text).replace(/"/g, '""');
}

/**
 * Driveファイル列のHYPERLINK数式から GoogleドキュメントのfileIdを抽出する純粋関数。
 * 例: '=HYPERLINK("https://docs.google.com/document/d/ABC123/edit","開く")' → 'ABC123'
 * 数式が無い・URL形式でない場合は空文字を返す。
 */
function extractFileIdFromFormula_(formula) {
  var m = String(formula || '').match(/document\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

// ---- 保存済み記事の編集（action=update） ----------------------

/**
 * 保存済み記事の内容（タイトル・URL・メモ）を編集する(action=update)。
 * fileId（GoogleドキュメントのID）を一意キーに、Sheetsインデックスの該当行と
 * 対応するGoogleドキュメント本文の両方を更新する。
 *
 * 行特定は「Sheetsインデックスに載っている記事のみ」に限定する（任意のfileIdで
 * 自分のDrive上の無関係なファイルを触られないよう、一覧に存在する行だけを対象にする）。
 * 保存日時とカテゴリは編集対象外で、Doc再構築時はSheets行の値をそのまま引き継ぐ。
 * ドキュメントの「本文（自動抽出・参考）」節と「共有時のURL」行は保持する。
 */
function handleUpdate_(body) {
  // ステップ1: 入力検証（save と同じ方針: http/https のみ、タイトル必須）
  var fileId = String(body.fileId || '').trim();
  var title = String(body.title || '').trim();
  var url = String(body.url || '').trim();
  var memo = String(body.memo || '').trim();

  if (!fileId) {
    throw new Error('編集対象が指定されていません');
  }
  if (!title) {
    throw new Error('タイトルを入力してください');
  }
  if (!/^https?:\/\/\S+$/i.test(url)) {
    throw new Error('URLの形式が不正です: ' + url);
  }

  // ステップ2: Sheetsインデックスから fileId 一致行を特定する
  var sheet = getOrCreateIndexSheet_();
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    throw new Error('編集対象の記事が見つかりません');
  }
  var fileFormulas = sheet.getRange(2, INDEX_COL.FILE, lastRow - 1, 1).getFormulas();
  var targetRow = -1;
  for (var i = 0; i < fileFormulas.length; i++) {
    if (extractFileIdFromFormula_(fileFormulas[i][0]) === fileId) {
      targetRow = i + 2; // ヘッダ1行 + 0始まりindex の分をずらして実際の行番号にする
      break;
    }
  }
  if (targetRow === -1) {
    throw new Error('編集対象の記事が見つかりません');
  }

  // 保存日時・カテゴリは編集しないため、Doc再構築用に現在値をSheetsから引き継ぐ
  var savedAt = String(sheet.getRange(targetRow, INDEX_COL.SAVED_AT).getValue());
  var category = String(sheet.getRange(targetRow, INDEX_COL.CATEGORY).getValue());

  // ステップ3: Sheets行を更新する（URL=平文、メモ=数式インジェクション対策、タイトル=HYPERLINK）
  sheet.getRange(targetRow, INDEX_COL.URL).setValue(sanitizeCellText_(url));
  sheet.getRange(targetRow, INDEX_COL.MEMO).setValue(sanitizeCellText_(memo));
  sheet.getRange(targetRow, INDEX_COL.TITLE).setFormula(
    '=HYPERLINK("' + escapeFormulaString_(url) + '","' + escapeFormulaString_(title) + '")'
  );

  // ステップ4: Googleドキュメント本文を更新する（自動抽出本文・共有時URLは保持）
  var doc = DocumentApp.openById(fileId);
  var currentText = doc.getBody().getText();
  var newContent = rebuildDocContent_(currentText, savedAt, category, title, url, memo);
  doc.getBody().setText(newContent);
  doc.saveAndClose();

  return { ok: true, fileId: fileId, title: title, url: url, memo: memo };
}

/**
 * 既存ドキュメント本文を、新しいタイトル・URL・メモで組み立て直す純粋関数。
 * 「本文（自動抽出・参考）」節と「共有時のURL」行は元テキストから抽出して引き継ぎ、
 * 保存日時・カテゴリは呼び出し側（Sheets行由来）の値を使う。
 * buildMarkdown_ を再利用するため、save 時と同じ本文フォーマットが保たれる。
 */
function rebuildDocContent_(currentText, savedAt, category, title, url, memo) {
  var originalUrl = extractDocOriginalUrl_(currentText);
  var bodyText = extractDocBodyText_(currentText);
  return buildMarkdown_(title, url, savedAt, category, memo, bodyText, originalUrl);
}

/**
 * ドキュメント本文から「共有時のURL（短縮/リダイレクト元）」の値を抽出する純粋関数。
 * 無ければ空文字を返す。
 */
function extractDocOriginalUrl_(text) {
  var m = String(text || '').match(/^- 共有時のURL（短縮\/リダイレクト元）: (.+)$/m);
  return m ? m[1].trim() : '';
}

/**
 * ドキュメント本文から「本文（自動抽出・参考）」節の中身を抽出する純粋関数。
 * 節見出し以降のテキスト（前後の空白を除く）を返す。節が無ければ空文字。
 */
function extractDocBodyText_(text) {
  var marker = '## 本文（自動抽出・参考）';
  var source = String(text || '');
  var idx = source.indexOf(marker);
  if (idx === -1) {
    return '';
  }
  return source.substring(idx + marker.length).replace(/^\s+/, '').replace(/\s+$/, '');
}

/**
 * セル値として書き込む自由入力テキストを無害化する純粋関数。
 * 先頭が = や + の文字列は数式として解釈されるため、先頭にアポストロフィを付ける
 * （Sheetsのユーザー入力と同じエスケープ。表示・読み取り時にアポストロフィは現れない）。
 */
function sanitizeCellText_(text) {
  var value = String(text);
  if (/^[=+]/.test(value)) {
    return "'" + value;
  }
  return value;
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
