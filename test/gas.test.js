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
    }
  };
  return folder;
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

  const context = {
    // --- DriveApp スタブ ---
    DriveApp: {
      getRootFolder: () => rootFolder
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
    // --- PropertiesService スタブ ---
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => (options.scriptProperties || {})[key] || null
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

  return { context, rootFolder, fetchCalls };
}

/** doPost をJSONボディ付きで呼び、レスポンスJSONをパースして返す */
function callDoPost(context, bodyObj) {
  const e = { postData: { contents: JSON.stringify(bodyObj) } };
  const output = context.doPost(e);
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
  assert.match(result.fileName, /^\d{4}-\d{2}-\d{2}_テスト記事のタイトル\.md$/);
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
  assert.match(files[1].name, /^\d{4}-\d{2}-\d{2}_\d{6}_同じタイトル\.md$/);
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
  assert.strictEqual(context.buildFileName_('2026-07-12', ''), '2026-07-12_無題.md');
});

test('buildFileName_: 長すぎるタイトルは切り詰められる', () => {
  const { context } = loadGasScript();
  const longTitle = 'あ'.repeat(200);
  const name = context.buildFileName_('2026-07-12', longTitle);
  assert.ok(name.length < 100, '切り詰め後のファイル名が十分短い: ' + name.length);
  assert.match(name, /…\.md$/);
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
