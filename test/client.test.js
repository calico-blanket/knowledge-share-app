// ============================================================
// index.html 内のクライアントロジックの自動テスト
//
//   index.html の @shared-logic-start / -end マーカーで囲まれた
//   parseSharedParams（本物のコード）を切り出して Node 上で検証する。
//   Android 共有シートの「URLがどのパラメータに入るか」の揺れを
//   吸収できているかが焦点。
//
//   実行方法: node --test test/
// ============================================================

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// index.html からマーカー区間のコードを切り出して評価する
function loadSharedLogic() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const match = html.match(/\/\/ @shared-logic-start([\s\S]*?)\/\/ @shared-logic-end/);
  assert.ok(match, 'index.html に @shared-logic マーカーが存在すること');

  // URLSearchParams は Node のグローバルをそのまま使う
  const context = { URLSearchParams };
  vm.createContext(context);
  vm.runInContext(match[1], context);
  assert.strictEqual(typeof context.parseSharedParams, 'function');
  return context.parseSharedParams;
}

const parseSharedParams = loadSharedLogic();

test('shared_url にURLが入っている場合（標準形）', () => {
  const result = parseSharedParams('?shared_url=' + encodeURIComponent('https://example.com/article'));
  assert.strictEqual(result.url, 'https://example.com/article');
  assert.strictEqual(result.memo, '');
});

test('Chrome形式: shared_text にタイトルとURLが混在する場合', () => {
  // Android Chrome は「ページタイトル URL」形式で text に入れることが多い
  const text = '面白い記事のタイトル https://example.com/news/123';
  const result = parseSharedParams('?shared_text=' + encodeURIComponent(text));
  assert.strictEqual(result.url, 'https://example.com/news/123');
  assert.strictEqual(result.memo, '面白い記事のタイトル');
});

test('shared_title にしかURLが無い場合も拾える', () => {
  const result = parseSharedParams('?shared_title=' + encodeURIComponent('https://example.com/t'));
  assert.strictEqual(result.url, 'https://example.com/t');
});

test('クエリ文字列が空ならURLもメモも空', () => {
  const result = parseSharedParams('');
  assert.strictEqual(result.url, '');
  assert.strictEqual(result.memo, '');
});

test('URLを含まない共有（テキストのみ）ではURLは空になる', () => {
  const result = parseSharedParams('?shared_text=' + encodeURIComponent('ただのメモ書き'));
  assert.strictEqual(result.url, '');
});

test('日本語を含むURLエンコード済みのクエリも正しく復元される', () => {
  const url = 'https://example.jp/記事/テスト?id=1&lang=ja';
  const result = parseSharedParams('?shared_url=' + encodeURIComponent(url));
  assert.strictEqual(result.url, url);
});

test('shared_url と shared_text が両方ある場合は shared_url を優先し、text はメモになる', () => {
  const query = '?shared_url=' + encodeURIComponent('https://example.com/a') +
    '&shared_text=' + encodeURIComponent('あとで読む');
  const result = parseSharedParams(query);
  assert.strictEqual(result.url, 'https://example.com/a');
  assert.strictEqual(result.memo, 'あとで読む');
});

test('http:// のURLも受け付ける', () => {
  const result = parseSharedParams('?shared_text=' + encodeURIComponent('http://old-site.example/page'));
  assert.strictEqual(result.url, 'http://old-site.example/page');
});

test('カテゴリ一覧: index.html と gas/Code.gs の CATEGORIES が完全一致する', () => {
  // 片方だけ変更してカテゴリがズレる事故を防ぐ整合性チェック
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const gas = fs.readFileSync(path.join(__dirname, '..', 'gas', 'Code.gs'), 'utf8');

  const extract = (source, label) => {
    const m = source.match(/var CATEGORIES = \[([\s\S]*?)\]/);
    assert.ok(m, label + ' に CATEGORIES 定義があること');
    return m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  };

  const htmlCategories = extract(html, 'index.html');
  const gasCategories = extract(gas, 'gas/Code.gs');
  assert.deepStrictEqual(htmlCategories, gasCategories);
  assert.strictEqual(htmlCategories.length, 10, 'カテゴリは10件');
});
