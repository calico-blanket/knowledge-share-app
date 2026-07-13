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
  assert.strictEqual(typeof context.moveArrayItem, 'function');
  return context;
}

const sharedLogic = loadSharedLogic();
const parseSharedParams = sharedLogic.parseSharedParams;
const moveArrayItem = sharedLogic.moveArrayItem;

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
  // 保存表示後、一定時間でmainViewへ戻る処理があること
  // （送信失敗のエラー表示に切り替わっていた場合は上書きしないガード付き）
  const m = html.match(/setTimeout\(function \(\) \{([\s\S]*?)\}, 1200\)/);
  assert.ok(m, '1200ms後の画面遷移処理が存在すること');
  assert.match(m[1], /showView\('mainView'\)/);
  assert.match(m[1], /doneView/, 'doneView表示中のみ戻るガードがあること');
});

test('終了ボタン: クリックでwindow.close()を呼ぶ', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/getElementById\('exitButton'\)\.addEventListener\('click', function \(\) \{([\s\S]*?)\}\);/);
  assert.ok(m, '終了ボタンのクリックハンドラが存在すること');
  assert.match(m[1], /window\.close\(\)/, 'ハンドラ内でwindow.close()を呼んでいること');
});

test('XSS対策: 一覧描画がHTML文字列結合ではなくDOM APIで組み立てられている', () => {
  // 文字列結合+escapeHtmlでは、URL内の引用符による属性breakoutを防げない
  // （escapeHtmlはダブルクォートをエスケープしない）ため、DOM APIで構築する。
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /href="' \+ escapeHtml/, '旧実装(文字列結合href)が復活していないこと');

  const m = html.match(/function renderListItems\(items, hasMore\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'renderListItems関数が存在すること');
  assert.match(m[1], /createElement\('a'\)/, 'DOM APIでリンクを生成していること');
  assert.match(m[1], /textContent/, 'テキストはtextContentで設定していること');
  assert.match(m[1], /\^https\?:/, 'hrefに設定する前にURLスキームを検証していること');
});

test('GET保護: gasGetがtokenパラメータを付与している', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function gasGet\(action, extraParams\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'gasGet関数が存在すること');
  assert.match(m[1], /searchParams\.set\('token'/, 'GETリクエストにもtokenを含めること');
});

// ---- 改善1: 保存の fire-and-forget（keepalive + sendBeacon） --------

test('保存の高速化: fetchにkeepalive:trueが付いている（送信後にPWAを閉じても送信が完了する）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function submitToGas\(url, category, memo\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'submitToGas関数が存在すること');
  assert.match(m[1], /keepalive: true/, 'fetchにkeepalive:trueを指定していること');
  assert.doesNotMatch(m[1], /await gasPost/, '応答を待つ旧実装(await gasPost)が復活していないこと');
});

test('保存の高速化: keepalive非対応環境向けに navigator.sendBeacon フォールバックがある', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function submitToGas\(url, category, memo\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'submitToGas関数が存在すること');
  assert.match(m[1], /navigator\.sendBeacon/, 'sendBeaconフォールバックがあること');
  assert.match(m[1], /text\/plain;charset=utf-8/, 'CORSプリフライトを避けるtext/plainで送ること');
});

test('保存の高速化: 送信失敗時の案内メッセージが仕様どおり表示される', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /保存できませんでした。通信環境を確認してください/);
  // オフラインの事前検知（navigator.onLine）も行うこと
  assert.match(html, /navigator\.onLine === false/);
});

test('保存の高速化: 応答待ち専用の送信中ビュー(sendingView)が廃止されている', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /sendingView/);
});

// ---- 改善2・3: カテゴリ・記事一覧の localStorage キャッシュ ----------

test('キャッシュ: カテゴリ・記事一覧のキャッシュキーが定義され、SWR共通関数が使われている', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /var CATEGORIES_CACHE_KEY = /);
  assert.match(html, /var LIST_CACHE_KEY = /);
  // メイン画面・一覧カテゴリ画面・設定画面のカテゴリ描画がSWR共通関数経由であること
  const calls = html.match(/renderCategoriesWithRevalidate\(/g) || [];
  assert.ok(calls.length >= 4, 'SWR共通関数が定義され、3画面以上から呼ばれていること（実際: ' + calls.length + '箇所）');
});

test('キャッシュ: fetchCategories成功時にカテゴリキャッシュが保存される', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function fetchCategories\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'fetchCategories関数が存在すること');
  assert.match(m[1], /saveCategoriesCache\(\)/);
});

test('キャッシュ: 記事一覧はキャッシュ即描画→裏で取得の順で処理される', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function openListItemsView\(category\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'openListItemsView関数が存在すること');
  const body = m[1];
  const cacheRenderPos = body.indexOf('renderListItems(cached.items');
  const fetchPos = body.indexOf("gasGet('list'");
  assert.ok(cacheRenderPos !== -1, 'キャッシュからの即描画があること');
  assert.ok(fetchPos !== -1, 'GASからの取得があること');
  assert.ok(cacheRenderPos < fetchPos, 'キャッシュ描画が取得より先であること');
});

test('ページング: 続きがある場合の「さらに読み込む」ボタンとoffset付き取得がある', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /さらに読み込む/);
  assert.match(html, /offset: state\.listItems\.length/);
});

// ---- 改善4: カテゴリの並び替え（moveArrayItem 純粋関数 + ↑↓ボタン） --

test('moveArrayItem: 要素を1つ上へ移動できる（元の配列は破壊しない）', () => {
  const original = ['A', 'B', 'C'];
  const result = moveArrayItem(original, 1, -1);
  assert.deepStrictEqual(result, ['B', 'A', 'C']);
  assert.deepStrictEqual(original, ['A', 'B', 'C'], '元の配列が変更されないこと');
});

test('moveArrayItem: 要素を1つ下へ移動できる', () => {
  assert.deepStrictEqual(moveArrayItem(['A', 'B', 'C'], 1, 1), ['A', 'C', 'B']);
});

test('moveArrayItem: 先頭をさらに上へ・末尾をさらに下へは何も起きない', () => {
  assert.deepStrictEqual(moveArrayItem(['A', 'B'], 0, -1), ['A', 'B']);
  assert.deepStrictEqual(moveArrayItem(['A', 'B'], 1, 1), ['A', 'B']);
});

test('moveArrayItem: 範囲外indexでも例外を投げず元と同じ内容を返す', () => {
  assert.deepStrictEqual(moveArrayItem(['A'], 5, -1), ['A']);
  assert.deepStrictEqual(moveArrayItem([], 0, 1), []);
});

test('並び替えUI: ↑↓ボタンがあり、reorderCategoriesアクションをGASへ送る', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function renderCategoryManageList\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'renderCategoryManageList関数が存在すること');
  assert.match(m[1], /'↑'/);
  assert.match(m[1], /'↓'/);
  assert.match(html, /action: 'reorderCategories'/, '並び順の保存はGAS側に永続化すること');
});
