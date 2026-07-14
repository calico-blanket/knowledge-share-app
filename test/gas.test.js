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
let folderIdCounter = 0;

function createFolderStub(name) {
  const folder = {
    name,
    id: 'folder-' + (++folderIdCounter),
    subFolders: [],
    files: [],
    driveFiles: [], // addFile/removeFile で管理する汎用ファイル参照（Sheets移動用）
    getId() { return folder.id; },
    isTrashed() { return false; },
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
      // Googleドキュメント（DocumentApp.create相当）の場合は、既存の files 配列にも
      // 登録する。同一オブジェクト参照なので、後から doc.getBody().setText() で
      // 更新される content もテスト側からそのまま参照できる（実際のDrive APIでも
      // getFilesByName はファイル種別を問わず名前一致で見つかる）。
      if (fileHandle._isDoc) {
        folder.files.push(fileHandle);
      }
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
 * 実際のSheetsに合わせ、表示値(getValues)と数式(getFormulas)を別々に保持する。
 * - setFormula: 数式を記録しつつ、=HYPERLINK("url","title") は表示値(title)に反映する
 *   （本物のSheetsが数式を計算表示するのと同じ見え方をNode側で再現するため）
 * - getFormulas: 数式が入ったセルはその数式文字列、それ以外は '' を返す
 *   （fileId抽出は Driveファイル列の HYPERLINK数式から行うため、この再現が必須）
 */
function createSheetStub() {
  const rows = [];       // 表示値（getValues 用）
  const formulas = [];   // 数式（getFormulas 用）。数式でないセルは ''
  return {
    _rows: rows,
    _formulas: formulas,
    appendRow(values) {
      rows.push(values.slice());
      formulas.push(values.map(() => '')); // 追記直後は数式なし
    },
    setFrozenRows() {},
    getLastRow() { return rows.length; },
    getRange(row, col, numRows, numCols) {
      return {
        setFormula(formula) {
          formulas[row - 1][col - 1] = formula;
          // 表示値も更新（HYPERLINKなら表示テキスト、それ以外は数式文字列のまま）
          const m = formula.match(/HYPERLINK\("((?:[^"]|"")*)","((?:[^"]|"")*)"\)/);
          rows[row - 1][col - 1] = m ? m[2].replace(/""/g, '"') : formula;
        },
        setValue(value) {
          rows[row - 1][col - 1] = value;
          formulas[row - 1][col - 1] = ''; // 値を入れると数式は消える（実挙動と同じ）
        },
        getValue() { return rows[row - 1][col - 1]; },
        getFormulas() {
          const rn = numRows || 1;
          const cn = numCols || 1;
          const out = [];
          for (let r = 0; r < rn; r++) {
            const line = [];
            for (let c = 0; c < cn; c++) {
              const fr = formulas[row - 1 + r];
              line.push(fr ? (fr[col - 1 + c] || '') : '');
            }
            out.push(line);
          }
          return out;
        }
      };
    },
    getDataRange() {
      return { getValues: () => rows.map((r) => r.slice()) };
    }
  };
}

/**
 * インメモリの Googleドキュメント「ハンドル」を作る。
 * getBody().setText() で content プロパティを直接更新する（folder.files に登録された
 * 同一オブジェクトからも参照できるようにするため、別オブジェクトへコピーしない）。
 */
function createDocStub(id, name) {
  const handle = {
    _isDoc: true,
    name,
    content: '',
    mimeType: 'application/vnd.google-apps.document',
    getId: () => id,
    getUrl: () => 'https://docs.google.com/document/d/' + id + '/edit',
    getBody() {
      return {
        setText(text) {
          handle.content = text;
          return this;
        },
        getText() { return handle.content; }
      };
    },
    saveAndClose() {}
  };
  return handle;
}

/** フォルダツリーをIDで探す（DriveApp.getFolderById スタブ用） */
function findFolderById(folder, id) {
  if (folder.id === id) { return folder; }
  for (const child of folder.subFolders) {
    const hit = findFolderById(child, id);
    if (hit) { return hit; }
  }
  return null;
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
  let docIdCounter = 0;
  const scriptProps = Object.assign({}, options.scriptProperties || {});

  const context = {
    // --- DriveApp スタブ ---
    DriveApp: {
      getRootFolder: () => rootFolder,
      getFolderById(id) {
        // ルートフォルダ自身はIDで開けない想定にする（Code.gsは「ナレッジ」フォルダのIDしか渡さない）
        const hit = findFolderById(rootFolder, id);
        if (!hit || hit === rootFolder) { throw new Error('スタブ: フォルダが見つかりません ' + id); }
        return hit;
      },
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
    // --- DocumentApp スタブ ---
    DocumentApp: {
      create(name) {
        const id = 'doc-' + (++docIdCounter);
        const handle = createDocStub(id, name);
        driveFilesById[id] = handle;
        return handle;
      },
      openById(id) {
        const handle = driveFilesById[id];
        if (!handle || !handle._isDoc) {
          throw new Error('スタブ: ドキュメントが見つかりません ' + id);
        }
        return handle;
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

/** doGet を ?action=list&category=...&token=...&offset=... 相当のパラメータで呼び、レスポンスJSONを返す */
function callDoGetList(context, category, token, offset) {
  const e = { parameter: { action: 'list', category: category, token: token, offset: offset } };
  const output = context.doGet(e);
  return JSON.parse(output.getContent());
}

/** doGet を ?action=categories&token=... で呼び、レスポンスJSONを返す */
function callDoGetCategories(context, token) {
  const output = context.doGet({ parameter: { action: 'categories', token: token } });
  return JSON.parse(output.getContent());
}

// ---- 正常系 --------------------------------------------------

test('正常系: タイトル取得 → ナレッジ/カテゴリ/ に「タイトル_日付」のドキュメントで保存される', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<html><head><title>テスト記事のタイトル</title></head></html>' })
  });

  const result = callDoPost(context, { url: 'https://example.com/article', category: 'PC系' });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.title, 'テスト記事のタイトル');
  assert.match(result.fileName, /^テスト記事のタイトル_\d{4}-\d{2}-\d{2}$/);
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
  assert.match(files[1].name, /^同じタイトル_\d{4}-\d{2}-\d{2}_\d{6}$/);
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
  assert.strictEqual(context.buildFileName_('', '2026-07-12'), '無題_2026-07-12');
});

test('buildFileName_: 長すぎるタイトルは切り詰められる', () => {
  const { context } = loadGasScript();
  const longTitle = 'あ'.repeat(200);
  const name = context.buildFileName_(longTitle, '2026-07-12');
  assert.ok(name.length < 100, '切り詰め後のファイル名が十分短い: ' + name.length);
  assert.match(name, /^あ+…_2026-07-12$/);
});

test('buildFileName_: タイトルが先頭、日付が末尾になる（Drive一覧でタイトルが読みやすいように）', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.buildFileName_('記事タイトル', '2026-07-12'), '記事タイトル_2026-07-12');
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
  assert.deepStrictEqual(Array.from(rows[0]), ['日時', 'カテゴリ', 'タイトル', 'URL', 'メモ', 'Driveファイル']);
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

// ---- Google Docs形式での保存 --------------------------------------
// プレーンテキスト/Markdown（text/markdown）はクラウド版Claudeの Google Drive
// 連携が直接読めるMIMEタイプに含まれないため、Google Docsネイティブ形式で保存する。

test('doPost: 記事はGoogleドキュメント（DocumentApp）として作成される', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>Docs形式テスト</title><p>本文</p>' })
  });
  const result = callDoPost(context, { url: 'https://example.com/docs-test', category: 'PC系' });
  assert.strictEqual(result.ok, true);

  const file = rootFolder.subFolders[0].subFolders[0].files[0];
  assert.strictEqual(file._isDoc, true, 'createFileではなくDocumentApp.createで作られている');
  assert.strictEqual(file.mimeType, 'application/vnd.google-apps.document');
  assert.match(file.getUrl(), /^https:\/\/docs\.google\.com\/document\/d\//);
});

test('doPost: Sheetsインデックスの「Driveファイル」列にドキュメントへのHYPERLINKが入る', () => {
  const { context, spreadsheetsById } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>索引にファイルリンク</title>' })
  });
  callDoPost(context, { url: 'https://example.com/index-file-link', category: 'PC系' });

  const rows = Object.values(spreadsheetsById)[0]._sheet._rows;
  assert.deepStrictEqual(Array.from(rows[0]), ['日時', 'カテゴリ', 'タイトル', 'URL', 'メモ', 'Driveファイル']);
  assert.strictEqual(rows[1][5], '開く', 'Driveファイル列はHYPERLINKの表示値「開く」になる');
});

test('doPost: 同名記事の重複判定はGoogleドキュメントに対しても機能する（上書き防止）', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>重複タイトル</title>' })
  });
  callDoPost(context, { url: 'https://example.com/dup-a', category: 'PC系' });
  callDoPost(context, { url: 'https://example.com/dup-b', category: 'PC系' });

  const files = rootFolder.subFolders[0].subFolders[0].files;
  assert.strictEqual(files.length, 2, '2件ともドキュメントとして保存される');
  assert.notStrictEqual(files[0].name, files[1].name, 'ファイル名（ドキュメントのタイトル）が衝突しない');
});

// ---- GET系APIの合言葉検証（レビュー指摘🔴1の回帰テスト） -----------
// 記事一覧はタイトル・URL・メモといった個人の閲覧記録に近い情報を含むため、
// WebアプリのURLを知られただけでは読めないよう、GETもPOSTと同じ合言葉で保護する。

test('GET保護: SHARED_TOKEN設定時、tokenなしのlistは拒否される', () => {
  const { context } = loadGasScript({ scriptProperties: { SHARED_TOKEN: 'himitsu' } });
  const result = callDoGetList(context, 'PC系', undefined);
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /合言葉が一致しません/);
});

test('GET保護: SHARED_TOKEN設定時、token不一致のcategoriesは拒否される', () => {
  const { context } = loadGasScript({ scriptProperties: { SHARED_TOKEN: 'himitsu' } });
  const result = callDoGetCategories(context, 'wrong');
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /合言葉が一致しません/);
});

test('GET保護: 正しいtokenならlist/categoriesとも通る', () => {
  const { context } = loadGasScript({ scriptProperties: { SHARED_TOKEN: 'himitsu' } });
  callDoPost(context, { url: 'https://example.com/a', category: 'PC系', token: 'himitsu' });

  const list = callDoGetList(context, 'PC系', 'himitsu');
  assert.strictEqual(list.ok, true);
  assert.strictEqual(list.items.length, 1);

  const categories = callDoGetCategories(context, 'himitsu');
  assert.strictEqual(categories.ok, true);
});

test('GET保護: SHARED_TOKEN未設定ならtokenなしでも通る（従来挙動の維持）', () => {
  const { context } = loadGasScript();
  const result = callDoGetCategories(context, undefined);
  assert.strictEqual(result.ok, true);
});

test('GET保護: tokenなしでも稼働確認メッセージ(actionなし)は返る', () => {
  const { context } = loadGasScript({ scriptProperties: { SHARED_TOKEN: 'himitsu' } });
  const output = context.doGet({ parameter: {} });
  const result = JSON.parse(output.getContent());
  assert.strictEqual(result.ok, true, '稼働確認は情報を含まないため合言葉不要');
});

// ---- Sheets数式インジェクション対策（レビュー指摘🔴4の回帰テスト） ---

test('sanitizeCellText_: 先頭が = の文字列にはアポストロフィが付く', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.sanitizeCellText_('=IMPORTXML("http://evil/","//a")'), "'=IMPORTXML(\"http://evil/\",\"//a\")");
  assert.strictEqual(context.sanitizeCellText_('+1+1'), "'+1+1");
});

test('sanitizeCellText_: 通常の文字列はそのまま', () => {
  const { context } = loadGasScript();
  assert.strictEqual(context.sanitizeCellText_('普通のタイトル'), '普通のタイトル');
  assert.strictEqual(context.sanitizeCellText_(''), '');
});

test('doPost: メモが数式で始まる場合、Sheetsにはアポストロフィ付きで書き込まれる', () => {
  const { context, spreadsheetsById } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>数式入りメモの記事</title>' })
  });
  callDoPost(context, { url: 'https://example.com/f', category: 'PC系', memo: '=1+1' });

  const rows = Object.values(spreadsheetsById)[0]._sheet._rows;
  assert.strictEqual(rows[1][4], "'=1+1", 'メモ列は数式として解釈されない形で格納される');
});

// ---- 本文抽出の改善（レビュー指摘🟡6の回帰テスト） ------------------

test('extractBodyText_: nav/header/footer/aside内のテキストは除去される', () => {
  const { context } = loadGasScript();
  const html = '<body><nav>メニュー ランキング</nav><header>サイトヘッダー</header>' +
    '<p>これが本文です。</p><aside>広告です</aside><footer>フッター情報</footer></body>';
  const text = context.extractBodyText_(html);
  assert.doesNotMatch(text, /メニュー ランキング/);
  assert.doesNotMatch(text, /サイトヘッダー/);
  assert.doesNotMatch(text, /広告です/);
  assert.doesNotMatch(text, /フッター情報/);
  assert.match(text, /これが本文です。/);
});

test('extractBodyText_: <article>があればその中身だけが本文になる', () => {
  const { context } = loadGasScript();
  const html = '<body><div>サイドバーのおすすめ記事一覧</div>' +
    '<article><h1>記事見出し</h1><p>記事の本文段落。</p></article>' +
    '<div>関連記事リスト</div></body>';
  const text = context.extractBodyText_(html);
  assert.match(text, /記事見出し/);
  assert.match(text, /記事の本文段落。/);
  assert.doesNotMatch(text, /サイドバーのおすすめ記事一覧/);
  assert.doesNotMatch(text, /関連記事リスト/);
});

test('extractBodyText_: articleが無ければページ全体からの抽出にフォールバックする', () => {
  const { context } = loadGasScript();
  const html = '<body><div><p>タグ構造が古いサイトの本文。</p></div></body>';
  const text = context.extractBodyText_(html);
  assert.match(text, /タグ構造が古いサイトの本文。/);
});

// ---- コード品質の回帰チェック（レビュー指摘🔴3） ---------------------

test('Code.gs: checkToken_ の定義がちょうど1つである（重複定義の再発防止）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
  const definitions = source.match(/function checkToken_\(/g) || [];
  assert.strictEqual(definitions.length, 1);
});

// ---- カテゴリの並び替え(action=reorderCategories) --------------------

test('reorderCategories: 並び替えた順序が保存され、以後の categories API に反映される', () => {
  const { context } = loadGasScript();
  const original = callDoGetCategories(context).categories;
  const reordered = original.slice().reverse();

  const result = callDoPost(context, { action: 'reorderCategories', categories: reordered });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.categories, reordered);

  // 再取得しても新しい順序が保持されている（スクリプトプロパティに永続化）
  assert.deepStrictEqual(callDoGetCategories(context).categories, reordered);
});

test('reorderCategories: 件数が一致しない（勝手な削除・追加の混入）は拒否される', () => {
  const { context } = loadGasScript();
  const original = callDoGetCategories(context).categories;

  const missingOne = original.slice(1); // 1件欠け
  const r1 = callDoPost(context, { action: 'reorderCategories', categories: missingOne });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.error, /一致しません/);

  const extraOne = original.concat(['勝手に追加']); // 1件過剰
  const r2 = callDoPost(context, { action: 'reorderCategories', categories: extraOne });
  assert.strictEqual(r2.ok, false);

  // どちらの失敗でも元の並びが壊れていないこと
  assert.deepStrictEqual(callDoGetCategories(context).categories, original);
});

test('reorderCategories: 同数でも要素の中身が違う（改名の混入）は拒否される', () => {
  const { context } = loadGasScript();
  const original = callDoGetCategories(context).categories;
  const renamed = original.slice();
  renamed[0] = '存在しない名前へ改名';

  const result = callDoPost(context, { action: 'reorderCategories', categories: renamed });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(callDoGetCategories(context).categories, original);
});

test('reorderCategories: categories が配列でない・無い場合はエラー', () => {
  const { context } = loadGasScript();
  const r1 = callDoPost(context, { action: 'reorderCategories' });
  assert.strictEqual(r1.ok, false);
  const r2 = callDoPost(context, { action: 'reorderCategories', categories: 'PC系' });
  assert.strictEqual(r2.ok, false);
});

test('reorderCategories: SHARED_TOKEN検証の対象になる（合言葉なしは拒否）', () => {
  const { context } = loadGasScript({ scriptProperties: { SHARED_TOKEN: 'himitsu' } });
  const result = callDoPost(context, {
    action: 'reorderCategories',
    categories: ['a'] // tokenチェックが先に走るため中身は届かない
  });
  assert.strictEqual(result.ok, false);
  assert.match(result.error, /合言葉が一致しません/);
});

test('reorderCategories: 並び替え後に追加したカテゴリは従来どおり末尾に付く', () => {
  const { context } = loadGasScript();
  const original = callDoGetCategories(context).categories;
  const reordered = original.slice().reverse();
  callDoPost(context, { action: 'reorderCategories', categories: reordered });

  const result = callDoPost(context, { action: 'addCategory', name: '新しいカテゴリ' });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.categories, reordered.concat(['新しいカテゴリ']));
});

// ---- 一覧APIのページング(50件区切り + offset) ------------------------

test('一覧API: 50件を超える保存がある場合、先頭ページは新しい順50件 + hasMore:true になる', () => {
  const { context } = loadGasScript({
    fetchImpl: (url) => makeFetchResponse({ body: '<title>記事' + url.split('/').pop() + '</title>' })
  });
  // 55件保存する（記事0が最古、記事54が最新）
  for (let i = 0; i < 55; i++) {
    const r = callDoPost(context, { url: 'https://example.com/' + i, category: 'PC系' });
    assert.strictEqual(r.ok, true, i + '件目の保存が成功すること');
  }

  const page1 = callDoGetList(context, 'PC系');
  assert.strictEqual(page1.ok, true);
  assert.strictEqual(page1.items.length, 50, '先頭ページは50件で区切られる');
  assert.strictEqual(page1.hasMore, true, '続きがあることを示すフラグが立つ');
  assert.strictEqual(page1.items[0].title, '記事54', '最新の保存が先頭に来る');
  assert.strictEqual(page1.items[49].title, '記事5', '50件目は新しい順で50番目');
});

test('一覧API: offset指定で続きのページが取得でき、最後のページは hasMore:false になる', () => {
  const { context } = loadGasScript({
    fetchImpl: (url) => makeFetchResponse({ body: '<title>記事' + url.split('/').pop() + '</title>' })
  });
  for (let i = 0; i < 55; i++) {
    callDoPost(context, { url: 'https://example.com/' + i, category: 'PC系' });
  }

  const page2 = callDoGetList(context, 'PC系', undefined, '50');
  assert.strictEqual(page2.ok, true);
  assert.strictEqual(page2.items.length, 5, '2ページ目は残りの5件');
  assert.strictEqual(page2.hasMore, false, '最後のページではフラグが下りる');
  assert.strictEqual(page2.items[0].title, '記事4');
  assert.strictEqual(page2.items[4].title, '記事0', '最古の保存が末尾に来る');
});

test('一覧API: offsetが不正な値（負数・文字列）の場合は先頭ページとして扱う', () => {
  const { context } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>1件だけ</title>' })
  });
  callDoPost(context, { url: 'https://example.com/only', category: 'PC系' });

  for (const bad of ['-5', 'abc', '']) {
    const result = callDoGetList(context, 'PC系', undefined, bad);
    assert.strictEqual(result.ok, true, 'offset=' + JSON.stringify(bad) + ' でもエラーにしない');
    assert.strictEqual(result.items.length, 1);
    assert.strictEqual(result.hasMore, false);
  }
});

// ---- ルートフォルダIDのキャッシュ（カテゴリ・一覧APIの高速化） --------

test('ルートフォルダ: 一度アクセスするとIDがスクリプトプロパティに記憶される', () => {
  const { context } = loadGasScript();
  callDoGetCategories(context);
  const props = context.PropertiesService.getScriptProperties();
  assert.ok(props.getProperty('ROOT_FOLDER_ID'), 'ROOT_FOLDER_IDが保存されること');
});

test('ルートフォルダ: 記憶されたIDのフォルダが消えていても名前検索にフォールバックして復旧する', () => {
  const { context, rootFolder } = loadGasScript({
    scriptProperties: { ROOT_FOLDER_ID: 'folder-존재しないID' }
  });
  const result = callDoGetCategories(context);
  assert.strictEqual(result.ok, true, '古いIDが無効でもエラーにならない');
  assert.strictEqual(rootFolder.subFolders.length, 1, 'ナレッジフォルダが作られる');
  const props = context.PropertiesService.getScriptProperties();
  assert.strictEqual(
    props.getProperty('ROOT_FOLDER_ID'), rootFolder.subFolders[0].getId(),
    '正しいIDに更新されること'
  );
});

test('ルートフォルダ: IDキャッシュ利用時もフォルダが二重に作られない', () => {
  const { context, rootFolder } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>a</title>' })
  });
  callDoPost(context, { url: 'https://example.com/1', category: 'PC系' });
  callDoGetCategories(context);
  callDoGetList(context, 'PC系');
  callDoPost(context, { url: 'https://example.com/2', category: 'PC系' });

  const knowledgeFolders = rootFolder.subFolders.filter((f) => f.name === 'ナレッジ');
  assert.strictEqual(knowledgeFolders.length, 1, '「ナレッジ」フォルダは1つだけ');
});

// ---- 記事の編集（action=update）とその補助関数 ------------------------

test('fileId抽出: Driveファイル列のHYPERLINK数式からfileIdを取り出せる', () => {
  const { context } = loadGasScript();
  assert.strictEqual(
    context.extractFileIdFromFormula_('=HYPERLINK("https://docs.google.com/document/d/ABC_12-3/edit","開く")'),
    'ABC_12-3'
  );
  assert.strictEqual(context.extractFileIdFromFormula_(''), '', '数式なしは空文字');
  assert.strictEqual(context.extractFileIdFromFormula_(null), '', 'nullも空文字');
  assert.strictEqual(
    context.extractFileIdFromFormula_('=HYPERLINK("https://example.com/","開く")'),
    '', 'ドキュメントURL形式でない数式は空文字'
  );
});

test('Doc本文抽出: 共有時のURL行と本文（自動抽出・参考）節を取り出せる（無ければ空文字）', () => {
  const { context } = loadGasScript();
  const docText = [
    '# 旧タイトル',
    '',
    '- URL: https://old.example.com/a',
    '- 共有時のURL（短縮/リダイレクト元）: https://share.google/xyz',
    '- 保存日時: 2026-07-01 10:00',
    '- カテゴリ: PC系',
    '',
    '## 本文（自動抽出・参考）',
    '',
    'これは抽出された本文です。',
    ''
  ].join('\n');

  assert.strictEqual(context.extractDocOriginalUrl_(docText), 'https://share.google/xyz');
  assert.strictEqual(context.extractDocBodyText_(docText), 'これは抽出された本文です。');
  assert.strictEqual(context.extractDocOriginalUrl_('# タイトルのみ'), '', '共有時URL行が無ければ空文字');
  assert.strictEqual(context.extractDocBodyText_('# タイトルのみ'), '', '本文節が無ければ空文字');
});

test('Doc再構築: タイトル・URL・メモを差し替えつつ、共有時URLと自動抽出本文は引き継ぐ', () => {
  const { context } = loadGasScript();
  const currentText = [
    '# 旧タイトル',
    '',
    '- URL: https://old.example.com/a',
    '- 共有時のURL（短縮/リダイレクト元）: https://share.google/xyz',
    '- 保存日時: 2026-07-01 10:00',
    '- カテゴリ: PC系',
    '',
    '## 本文（自動抽出・参考）',
    '',
    'これは抽出された本文です。',
    ''
  ].join('\n');

  const rebuilt = context.rebuildDocContent_(
    currentText, '2026-07-01 10:00', 'PC系', '新タイトル', 'https://new.example.com/b', '新メモ'
  );

  assert.match(rebuilt, /^# 新タイトル$/m, 'タイトルが差し替わること');
  assert.match(rebuilt, /^- URL: https:\/\/new\.example\.com\/b$/m, 'URLが差し替わること');
  assert.match(rebuilt, /^- 共有時のURL（短縮\/リダイレクト元）: https:\/\/share\.google\/xyz$/m, '共有時URLを引き継ぐこと');
  assert.match(rebuilt, /^- 保存日時: 2026-07-01 10:00$/m, '保存日時は変えないこと');
  assert.match(rebuilt, /^- カテゴリ: PC系$/m, 'カテゴリは変えないこと');
  assert.match(rebuilt, /## メモ\n\n新メモ/, 'メモが差し替わること');
  assert.match(rebuilt, /## 本文（自動抽出・参考）\n\nこれは抽出された本文です。/, '自動抽出本文を引き継ぐこと');
  assert.doesNotMatch(rebuilt, /旧タイトル|旧メモ/, '旧の編集対象値が残らないこと');
});

test('編集API正常系: 一覧のfileIdで更新でき、Sheets行とDoc本文の両方に反映される', () => {
  const { context, spreadsheetsById } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>元のタイトル</title>' })
  });
  callDoPost(context, { url: 'https://example.com/old', category: 'PC系', memo: '元メモ' });

  const listed = callDoGetList(context, 'PC系');
  const fileId = listed.items[0].fileId;
  assert.ok(fileId, '一覧APIが編集キーのfileIdを返すこと');

  const result = callDoPost(context, {
    action: 'update', fileId: fileId,
    title: '新タイトル', url: 'https://example.com/new', memo: '新メモ'
  });
  assert.strictEqual(result.ok, true);

  // 別レイヤー確認1: 一覧APIの返却値に反映されている
  const after = callDoGetList(context, 'PC系');
  assert.strictEqual(after.items[0].title, '新タイトル');
  assert.strictEqual(after.items[0].url, 'https://example.com/new');
  assert.strictEqual(after.items[0].memo, '新メモ');
  assert.strictEqual(after.items[0].fileId, fileId, 'fileIdは変わらないこと');

  // 別レイヤー確認2: Sheetsのタイトル列はHYPERLINK数式のまま新URLを指す
  const sheet = Object.values(spreadsheetsById)[0]._sheet;
  assert.strictEqual(
    sheet._formulas[1][2],
    '=HYPERLINK("https://example.com/new","新タイトル")'
  );

  // 別レイヤー確認3: Googleドキュメント本文も更新される（保存日時・カテゴリは保持）
  const docText = context.DocumentApp.openById(fileId).getBody().getText();
  assert.match(docText, /^# 新タイトル$/m);
  assert.match(docText, /^- URL: https:\/\/example\.com\/new$/m);
  assert.match(docText, /^- カテゴリ: PC系$/m);
  assert.match(docText, /## メモ\n\n新メモ/);
});

test('編集API異常系: fileId無し・未知のfileId・タイトル空・URL形式不正はエラーになる', () => {
  const { context } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>元のタイトル</title>' })
  });
  callDoPost(context, { url: 'https://example.com/old', category: 'PC系' });
  const fileId = callDoGetList(context, 'PC系').items[0].fileId;

  const cases = [
    [{ action: 'update', title: 't', url: 'https://a.example/' }, '編集対象が指定されていません'],
    [{ action: 'update', fileId: 'doc-存在しない', title: 't', url: 'https://a.example/' }, '編集対象の記事が見つかりません'],
    [{ action: 'update', fileId: fileId, title: '', url: 'https://a.example/' }, 'タイトルを入力してください'],
    [{ action: 'update', fileId: fileId, title: 't', url: 'ftp://a.example/' }, 'URLの形式が不正です']
  ];
  for (const [body, message] of cases) {
    const result = callDoPost(context, body);
    assert.strictEqual(result.ok, false, JSON.stringify(body) + ' はエラーになること');
    assert.match(result.error, new RegExp(message));
  }
});

test('編集API認可: SHARED_TOKEN設定時、合言葉が違うupdateは拒否される', () => {
  const { context } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>元のタイトル</title>' }),
    scriptProperties: { SHARED_TOKEN: 'aikotoba' }
  });
  callDoPost(context, { url: 'https://example.com/old', category: 'PC系', token: 'aikotoba' });
  const fileId = callDoGetList(context, 'PC系', 'aikotoba').items[0].fileId;

  const denied = callDoPost(context, {
    action: 'update', fileId: fileId, title: '改ざん', url: 'https://evil.example/', token: 'ちがう'
  });
  assert.strictEqual(denied.ok, false);
  assert.match(denied.error, /合言葉が一致しません/);

  const allowed = callDoPost(context, {
    action: 'update', fileId: fileId, title: '正規の編集', url: 'https://example.com/new', token: 'aikotoba'
  });
  assert.strictEqual(allowed.ok, true);
});

test('編集API防御: メモの数式インジェクションはサニタイズされ、タイトルの引用符は数式内でエスケープされる', () => {
  const { context, spreadsheetsById } = loadGasScript({
    fetchImpl: () => makeFetchResponse({ body: '<title>元のタイトル</title>' })
  });
  callDoPost(context, { url: 'https://example.com/old', category: 'PC系' });
  const fileId = callDoGetList(context, 'PC系').items[0].fileId;

  const result = callDoPost(context, {
    action: 'update', fileId: fileId,
    title: '新"タイトル"', url: 'https://example.com/new', memo: '=IMPORTXML("https://evil.example/","//a")'
  });
  assert.strictEqual(result.ok, true);

  const sheet = Object.values(spreadsheetsById)[0]._sheet;
  assert.strictEqual(
    sheet._rows[1][4], "'=IMPORTXML(\"https://evil.example/\",\"//a\")",
    'メモ先頭の = はアポストロフィで無害化されること'
  );
  assert.strictEqual(
    sheet._formulas[1][2],
    '=HYPERLINK("https://example.com/new","新""タイトル""")',
    'タイトル内の引用符は数式リテラル内でエスケープされること'
  );
});

// ---- 新規追加関数の重複定義チェック（教訓の再発防止パターン） ----------

test('Code.gs: 主要関数の定義がそれぞれちょうど1つである（重複定義の再発防止）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');
  for (const fn of ['handleReorderCategories_', 'getOrCreateRootFolder_', 'handleList_', 'getOrCreateIndexSheet_', 'appendIndexRow_', 'doGet', 'doPost', 'handleUpdate_', 'extractFileIdFromFormula_', 'rebuildDocContent_', 'extractDocOriginalUrl_', 'extractDocBodyText_']) {
    const definitions = source.match(new RegExp('function ' + fn + '\\(', 'g')) || [];
    assert.strictEqual(definitions.length, 1, fn + ' の定義がちょうど1つであること');
  }
});
