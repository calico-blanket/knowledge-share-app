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

test('カテゴリ管理: index.html にカテゴリのハードコード配列が無い（GASから動的取得する設計を保つ）', () => {
  // 以前は index.html 側にも固定のカテゴリ配列があり、GAS側と手動で同期する必要があった。
  // 今はカテゴリをGASのスクリプトプロパティで一元管理し、PWAは起動時に action=categories で
  // 取得する設計に変更したため、index.html に固定配列が復活していないことを回帰確認する。
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /var CATEGORIES\s*=\s*\[/);
  assert.match(html, /fetchCategories/, 'カテゴリを動的取得する関数が存在すること');
  assert.match(html, /gasGet\('categories'\)/, 'GASのcategoriesエンドポイントを呼んでいること');
});

test('新機能のUI要素: 一覧・カテゴリ管理・Driveショートカット・終了ボタンに必要なDOM idが揃っている', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  var requiredIds = [
    'driveShortcutButton', 'listButton', 'listCategoryView', 'listCategoryGrid',
    'listItemsView', 'listItemsContainer', 'categoryManageSection', 'categoryManageList',
    'newCategoryInput', 'addCategoryButton', 'titleHintRow', 'titleHintText', 'exitButton'
  ];
  requiredIds.forEach(function (id) {
    assert.match(html, new RegExp('id="' + id + '"'), 'id="' + id + '" が存在すること');
  });
});

test('保存後の画面遷移: 自動でwindow.close()せず、トップ画面(mainView)に戻る', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  // 旧仕様（保存成功後に自動でウィンドウを閉じる）が復活していないことの回帰確認
  assert.doesNotMatch(html, /setTimeout\(function \(\) \{ window\.close\(\); \}/);
  // 保存成功後、doneViewを一定時間表示してからmainViewへ戻る処理があること
  assert.match(html, /setTimeout\(function \(\) \{ showView\('mainView'\); \}, 1200\)/);
});

test('終了ボタン: クリックでwindow.close()を呼ぶ', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/getElementById\('exitButton'\)\.addEventListener\('click', function \(\) \{([\s\S]*?)\}\);/);
  assert.ok(m, '終了ボタンのクリックハンドラが存在すること');
  assert.match(m[1], /window\.close\(\)/, 'ハンドラ内でwindow.close()を呼んでいること');
});
