// ============================================================
// gas/Code.gs の自動テスト
//
//   GAS のグローバルサービス（DriveApp / UrlFetchApp 等）を
//   スタブに差し替えた vm コンテキストで Code.gs 本物を実行し、
//   doPost の全経路（正常系・フォールバック・異常系）を検証する。
//
//   実行方法: node --test test/
// ============================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// ---- GAS サービスのスタブ実装 --------------------------------

/**
 * インメモリの Drive フォルダを作る。
 * GAS の Folder オブジェクトのうち Code.gs が使うメソッドだけ実装する。
 */
function createFolderStub(name) {
  const folder = {
    name,
    subFolders: [],
    files: [],
    driveFiles: [], // addFile/removeFile で管理する汎用ファイル参照（Sheets移動用）
    getFoldersByName(target) {
      const hits = folder.subFolders.filter((f) => f.name === target);
      return makeIterator(hits);
    },
    createFolder(target) {
      const child = createFolderStub(target);
      folder.subFolders.push(child);
      return child;
    },
    getFilesByName(target) {
      const hits = folder.files.filter((f) => f.name === target);
      return makeIterator(hits);
    },
    createFile(fileName, content, mimeType) {
      const file = { name: fileName, content, mimeType, getId: () => 'file-' + fileName };
      folder.files.push(file);
      return file;
    },
    getUrl() {
      return 'https://drive.google.com/drive/folders/stub-' + encodeURIComponent(name);
    },
    addFile(fileHandle) {
      folder.driveFiles.push(fileHandle);
      return folder;
    },
    removeFile(fileHandle) {
      const idx = folder.driveFiles.indexOf(fileHandle);
      if (idx !== -1) { folder.driveFiles.splice(idx, 1); }
      return folder;
    }
  };
  return folder;
}

/**
 * インメモリのスプレッドシート「シート」を作る。
 * appendRow / getRange().setFormula / getDataRange().getValues だけ実装する。
 * setFormula は =HYPERLINK("url","title") 形式を解釈し、表示値(title)をセルに反映する
 * （本物のSheetsが数式を計算表示するのと同じ見え方をNode側で再現するため）。
 */
function createSheetStub() {
  const rows = [];
  return {
    _rows: rows,
    appendRow(values) { rows.push(values.slice()); },
    setFrozenRows() {},
    getLastRow() { return rows.length; },
    getRange(row, col) {
      return {
        setFormula(formula) {
          const m = formula.match(/HYPERLINK\("((?:[^"]|"")*)","((?:[^"]|"")*)"\)/);
          if (m) {
            rows[row - 1][col - 1] = m[2].replace(/""/g, '"');
          }
        }
      };
    },
    getDataRange() {
      return { getValues: () => rows.map((r) => r.slice()) };
    }
  };
}

/** GAS の FolderIterator/FileIterator 相当（hasNext/next だけ） */
function makeIterator(items) {
  let index = 0;
  return {
    hasNext: () => index < items.length,
    next: () => items[index++]
  };
}

/** UrlFetchApp のレスポンス相当を作る */
function makeFetchResponse({ code = 200, body = '', headers = {} }) {
  return {
    getResponseCode: () => code,
    getHeaders: () => headers,
    // charset 指定付きの再読込は、スタブでは body をそのまま返す
    getContentText: (charset) => body
  };
}

/**
 * Code.gs をスタブ付き vm コンテキストに読み込み、テスト用ハンドルを返す。
 * options.fetchImpl: UrlFetchApp.fetch の差し替え関数
 * options.scriptProperties: スクリプトプロパティの中身
 */
function loadGasScript(options = {}) {
  const rootFolder = createFolderStub('(root)');
  const fetchCalls = [];
  const driveFilesById = {}; // ファイルID -> ハンドル（SpreadsheetApp.create が登録する）
  const spreadsheetsById = {}; // スプレッドシートID -> {getId, getSheets}
  let spreadsheetIdCounter = 0;
  const scriptProps = Object.assign({}, options.scriptProperties || {});

  const context = {
    // --- DriveApp スタブ ---
    DriveApp: {
      getRootFolder: () => rootFolder,
      getFileById(id) {
        if (!driveFilesById[id]) { throw new Error('スタブ: ファイルが見つかりません ' + id); }
        return driveFilesById[id];
      }
    },
    // --- SpreadsheetApp スタブ ---
    SpreadsheetApp: {
      create(name) {
        const id = 'ss-' + (++spreadsheetIdCounter);
        const sheet = createSheetStub();
        const spreadsheet = { getId: () => id, getSheets: () => [sheet], _sheet: sheet };
        spreadsheetsById[id] = spreadsheet;
        driveFilesById[id] = { getId: () => id, name: name };
        return spreadsheet;
      },
      openById(id) {
        if (!spreadsheetsById[id]) { throw new Error('スタブ: スプレッドシートが見つかりません ' + id); }
        return spreadsheetsById[id];
      }
    },
    // --- UrlFetchApp スタブ ---
    UrlFetchApp: {
      fetch(url, params) {
        fetchCalls.push({ url, params });
        if (options.fetchImpl) {
          return options.fetchImpl(url, params);
        }
        return makeFetchResponse({ body: '<title>デフォルトタイトル</title>' });
      }
    },
    // --- PropertiesService スタブ（getProperty/setProperty とも同じオブジェクトを共有） ---
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => scriptProps[key] || null,
        setProperty: (key, value) => { scriptProps[key] = value; }
      })
    },
    // --- Utilities スタブ（formatDate は固定日時で単純実装） ---
    Utilities: {
      formatDate(date, tz, pattern) {
        const pad = (n) => String(n).padStart(2, '0');
        return pattern
          .replace('yyyy', date.getFullYear())
          .replace('MM', pad(date.getMonth() + 1))
          .replace('dd', pad(date.getDate()))
          .replace('HH', pad(date.getHours()))
          .replace('mm', pad(date.getMinutes()))
          .replace('ss', pad(date.getSeconds()));
      }
    },
    // --- ContentService スタブ ---
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput(text) {
        const output = {
          _text: text,
          setMimeType: () => output,
          getContent: () => output._text
        };
        return output;
      }
    }
  };

  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
  vm.runInContext(source, context);

  return { context, rootFolder, fetchCalls, spreadsheetsById };
}

/** doPost をJSONボディ付きで呼び、レスポンスJSONをパースして返す */
function callDoPost(context, bodyObj) {
  const e = { postData: { contents: JSON.stringify(bodyObj) } };
  const output = context.doPost(e);
  return JSON.parse(output.getContent());
}

/** doGet を ?action=list&category=... 相当のパラメータで呼び、レスポンスJSONを返す */
function callDoGetList(context, category) {
  const e = { parameter: { action: 'list', category: category } };
  const output = context.doGet(e);
  return JSON.parse(output.getContent());
}

/** doGet を ?action=categories で呼び、レスポンスJSONを返す */
function callDoGetCategories(context) {
  const output = context.doGet({ parameter: { action: 'categories' } });
  return JSON.parse(output.getContent());
}

// ---- 正常系 --------------------------------------------------

test('正常系: タイトル取得 → ナレッジ/カテゴリ/ に日付+タイトル.md で保存される', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<html><head><title>テスト記事のタイトル</title></head></html>' })
  });

  const result = callDoPost(context, { url: 'https://example.com/article', category: 'PC系' });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.title, 'テスト記事のタイトル');
  assert.match(result.fileName, /^テスト記事のタイトル_\d{4}-\d{2}-\d{2}\.md$/);
  assert.strictEqual(result.folderPath, 'ナレッジ/PC系');

  // Drive 側の実体を確認: ナレッジ → PC系 → ファイル1件
  const knowledge = rootFolder.subFolders.find((f) => f.name === 'ナレッジ');
  assert.ok(knowledge, 'ナレッジフォルダが作成されている');
  const category = knowledge.subFolders.find((f) => f.name === 'PC系');
  assert.ok(category, 'カテゴリフォルダが作成されている');
  assert.strictEqual(category.files.length, 1);

  // ファイル内容にタイトル・URL・保存日時・カテゴリが含まれる
  const content = category.files[0].content;
  assert.match(content, /^# テスト記事のタイトル/);
  assert.match(content, /- URL: https:\/\/example\.com\/article/);
  assert.match(content, /- 保存日時: \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(content, /- カテゴリ: PC系/);
});

test('正常系: メモ付きで保存するとメモ節が追加される', () => {
  const { context, rootFolder } = loadGasScript();
  const result = callDoPost(context, {
    url: 'https://example.com/',
    category: '自由掲示板',
    memo: 'あとで読む'
  });
  assert.strictEqual(result.ok, true);
  const file = rootFolder.subFolders[0].subFolders[0].files[0];
  assert.match(file.content, /## メモ\n\nあとで読む/);
});

test('正常系: 既存フォルダがあれば再利用され、二重に作られない', () => {
  const { context, rootFolder } = loadGasScript();
  callDoPost(context, { url: 'https://example.com/1', category: 'DTP系' });
  callDoPost(context, { url: 'https://example.com/2', category: 'DTP系' });

  const knowledgeFolders = rootFolder.subFolders.filter((f) => f.name === 'ナレッジ');
  assert.strictEqual(knowledgeFolders.length, 1, 'ナレッジフォルダは1つだけ');
  const categoryFolders = knowledgeFolders[0].subFolders.filter((f) => f.name === 'DTP系');
  assert.strictEqual(categoryFolders.length, 1, 'カテゴリフォルダは1つだけ');
});

test('正常系: 同名ファイルが既にある場合は時刻付きの別名になり上書きされない', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>同じタイトル</title>' })
  });
  callDoPost(context, { url: 'https://example.com/a', category: 'PC系' });
  callDoPost(context, { url: 'https://example.com/b', category: 'PC系' });

  const files = rootFolder.subFolders[0].subFolders[0].files;
  assert.strictEqual(files.length, 2, '2ファイルとも保存される');
  assert.notStrictEqual(files[0].name, files[1].name, 'ファイル名が衝突しない');
  assert.match(files[1].name, /^同じタイトル_\d{4}-\d{2}-\d{2}_\d{6}\.md$/);
});

// ---- タイトル取得のフォールバック -----------------------------

test('フォールバック: fetch が例外を投げたら URL がタイトルになる', () => {
  const { context } = loadGasScript({
    fetchImpl: () => { throw new Error('DNS解決失敗'); }
  });
  const result = callDoPost(context, { url: 'https://unreachable.example/', category: 'PC系' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.title, 'https://unreachable.example/');
});

test('フォールバック: HTTP 404 なら URL がタイトルになる', () => {
  const { context } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ code: 404, body: 'Not Found' })
  });
  const result = callDoPost(context, { url: 'https://example.com/gone', category: 'PC系' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.title, 'https://example.com/gone');
});

test('フォールバック: <title> が無い HTML なら og:title を使う', () => {
  const { context } = loadGasScript({
    fetchImpl: () => makeFetchResponse({
      body: '<meta property="og:title" content="OGタイトルだけのページ"><p>本文</p>'
    })
  });
  const result = callDoPost(context, { url: 'https://example.com/og', category: 'PC系' });
  assert.strictEqual(result.title, 'OGタイトルだけのページ');
});

test('フォールバック: <title> も og:title も無ければ URL を使う', () => {
  const { context } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<p>タイトルなし</p>' })
  });
  const result = callDoPost(context, { url: 'https://example.com/notitle', category: 'PC系' });
  assert.strictEqual(result.title, 'https://example.com/notitle');
});

// ---- タイトル抽出の純粋関数 -----------------------------------

test('extractTitle_: HTML実体参照がデコードされ、改行・連続空白が畳まれる', () => {
  const { context } = loadGasScript();
  const title = context.extractTitle_(
    '<title>\n  A &amp; B &lt;C&gt; &quot;D&quot; &#39;E&#x27;   F\n</title>'
  );
  assert.strictEqual(title, 'A & B <C> "D" \'E\' F');
});

test('extractTitle_: 属性付き title タグでも抽出できる', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.extractTitle_('<title data-rh="true">属性付き</title>'), '属性付き');
});

// ---- ファイル名の純粋関数 -------------------------------------

test('sanitizeFileName_: Windows禁止文字がスペースに置換される', () => {
  const { context } = loadGasScript();
  assert.strictEqual(
    context.sanitizeFileName_('a/b\\c:d*e?f"g<h>i|j'),
    'a b c d e f g h i j'
  );
});

test('buildFileName_: 空タイトルは「無題」になる', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.buildFileName_('', '2026-07-12'), '無題_2026-07-12.md');
});

test('buildFileName_: 長すぎるタイトルは切り詰められる', () => {
  const { context } = loadGasScript();
  const longTitle = 'あ'.repeat(200);
  const name = context.buildFileName_(longTitle, '2026-07-12');
  assert.ok(name.length < 100, '切り詰め後のファイル名が十分短い: ' + name.length);
  assert.match(name, /^あ+…_2026-07-12\.md$/);
});

test('buildFileName_: タイトルが先頭、日付が末尾になる（Drive一覧でタイトルが読みやすいように）', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.buildFileName_('記事タイトル', '2026-07-12'), '記事タイトル_2026-07-12.md');
});

// ---- 異常系（入力バリデーション） ------------------------------

test('異常系: URL 無しはエラー', () => {
  const { context } = loadGasScript();
  const result = callDoPost(context, { category: 'PC系' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /URLが指定されていません/);
});

test('異常系: javascript: スキームは拒否される', () => {
  const { context } = loadGasScript();
  const result = callDoPost(context, { url: 'javascript:alert(1)', category: 'PC系' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /URLの形式が不正です/);
});

test('異常系: 許可リストにないカテゴリは拒否される', () => {
  const { context, rootFolder } = loadGasScript();
  const result = callDoPost(context, { url: 'https://example.com/', category: '../etc' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /不明なカテゴリです/);
  assert.strictEqual(rootFolder.subFolders.length, 0, 'フォルダは作られない');
});

test('異常系: ボディが JSON でない場合はエラー', () => {
  const { context } = loadGasScript();
  const output = context.doPost({ postData: { contents: 'not-json' } });
  const result = JSON.parse(output.getContent());
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /JSONが不正/);
});

test('異常系: ボディ無し（e が空）でもエラーJSONを返して落ちない', () => {
  const { context } = loadGasScript();
  const output = context.doPost(undefined);
  const result = JSON.parse(output.getContent());
  assert.strictEqual(result.ok, false);
});

// ---- 合言葉（SHARED_TOKEN） -----------------------------------

test('token: SHARED_TOKEN 設定時、一致しないと拒否される', () => {
  const { context, rootFolder } = loadGasScript({
    scriptProperties: { SHARED_TOKEN: 'himitsu' }
  });
  const ng = callDoPost(context, { url: 'https://example.com/', category: 'PC系', token: 'wrong' });
  assert.strictEqual(ng.ok, false);
  assert.match(ng.error, /合言葉が一致しません/);
  assert.strictEqual(rootFolder.subFolders.length, 0, '保存されない');

  const ok = callDoPost(context, { url: 'https://example.com/', category: 'PC系', token: 'himitsu' });
  assert.strictEqual(ok.ok, true);
});

test('token: SHARED_TOKEN 未設定なら token 無しでも通る', () => {
  const { context } = loadGasScript();
  const result = callDoPost(context, { url: 'https://example.com/', category: 'PC系' });
  assert.strictEqual(result.ok, true);
});

// ---- 全カテゴリの網羅確認 -------------------------------------

test('カテゴリ: 初期リスト10件すべてが受理され、同名フォルダが作られる', () => {
  const { context, rootFolder } = loadGasScript();
  const expected = [
    '業務マニュアル', '自由掲示板', 'PC系', 'DTP系', 'その他PC学習、スキル',
    'PCニュース', '語学系', '英語・中国語', 'レシピ、お店', 'TOCO/お知らせ'
  ];
  for (const cat of expected) {
    const result = callDoPost(context, { url: 'https://example.com/', category: cat });
    assert.strictEqual(result.ok, true, cat + ' が受理される');
  }
  const knowledge = rootFolder.subFolders.find((f) => f.name === 'ナレッジ');
  const folderNames = knowledge.subFolders.map((f) => f.name);
  assert.deepStrictEqual(folderNames.sort(), [...expected].sort());
});

// ---- 検索用インデックス（Sheets）と一覧API -----------------------

test('インデックス: 保存すると同時にSheetsへ1行追記される（初回はシートも自動作成）', () => {
  const { context, spreadsheetsById } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>索引テスト記事</title>' })
  });

  callDoPost(context, { url: 'https://example.com/idx', category: 'PC系', memo: 'メモA' });

  const ids = Object.keys(spreadsheetsById);
  assert.strictEqual(ids.length, 1, 'スプレッドシートが1つだけ作られる');
  const rows = spreadsheetsById[ids[0]]._sheet._rows;
  assert.strictEqual(rows.length, 2, 'ヘッダ行 + データ1行');
  // vm(別レルム)の配列と比較するため、prototypeを問わない Array.from で正規化してから比較する
  assert.deepStrictEqual(Array.from(rows[0]), ['日時', 'カテゴリ', 'タイトル', 'URL', 'メモ']);
  assert.strictEqual(rows[1][1], 'PC系');
  assert.strictEqual(rows[1][2], '索引テスト記事'); // HYPERLINKの表示値(タイトル)
  assert.strictEqual(rows[1][3], 'https://example.com/idx');
  assert.strictEqual(rows[1][4], 'メモA');
});

test('インデックス: 2回目以降の保存はスプレッドシートを作り直さず追記する', () => {
  const { context, spreadsheetsById } = loadGasScript();
  callDoPost(context, { url: 'https://example.com/1', category: 'PC系' });
  callDoPost(context, { url: 'https://example.com/2', category: 'DTP系' });

  assert.strictEqual(Object.keys(spreadsheetsById).length, 1, 'スプレッドシートは1つのまま');
  const rows = Object.values(spreadsheetsById)[0]._sheet._rows;
  assert.strictEqual(rows.length, 3, 'ヘッダ + データ2行');
});

test('一覧API: 指定カテゴリの保存済み記事のみを新しい順に返す', () => {
  const { context } = loadGasScript();
  callDoPost(context, { url: 'https://example.com/pc1', category: 'PC系', memo: '1件目' });
  callDoPost(context, { url: 'https://example.com/dtp1', category: 'DTP系' });
  callDoPost(context, { url: 'https://example.com/pc2', category: 'PC系', memo: '2件目' });

  const result = callDoGetList(context, 'PC系');
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.items.length, 2, 'PC系のみ2件');
  // 新しい順（後に保存したpc2が先頭）
  assert.strictEqual(result.items[0].url, 'https://example.com/pc2');
  assert.strictEqual(result.items[0].memo, '2件目');
  assert.strictEqual(result.items[1].url, 'https://example.com/pc1');
});

test('一覧API: まだ何も保存されていないカテゴリは空配列を返す（エラーにしない）', () => {
  const { context } = loadGasScript();
  const result = callDoGetList(context, 'TOCO/お知らせ');
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.items, []);
});

test('一覧API: 不明なカテゴリはエラーを返す', () => {
  const { context } = loadGasScript();
  const result = callDoGetList(context, '../etc');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /不明なカテゴリです/);
});

test('一覧API: category未指定はエラーを返す', () => {
  const { context } = loadGasScript();
  const result = callDoGetList(context, undefined);
  assert.strictEqual(result.ok, false);
});

test('doGet: action未指定は稼働確認メッセージを返す（一覧処理に入らない）', () => {
  const { context } = loadGasScript();
  const output = context.doGet({ parameter: {} });
  const result = JSON.parse(output.getContent());
  assert.strictEqual(result.ok, true);
  assert.match(result.message, /稼働中/);
});

test('doGet: eが空でも落ちない', () => {
  const { context } = loadGasScript();
  const output = context.doGet(undefined);
  const result = JSON.parse(output.getContent());
  assert.strictEqual(result.ok, true);
});

test('escapeFormulaString_: ダブルクォートが二重化される（数式インジェクション対策）', () => {
  const { context } = loadGasScript();
  assert.strictEqual(
    context.escapeFormulaString_('タイトルに"引用符"あり'),
    'タイトルに""引用符""あり'
  );
});

test('インデックス追記が失敗しても doPost 自体は成功として返す（本体保存を優先）', () => {
  const { context, rootFolder } = loadGasScript();
  // SpreadsheetApp.create を壊して、インデックス追記だけ失敗させる
  context.SpreadsheetApp.create = () => { throw new Error('スタブ: 意図的な失敗'); };

  const result = callDoPost(context, { url: 'https://example.com/x', category: 'PC系' });
  assert.strictEqual(result.ok, true, 'Markdown保存が成功していればokはtrue');
  const category = rootFolder.subFolders[0].subFolders[0];
  assert.strictEqual(category.files.length, 1, 'Markdownファイルは保存されている');
});

// ---- カテゴリ管理（動的CRUD） -----------------------------------

test('categories API: 初回アクセスでデフォルト10カテゴリが返る', () => {
  const { context } = loadGasScript();
  const result = callDoGetCategories(context);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.categories.length, 10);
  assert.ok(result.categories.indexOf('PC系') !== -1);
  assert.match(result.rootFolderUrl, /^https:\/\/drive\.google\.com\/drive\/folders\//);
});

test('categories API: 2回呼んでも同じ一覧が安定して返る（毎回初期化されない）', () => {
  const { context } = loadGasScript();
  const first = callDoGetCategories(context);
  const second = callDoGetCategories(context);
  assert.deepStrictEqual(Array.from(first.categories), Array.from(second.categories));
});

test('addCategory: 新しいカテゴリを追加すると一覧に反映され、以後 save でも使える', () => {
  const { context } = loadGasScript();
  const added = callDoPost(context, { action: 'addCategory', name: '写真' });
  assert.strictEqual(added.ok, true);
  assert.ok(added.categories.indexOf('写真') !== -1);

  const saved = callDoPost(context, { url: 'https://example.com/photo', category: '写真' });
  assert.strictEqual(saved.ok, true, '追加した直後のカテゴリで保存できる');
});

test('addCategory: 空名は拒否される', () => {
  const { context } = loadGasScript();
  const result = callDoPost(context, { action: 'addCategory', name: '   ' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /カテゴリ名が指定されていません/);
});

test('addCategory: 同名カテゴリの重複追加は拒否される', () => {
  const { context } = loadGasScript();
  const result = callDoPost(context, { action: 'addCategory', name: 'PC系' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /同名のカテゴリが既にあります/);
});

test('addCategory: 名前に / や \\ が含まれる場合は・に置換される（Driveフォルダ名対策）', () => {
  const { context } = loadGasScript();
  const result = callDoPost(context, { action: 'addCategory', name: 'A/B\\C' });
  assert.strictEqual(result.ok, true);
  assert.ok(result.categories.indexOf('A・B・C') !== -1);
});

test('removeCategory: 削除すると一覧から消えるが、既存のDriveファイル・Sheets行は残る', () => {
  const { context, rootFolder } = loadGasScript();
  callDoPost(context, { url: 'https://example.com/old', category: 'PC系', memo: '削除前に保存' });

  const removed = callDoPost(context, { action: 'removeCategory', name: 'PC系' });
  assert.strictEqual(removed.ok, true);
  assert.strictEqual(removed.categories.indexOf('PC系'), -1);

  // 新規保存はもうできない（選択肢から外れている）
  const saveAfterRemove = callDoPost(context, { url: 'https://example.com/new', category: 'PC系' });
  assert.strictEqual(saveAfterRemove.ok, false);

  // 削除前に保存したDrive上のファイルは残っている（非破壊）
  const knowledge = rootFolder.subFolders.find((f) => f.name === 'ナレッジ');
  const pcFolder = knowledge.subFolders.find((f) => f.name === 'PC系');
  assert.ok(pcFolder, 'カテゴリフォルダ自体は削除されない');
  assert.strictEqual(pcFolder.files.length, 1, '保存済みファイルは残る');
});

test('removeCategory: 存在しないカテゴリの削除はエラー', () => {
  const { context } = loadGasScript();
  const result = callDoPost(context, { action: 'removeCategory', name: '存在しないカテゴリ' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /存在しないカテゴリです/);
});

test('doPost: 不明なactionはエラーになる', () => {
  const { context } = loadGasScript();
  const result = callDoPost(context, { action: 'destroyEverything' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /不明なactionです/);
});

test('doPost: addCategory/removeCategoryもSHARED_TOKEN検証の対象になる', () => {
  const { context } = loadGasScript({ scriptProperties: { SHARED_TOKEN: 'himitsu' } });
  const result = callDoPost(context, { action: 'addCategory', name: '写真', token: 'wrong' });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /合言葉が一致しません/);
});

test('DEFAULT_CATEGORIES: 元の10カテゴリがそのまま定義されている（回帰確認）', () => {
  const { context } = loadGasScript();
  assert.deepStrictEqual(Array.from(context.DEFAULT_CATEGORIES), [
    '業務マニュアル', '自由掲示板', 'PC系', 'DTP系', 'その他PC学習、スキル',
    'PCニュース', '語学系', '英語・中国語', 'レシピ、お店', 'TOCO/お知らせ'
  ]);
});

// ---- URL解決（短縮/リダイレクトリンク対策） -----------------------

test('resolveFinalUrl_: リダイレクトが無ければ元のURLをそのまま返す', () => {
  const { context } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ code: 200, body: 'ok' })
  });
  assert.strictEqual(context.resolveFinalUrl_('https://example.com/'), 'https://example.com/');
});

test('resolveFinalUrl_: 302リダイレクトを1回辿って実URLへ解決する', () => {
  const { context } = loadGasScript({
    fetchImpl: (url) => {
      if (url === 'https://short.example/abc') {
        return makeFetchResponse({ code: 302, headers: { Location: 'https://real.example/article' } });
      }
      return makeFetchResponse({ code: 200 });
    }
  });
  assert.strictEqual(context.resolveFinalUrl_('https://short.example/abc'), 'https://real.example/article');
});

test('resolveFinalUrl_: リダイレクトが上限回数を超えたら最後に辿り着いたURLで打ち切る', () => {
  const { context } = loadGasScript({
    fetchImpl: (url) => {
      const n = Number(url.split('/').pop());
      return makeFetchResponse({ code: 302, headers: { Location: 'https://loop.example/' + (n + 1) } });
    }
  });
  // MAX_REDIRECT_HOPS=5 なので、0→1→2→3→4→5 と5回転送を辿った時点で打ち切られる
  assert.strictEqual(context.resolveFinalUrl_('https://loop.example/0'), 'https://loop.example/5');
});

test('resolveFinalUrl_: Locationヘッダが無い3xxはその時点のURLで打ち切る', () => {
  const { context } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ code: 301, headers: {} })
  });
  assert.strictEqual(context.resolveFinalUrl_('https://example.com/'), 'https://example.com/');
});

test('resolveFinalUrl_: 通信エラー時はその時点のURLを返す（例外を投げない）', () => {
  const { context } = loadGasScript({
    fetchImpl: () => { throw new Error('timeout'); }
  });
  assert.strictEqual(context.resolveFinalUrl_('https://example.com/'), 'https://example.com/');
});

test('resolveRelativeUrl_: 絶対URLのLocationはそのまま返す', () => {
  const { context } = loadGasScript();
  assert.strictEqual(
    context.resolveRelativeUrl_('https://a.example/x', 'https://b.example/y'),
    'https://b.example/y'
  );
});

test('resolveRelativeUrl_: /始まりの相対パスはoriginと結合する', () => {
  const { context } = loadGasScript();
  assert.strictEqual(
    context.resolveRelativeUrl_('https://a.example/x/y', '/z'),
    'https://a.example/z'
  );
});

test('doPost: 短縮/リダイレクトURLは実URLに解決されてからDrive・Sheetsに保存される', () => {
  const { context, rootFolder, spreadsheetsById } = loadGasScript({
    fetchImpl: (url) => {
      if (url === 'https://short.example/abc') {
        return makeFetchResponse({ code: 302, headers: { Location: 'https://real.example/article' } });
      }
      return makeFetchResponse({ body: '<title>実記事タイトル</title><p>本文だよ</p>' });
    }
  });

  const result = callDoPost(context, { url: 'https://short.example/abc', category: 'PC系' });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.title, '実記事タイトル');

  const file = rootFolder.subFolders[0].subFolders[0].files[0];
  assert.match(file.content, /- URL: https:\/\/real\.example\/article/);
  assert.match(file.content, /共有時のURL（短縮\/リダイレクト元）: https:\/\/short\.example\/abc/);

  const rows = Object.values(spreadsheetsById)[0]._sheet._rows;
  assert.strictEqual(rows[1][3], 'https://real.example/article', 'Sheets側のURL列も解決後のURL');
});

test('doPost: リダイレクトが無いURLでは「共有時のURL」行を出さない', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>直リンク記事</title>' })
  });
  callDoPost(context, { url: 'https://example.com/direct', category: 'PC系' });
  const file = rootFolder.subFolders[0].subFolders[0].files[0];
  assert.doesNotMatch(file.content, /共有時のURL/);
});

// ---- 本文自動抽出 -----------------------------------------------

test('extractBodyText_: script/styleを除去し、タグを剥がしてテキスト化する', () => {
  const { context } = loadGasScript();
  const html = '<html><head><style>.a{color:red}</style><script>alert(1)</script></head>' +
    '<body><h1>見出し</h1><p>本文1行目です。</p><p>本文2行目です。</p></body></html>';
  const text = context.extractBodyText_(html);
  assert.doesNotMatch(text, /alert\(1\)/);
  assert.doesNotMatch(text, /color:red/);
  assert.match(text, /見出し/);
  assert.match(text, /本文1行目です。/);
  assert.match(text, /本文2行目です。/);
});

test('extractBodyText_: 長すぎる本文はBODY_TEXT_MAXで切り詰められる', () => {
  const { context } = loadGasScript();
  const html = '<p>' + 'あ'.repeat(6000) + '</p>';
  const text = context.extractBodyText_(html);
  assert.ok(text.length < 4100, '切り詰められている: ' + text.length);
  assert.match(text, /…（以下省略）$/);
});

test('extractBodyText_: 空HTMLは空文字を返す', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.extractBodyText_(''), '');
});

test('doPost: 抽出した本文がMarkdownの「本文」節に反映される', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>本文付き記事</title><p>これは本文です。</p>' })
  });
  const result = callDoPost(context, { url: 'https://example.com/body-test', category: 'PC系' });
  assert.strictEqual(result.ok, true);
  const file = rootFolder.subFolders[0].subFolders[0].files[0];
  assert.match(file.content, /## 本文（自動抽出・参考）/);
  assert.match(file.content, /これは本文です。/);
});

// ---- メモ重複排除（タイトルと同一のメモを捨てる） -------------------

test('isDuplicateMemo_: メモとタイトルが完全一致なら重複と判定される', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.isDuplicateMemo_('同じ文字列', '同じ文字列'), true);
});

test('isDuplicateMemo_: 前後の空白差は無視して重複判定する', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.isDuplicateMemo_('  同じ文字列  ', '同じ文字列'), true);
});

test('isDuplicateMemo_: 内容が異なれば重複ではない', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.isDuplicateMemo_('あとで読む', 'タイトル'), false);
});

test('isDuplicateMemo_: 空メモは重複ではない', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.isDuplicateMemo_('', 'タイトル'), false);
});

test('doPost: メモがタイトルと同一なら「メモ」節を出さない（重複防止）', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>同じ内容</title>' })
  });
  const result = callDoPost(context, { url: 'https://example.com/dup', category: 'PC系', memo: '同じ内容' });
  assert.strictEqual(result.ok, true);
  const file = rootFolder.subFolders[0].subFolders[0].files[0];
  assert.doesNotMatch(file.content, /## メモ/);
});

test('doPost: メモがタイトルと異なれば通常通り「メモ」節を出す', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>タイトル</title>' })
  });
  callDoPost(context, { url: 'https://example.com/diff', category: 'PC系', memo: '別のコメント' });
  const file = rootFolder.subFolders[0].subFolders[0].files[0];
  assert.match(file.content, /## メモ\n\n別のコメント/);
});
