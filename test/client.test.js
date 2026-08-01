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
  assert.strictEqual(typeof context.buildUpdatePayload, 'function');
  return context;
}

const sharedLogic = loadSharedLogic();
const parseSharedParams = sharedLogic.parseSharedParams;
const moveArrayItem = sharedLogic.moveArrayItem;
const buildUpdatePayload = sharedLogic.buildUpdatePayload;

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
  const m = html.match(/function submitToGas\(url, category, memo, tags\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'submitToGas関数が存在すること');
  assert.match(m[1], /keepalive: true/, 'fetchにkeepalive:trueを指定していること');
  assert.doesNotMatch(m[1], /await gasPost/, '応答を待つ旧実装(await gasPost)が復活していないこと');
});

test('保存の高速化: keepalive非対応環境向けに navigator.sendBeacon フォールバックがある', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function submitToGas\(url, category, memo, tags\) \{([\s\S]*?)\n    \}/);
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


// ---- PC対応1: URL+メモ手入力フォーム ---------------------------------

test('PC手入力: URL欄とメモ欄の両方があり、getCurrentMemoで手入力メモを取得できる', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="manualUrlInput"/);
  assert.match(html, /id="manualMemoInput"/);
  assert.match(html, /function getCurrentMemo\(\)/, '手入力メモ取得関数があること');
  assert.match(html, /getElementById\('manualInputArea'\)\.classList\.remove\('hidden'\)/);
});

test('確定ボタン押下時: URL形式・カテゴリ選択済みを検証し、メモ・タグとともに保存する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function handleMainConfirm\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'handleMainConfirm関数が存在すること');
  assert.match(m[1], /\^https\?:/, '手入力URLのスキームを検証すること');
  assert.match(m[1], /state\.selectedCategory/, 'カテゴリが選択済みかを検証すること');
  assert.match(
    m[1], /submitToGas\(url, state\.selectedCategory, getCurrentMemo\(\), getCurrentTags\(\)\)/,
    'メモ・タグを渡して保存すること'
  );
});

// ---- PC対応3: 記事の編集 --------------------------------------------

test('編集UI: 編集ビューと入力欄に必要なDOM idが揃っている', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ['editView', 'editTitleInput', 'editUrlInput', 'editMemoInput', 'editSaveButton', 'editBackButton'].forEach(function (id) {
    assert.match(html, new RegExp('id="' + id + '"'), 'id="' + id + '" が存在すること');
  });
  assert.match(html, /VIEW_IDS = \[[\s\S]*?'editView'[\s\S]*?\]/);
});

test('編集UI: 一覧の各記事にidかfileIdがあれば編集ボタンを生成する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function renderListItems\(items, hasMore\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'renderListItems関数が存在すること');
  assert.match(m[1], /if \(item\.id \|\| item\.fileId\)/, 'idかfileIdがある記事だけ編集可能にすること');
  assert.match(m[1], /openEditView\(item\)/, '編集ボタンで編集ビューを開くこと');
  assert.match(m[1], /createElement\('button'\)/, '編集ボタンをDOM APIで生成すること');
});

test('編集UI: submitEditがbuildUpdatePayloadで組み立てたupdateアクションをGASへ送り、成功後にキャッシュを破棄して再取得する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function submitEdit\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'submitEdit関数が存在すること');
  assert.match(m[1], /buildUpdatePayload\(item, title, url, memo, tags\)/, 'ペイロードは共通の純粋関数で組み立てること');
  assert.match(m[1], /\^https\?:/, 'URL形式を検証すること');
  assert.match(m[1], /invalidateListCache/, '編集後にキャッシュを破棄すること');
  assert.match(m[1], /await openListItemsView/, '編集後に一覧を取り直すこと');
});

// ---- 編集UI: タグ選択チップ --------------------------------------------

test('編集UI: 編集モーダルにタグ選択チップ用のコンテナがあり、メモ欄の直後・注記の前に配置される', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="editTagGrid"/, 'タグ選択チップ用のコンテナがあること');
  const view = html.match(/<div id="editView"[\s\S]*?<\/div>\s*<\/div>/);
  assert.ok(view, 'editViewが存在すること');
  const memoIdx = view[0].indexOf('id="editMemoInput"');
  const tagIdx = view[0].indexOf('id="editTagGrid"');
  const noteIdx = view[0].indexOf('class="note"');
  assert.ok(memoIdx < tagIdx && tagIdx < noteIdx, 'メモ欄の直後・保存日時等の注記の前にタグ選択が配置されること');
});

test('編集UI: openEditViewは対象記事のtagsをstate.editSelectedTagsへコピーしてタグチップを描画する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function openEditView\(item\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'openEditView関数が存在すること');
  assert.match(m[1], /state\.editSelectedTags = \(item\.tags \|\| \[\]\)\.slice\(\)/, '記事のtagsを複製して初期選択状態にすること（元配列を破壊しない）');
  assert.match(m[1], /renderEditTagButtons\(\)/, 'タグチップを描画すること');
});

test('編集UI: renderEditTagButtonsは選択中タグをtag-button-selectedでハイライトし、タップでtoggleEditTagを呼ぶ', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function renderEditTagButtons\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'renderEditTagButtons関数が存在すること');
  assert.match(m[1], /state\.editSelectedTags\.indexOf\(tag\)/, '選択中タグをstate.editSelectedTagsで判定すること');
  assert.match(m[1], /tag-button-selected/, '選択中タグをハイライトすること');
  assert.match(m[1], /toggleEditTag\(tag\)/, 'タップでtoggleEditTagを呼ぶこと');
});

test('編集UI: toggleEditTagはタグの選択/選択解除を切り替えて再描画する（複数選択可）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function toggleEditTag\(tag\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'toggleEditTag関数が存在すること');
  assert.match(m[1], /state\.editSelectedTags\.push\(tag\)/, '未選択なら追加すること');
  assert.match(m[1], /state\.editSelectedTags\.splice\(index, 1\)/, '選択済みなら除去すること');
  assert.match(m[1], /renderEditTagButtons\(\)/, '切り替え後に再描画すること');
});

test('編集UI: submitEditはstate.editSelectedTagsをtagsとしてbuildUpdatePayloadへ渡す', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function submitEdit\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'submitEdit関数が存在すること');
  assert.match(m[1], /var tags = state\.editSelectedTags/, '選択中タグをペイロード組み立てに使うこと');
});

// ---- 記事編集の送信キー選択（buildUpdatePayload 純粋関数） -------------

test('buildUpdatePayload: idのみ持つ記事（新規保存）はidをキーに送る', () => {
  const payload = buildUpdatePayload(
    { id: 'uuid-1', fileId: '' }, '新タイトル', 'https://example.com/new', 'メモ', ['タグA']
  );
  // vm(別レルム)のオブジェクトはprototypeが異なるため、同レルムへコピーしてから比較する
  assert.deepStrictEqual(Object.assign({}, payload), {
    action: 'update', title: '新タイトル', url: 'https://example.com/new', memo: 'メモ',
    tags: ['タグA'], id: 'uuid-1'
  });
  assert.strictEqual('fileId' in payload, false, 'fileIdは送らないこと');
});

test('buildUpdatePayload: fileIdを持つ既存Docs記事はfileIdをキーに送る（Doc本文の同期を維持する従来動作）', () => {
  const payload = buildUpdatePayload(
    { id: 'uuid-2', fileId: 'doc-1' }, 't', 'https://example.com/', '', []
  );
  assert.deepStrictEqual(Object.assign({}, payload), {
    action: 'update', title: 't', url: 'https://example.com/', memo: '', tags: [], fileId: 'doc-1'
  });
  assert.strictEqual('id' in payload, false, 'idを併記するとGAS側がDoc更新をスキップするため送らないこと');
});

test('buildUpdatePayload: id・fileIdのどちらも無い（旧キャッシュ由来）記事はnullを返す', () => {
  assert.strictEqual(buildUpdatePayload({ id: '', fileId: '' }, 't', 'https://a/', '', []), null);
  assert.strictEqual(buildUpdatePayload({}, 't', 'https://a/', '', []), null);
  assert.strictEqual(buildUpdatePayload(null, 't', 'https://a/', '', []), null);
});

test('buildUpdatePayload: tagsに空配列を渡すと全クリアの意図でtags:[]がそのまま送られる（未指定=保持とは区別する）', () => {
  const payload = buildUpdatePayload({ id: 'uuid-3', fileId: '' }, 't', 'https://a/', '', []);
  assert.deepStrictEqual(Array.from(payload.tags), []);
});

test('編集UI: 編集は fire-and-forget にせず応答を待つ（gasPostをawaitする）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function submitEdit\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'submitEdit関数が存在すること');
  assert.match(m[1], /await gasPost\(/, '編集は応答を待って結果を反映すること');
});

// ---- PC対応4: レスポンシブ -------------------------------------------

test('レスポンシブ: PC幅向けのメディアクエリがあり、スマホ既定スタイルは維持される', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /main \{ padding: 16px; max-width: 480px;/, 'スマホ既定のmain幅が維持されていること');
  assert.match(html, /@media \(min-width: 600px\)/, 'PC幅向けメディアクエリがあること');
  const mq = html.match(/@media \(min-width: 600px\) \{([\s\S]*?)\n    \}/);
  assert.ok(mq, 'メディアクエリの中身が取得できること');
  assert.match(mq[1], /max-width: 720px/, 'PC幅ではコンテンツ幅を広げること');
});

// ---- メモ確定フロー: カテゴリタップでは保存せず、確定ボタンで保存する ---

test('メモ欄: 共有・手動どちらのモードでも常に表示される（manualInputAreaの外にある）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const manualArea = html.match(/<div id="manualInputArea"[\s\S]*?<\/div>/);
  assert.ok(manualArea, 'manualInputAreaが存在すること');
  assert.doesNotMatch(manualArea[0], /id="manualMemoInput"/, 'メモ欄はmanualInputAreaの外に出ていること（常に表示するため）');
  assert.match(html, /id="manualMemoInput"/, 'メモ欄自体は存在すること');
});

test('メモ欄: 共有テキストから検出した内容がメモ欄の初期値として入る', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function init\(\) \{([\s\S]*?)\n\s*init\(\);/);
  assert.ok(m, 'init関数が存在すること');
  assert.match(
    m[1], /getElementById\('manualMemoInput'\)\.value = shared\.memo/,
    '共有検出テキストをメモ欄へ初期値としてセットすること'
  );
});

test('カテゴリタップでは即保存せず、選択状態にするだけ（selectMainCategory）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function renderMainCategoryButtons\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'renderMainCategoryButtons関数が存在すること');
  assert.match(m[1], /selectMainCategory\(category\)/, 'タップ時はselectMainCategoryを呼ぶこと（即submitToGasしない）');
  assert.doesNotMatch(m[1], /submitToGas/, 'カテゴリボタンのハンドラが直接保存しないこと');
});

test('確定ボタン: カテゴリ未選択のときはdisabledになる', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="mainConfirmButton"[^>]*disabled/, '初期状態はdisabledであること');
  const m = html.match(/function updateMainConfirmButtonState\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'updateMainConfirmButtonState関数が存在すること');
  assert.match(m[1], /!state\.selectedCategory/, 'カテゴリ未選択かどうかで有効\/無効を切り替えること');
});

test('保存完了後、選択状態とメモ欄がリセットされる（resetMainSelection）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /function resetMainSelection\(\) \{/, 'resetMainSelection関数が存在すること');
  const m = html.match(/setTimeout\(function \(\) \{([\s\S]*?)\}, 1200\)/);
  assert.ok(m, '保存後の遷移処理が存在すること');
  assert.match(m[1], /resetMainSelection\(\)/, '保存完了後にリセットすること');
});

// ---- タグ複数選択UI ----------------------------------------------------

test('タグUI: タグボタンの複数選択チップが描画され、確定時にsubmitToGasへ渡される', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="tagGrid"/, 'タグ表示用のコンテナがあること');
  const render = html.match(/function renderMainTagButtons\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(render, 'renderMainTagButtons関数が存在すること');
  assert.match(render[1], /toggleMainTag\(tag\)/, 'タップでtoggleMainTagを呼ぶこと');

  const toggle = html.match(/function toggleMainTag\(tag\) \{([\s\S]*?)\n    \}/);
  assert.ok(toggle, 'toggleMainTag関数が存在すること（複数選択のトグル）');

  assert.match(html, /function getCurrentTags\(\) \{([\s\S]*?)\n    \}/, 'getCurrentTags関数が存在すること');
});

test('タグ管理（設定画面）: 追加・削除・並び替えのGASアクションを送る関数が揃っている', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  ['tagManageSection', 'tagManageList', 'newTagInput', 'addTagButton'].forEach(function (id) {
    assert.match(html, new RegExp('id="' + id + '"'), 'id="' + id + '" が存在すること');
  });
  assert.match(html, /action: 'addTag'/, 'addTagアクションを送ること');
  assert.match(html, /action: 'removeTag'/, 'removeTagアクションを送ること');
  assert.match(html, /action: 'reorderTags'/, 'reorderTagsアクションを送ること');
});

// ---- キーワード検索（一覧のフィルター） --------------------------------

test('検索UI: 一覧画面に検索入力欄があり、input時にscheduleListSearchが呼ばれる', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="listSearchInput"/, '検索入力欄が存在すること');
  // listItemsContainer より前（タイトルの直後）に配置されていること
  const view = html.match(/<div id="listItemsView"[\s\S]*?<!-- ビュー4b:/);
  assert.ok(view, 'listItemsViewが存在すること');
  assert.ok(
    view[0].indexOf('id="listSearchInput"') < view[0].indexOf('id="listItemsContainer"'),
    '検索欄は記事一覧より上に配置されていること'
  );
  assert.match(
    html, /getElementById\('listSearchInput'\)\.addEventListener\('input', scheduleListSearch\)/,
    '検索欄の入力でscheduleListSearchを呼ぶこと'
  );
});

test('検索UI: openListItemsViewはカテゴリを開くたびに検索状態と検索欄をリセットする', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function openListItemsView\(category\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'openListItemsView関数が存在すること');
  assert.match(m[1], /state\.listKeyword = ''/, 'state.listKeywordを空にリセットすること');
  assert.match(m[1], /searchInput\.value = ''/, '検索入力欄の表示値もリセットすること');
});

test('検索UI: runListSearchはkeywordを付けてGASへ問い合わせ、結果でstate.listKeywordを更新する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function runListSearch\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'runListSearch関数が存在すること');
  assert.match(m[1], /var params = \{ category: category, offset: 0, keyword: keyword \}/, 'keywordを付けて検索すること');
  assert.match(m[1], /gasGet\('list', params\)/, 'GASへ問い合わせること');
  assert.match(m[1], /state\.listKeyword = keyword/, '検索中のキーワードをstateへ保持すること');
  assert.match(m[1], /await openListItemsView\(category\)/, 'キーワードが空になったら通常の一覧表示へ戻ること');
});

test('検索UI: 「さらに読み込む」は検索中のキーワードを引き継いで続きを取得する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function loadMoreListItems\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'loadMoreListItems関数が存在すること');
  assert.match(m[1], /var keyword = state\.listKeyword/, '検索中のキーワードを引き継ぐこと');
  assert.match(m[1], /if \(keyword\) \{ params\.keyword = keyword; \}/, 'keywordがある場合のみパラメータへ付与すること');
});

// ---- カテゴリ横断キーワード検索 ---------------------------------------

test('横断検索UI: ヘッダーに検索ボタンがあり、クリックでopenSearchViewを呼ぶ', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const header = html.match(/<header>[\s\S]*?<\/header>/);
  assert.ok(header, 'headerが存在すること');
  assert.match(header[0], /id="searchButton"/, 'ヘッダーに検索ボタンがあること');
  assert.match(
    html, /getElementById\('searchButton'\)\.addEventListener\('click', openSearchView\)/,
    '検索ボタンのクリックでopenSearchViewを呼ぶこと'
  );
});

test('横断検索UI: searchViewがVIEW_IDSに含まれ、検索欄・結果コンテナのDOM idが揃っている', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /VIEW_IDS = \[[\s\S]*?'searchView'[\s\S]*?\]/, 'VIEW_IDSにsearchViewが含まれること');
  ['searchView', 'searchBackButton', 'searchKeywordInput', 'searchItemsContainer'].forEach(function (id) {
    assert.match(html, new RegExp('id="' + id + '"'), 'id="' + id + '" が存在すること');
  });
});

test('横断検索UI: openSearchViewは検索状態をリセットしてから検索ビューを開く', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function openSearchView\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'openSearchView関数が存在すること');
  assert.match(m[1], /state\.searchKeyword = ''/, '前回の検索キーワードをリセットすること');
  assert.match(m[1], /getElementById\('searchKeywordInput'\)\.value = ''/, '検索入力欄の表示値もリセットすること');
  assert.match(m[1], /showView\('searchView'\)/, '検索ビューを表示すること');
});

test('横断検索UI: 検索欄の入力でscheduleGlobalSearchが呼ばれる', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(
    html, /getElementById\('searchKeywordInput'\)\.addEventListener\('input', scheduleGlobalSearch\)/,
    '検索欄の入力でscheduleGlobalSearchを呼ぶこと'
  );
});

test('横断検索UI: runGlobalSearchはcategory無しでGASのsearchアクションを呼ぶ（カテゴリ横断）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function runGlobalSearch\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'runGlobalSearch関数が存在すること');
  assert.match(m[1], /var params = \{ offset: 0, keyword: keyword \}/, 'categoryを指定せずsearchアクションを呼ぶこと');
  assert.match(m[1], /gasGet\('search', params\)/, 'GASへ問い合わせること');
  assert.match(m[1], /state\.searchKeyword = keyword/, '検索中のキーワードをstateへ保持すること');
});

test('横断検索UI: 「さらに読み込む」は検索中のキーワードを引き継いで続きを取得する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function loadMoreSearchItems\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'loadMoreSearchItems関数が存在すること');
  assert.match(m[1], /var keyword = state\.searchKeyword/, '検索中のキーワードを引き継ぐこと');
  assert.match(m[1], /var params = \{ offset: state\.searchItems\.length, keyword: keyword \}/);
  assert.match(m[1], /gasGet\('search', params\)/);
});

test('横断検索UI: renderSearchItemsは各記事にカテゴリ名を表示し、編集ボタンは出さない', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function renderSearchItems\(items, hasMore\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'renderSearchItems関数が存在すること');
  assert.match(m[1], /item\.category/, 'カテゴリ名を表示に使うこと');
  assert.doesNotMatch(m[1], /openEditView/, '検索結果からは編集ビューを開かないこと（編集ボタンを出さない）');
});

test('カテゴリ・タグ管理: 設定画面を開くと両方のセクションがまとめて表示・取得される（refreshManageUi）', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function refreshManageUi\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'refreshManageUi関数が存在すること');
  assert.match(m[1], /categoryManageSection/);
  assert.match(m[1], /tagManageSection/);
  assert.match(m[1], /renderCategoryManageList\(\)/);
  assert.match(m[1], /renderTagManageList\(\)/);
});

// ---- 検索画面のタグ複数選択（AND条件で絞り込み） ------------------------

test('タグ複数選択UI: 一覧・横断検索の両画面にタグフィルター用のDOM idがある', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /id="listTagFilterGrid"/, '一覧画面にタグフィルター用のコンテナがあること');
  assert.match(html, /id="searchTagFilterGrid"/, '横断検索画面にタグフィルター用のコンテナがあること');
});

test('タグ複数選択UI: renderTagFilterButtonsは選択中タグをハイライトし、タップでonToggleを呼ぶ', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function renderTagFilterButtons\(containerId, selectedTags, onToggle\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'renderTagFilterButtons関数が存在すること');
  assert.match(m[1], /tag-filter-button-selected/, '選択中タグをハイライトすること');
  assert.match(m[1], /onToggle\(tag\)/, 'タップでonToggleを呼ぶこと');
});

test('タグ複数選択UI: toggleListFilterTagはstate.listFilterTagsを更新して検索を再実行する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function toggleListFilterTag\(tag\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'toggleListFilterTag関数が存在すること');
  assert.match(m[1], /state\.listFilterTags/, 'state.listFilterTagsを更新すること');
  assert.match(m[1], /runListSearch\(\)/, '選択変更のたびに検索を再実行すること');
});

test('タグ複数選択UI: toggleSearchFilterTagはstate.searchFilterTagsを更新して横断検索を再実行する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/function toggleSearchFilterTag\(tag\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'toggleSearchFilterTag関数が存在すること');
  assert.match(m[1], /state\.searchFilterTags/, 'state.searchFilterTagsを更新すること');
  assert.match(m[1], /runGlobalSearch\(\)/, '選択変更のたびに横断検索を再実行すること');
});

test('タグ複数選択UI: runListSearchは選択中タグをAND条件のtagsパラメータとしてGASへ渡す', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function runListSearch\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'runListSearch関数が存在すること');
  assert.match(m[1], /filterTags\.length.*params\.tags = buildTagsParam\(filterTags\)/, 'タグ選択時はtagsパラメータを付与すること');
  assert.match(m[1], /!keyword && !filterTags\.length/, 'キーワード・タグどちらも無ければ通常表示に戻ること');
});

test('タグ複数選択UI: runGlobalSearchは選択中タグをAND条件のtagsパラメータとしてGASへ渡す', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const m = html.match(/async function runGlobalSearch\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'runGlobalSearch関数が存在すること');
  assert.match(m[1], /filterTags\.length.*params\.tags = buildTagsParam\(filterTags\)/, 'タグ選択時はtagsパラメータを付与すること');
});

test('タグ複数選択UI: buildTagsParamはタグ配列をカンマ区切り文字列に変換する', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const context = { document: { getElementById: () => ({}) } };
  const m = html.match(/function buildTagsParam\(tags\) \{([\s\S]*?)\n    \}/);
  assert.ok(m, 'buildTagsParam関数が存在すること');
  vm.createContext(context);
  vm.runInContext('function buildTagsParam(tags) {' + m[1] + '}', context);
  assert.strictEqual(context.buildTagsParam(['Claude', 'GitHub']), 'Claude,GitHub');
  assert.strictEqual(context.buildTagsParam(['単一タグ']), '単一タグ');
});

test('タグ複数選択UI: openListItemsView・openSearchViewはタグ選択状態もリセットする', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const listOpen = html.match(/async function openListItemsView\(category\) \{([\s\S]*?)\n    \}/);
  assert.ok(listOpen, 'openListItemsView関数が存在すること');
  assert.match(listOpen[1], /state\.listFilterTags = \[\]/, 'カテゴリを開くたびにタグ選択をリセットすること');

  const searchOpen = html.match(/function openSearchView\(\) \{([\s\S]*?)\n    \}/);
  assert.ok(searchOpen, 'openSearchView関数が存在すること');
  assert.match(searchOpen[1], /state\.searchFilterTags = \[\]/, '検索ビューを開くたびにタグ選択をリセットすること');
});

// ---- 一覧内タグバッジ（タグ0/1/複数件の描画差） ------------------------

// createElement/appendChild/classList/textContent を持つ最小限のDOMノードスタブ。
// 実際に renderListItems / renderSearchItems 本体を vm で実行し、
// 生成されたDOM構造（タグバッジの有無・個数・テキスト）を検証するために使う。
function createDomStub() {
  function makeNode(tagName) {
    return {
      tagName: tagName,
      className: '',
      textContent: '',
      href: '',
      target: '',
      rel: '',
      children: [],
      classList: {
        _set: new Set(),
        add: function (c) { this._set.add(c); },
        contains: function (c) { return this._set.has(c); }
      },
      appendChild: function (child) { this.children.push(child); return child; },
      querySelectorAll: function (selector) {
        var wantClass = selector.replace(/^\./, '');
        var found = [];
        (function walk(node) {
          node.children.forEach(function (child) {
            if (child.className && child.className.split(' ').indexOf(wantClass) !== -1) {
              found.push(child);
            }
            walk(child);
          });
        })(this);
        return found;
      },
      addEventListener: function () {}
    };
  }
  var containers = {};
  var document = {
    createElement: function (tagName) { return makeNode(tagName); },
    getElementById: function (id) {
      if (!containers[id]) {
        var node = makeNode('div');
        node.innerHTML = '';
        Object.defineProperty(node, 'innerHTML', {
          get: function () { return this._html || ''; },
          set: function (v) { this._html = v; this.children = []; }
        });
        containers[id] = node;
      }
      return containers[id];
    }
  };
  return document;
}

function runRenderFunction(fnName, items, hasMore) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const re = new RegExp('function ' + fnName + '\\(items, hasMore\\) \\{([\\s\\S]*?)\\n    \\}');
  const m = html.match(re);
  assert.ok(m, fnName + '関数が存在すること');

  const document = createDomStub();
  const containerId = fnName === 'renderListItems' ? 'listItemsContainer' : 'searchItemsContainer';
  const context = {
    document: document,
    state: {},
    loadMoreListItems: function () {},
    loadMoreSearchItems: function () {},
    openEditView: function () {}
  };
  vm.createContext(context);
  vm.runInContext('function ' + fnName + '(items, hasMore) {' + m[1] + '}', context);
  context[fnName](items, hasMore);
  return document.getElementById(containerId);
}

['renderListItems', 'renderSearchItems'].forEach(function (fnName) {
  test(fnName + ': タグ0件の記事にはタグ領域自体を出さない', () => {
    const container = runRenderFunction(fnName, [
      { savedAt: '2026-07-31', title: 'タグなし記事', url: 'https://example.com/a', memo: '', tags: [] }
    ], false);
    const row = container.children[0];
    const link = row.children[0];
    const tagAreas = link.querySelectorAll('.list-item-tags');
    assert.strictEqual(tagAreas.length, 0, 'タグ0件ならlist-item-tagsコンテナ自体が無いこと');
  });

  test(fnName + ': タグ1件の記事は1個のバッジを表示する', () => {
    const container = runRenderFunction(fnName, [
      { savedAt: '2026-07-31', title: 'タグ1件記事', url: 'https://example.com/b', memo: '', tags: ['Claude'] }
    ], false);
    const link = container.children[0].children[0];
    const tagAreas = link.querySelectorAll('.list-item-tags');
    assert.strictEqual(tagAreas.length, 1, 'タグ領域が1つ生成されること');
    const badges = tagAreas[0].querySelectorAll('.list-item-tag-badge');
    assert.strictEqual(badges.length, 1);
    assert.strictEqual(badges[0].textContent, 'Claude');
  });

  test(fnName + ': タグ複数件の記事は件数分のバッジを表示する', () => {
    const container = runRenderFunction(fnName, [
      {
        savedAt: '2026-07-31', title: 'タグ複数件記事', url: 'https://example.com/c', memo: '',
        tags: ['Claude', 'GitHub', '単一タグ']
      }
    ], false);
    const link = container.children[0].children[0];
    const tagAreas = link.querySelectorAll('.list-item-tags');
    assert.strictEqual(tagAreas.length, 1);
    const badges = tagAreas[0].querySelectorAll('.list-item-tag-badge');
    assert.strictEqual(badges.length, 3, 'タグの件数分バッジが生成されること');
    assert.deepStrictEqual(badges.map(function (b) { return b.textContent; }), ['Claude', 'GitHub', '単一タグ']);
  });

  test(fnName + ': item.tagsが無い（旧キャッシュ由来のデータ）でもタグ領域を出さずエラーにならない', () => {
    const container = runRenderFunction(fnName, [
      { savedAt: '2026-07-31', title: 'tagsフィールドが無い旧データ', url: 'https://example.com/f', memo: '' }
    ], false);
    const link = container.children[0].children[0];
    const tagAreas = link.querySelectorAll('.list-item-tags');
    assert.strictEqual(tagAreas.length, 0, 'item.tagsが無くてもタグ領域を出さないこと');
  });

  test(fnName + ': タグバッジはtextContentで設定され、DOM APIで組み立てられる（XSS対策の踏襲）', () => {
    const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
    const re = new RegExp('function ' + fnName + '\\(items, hasMore\\) \\{([\\s\\S]*?)\\n    \\}');
    const m = htmlSrc.match(re);
    assert.ok(m, fnName + '関数が存在すること');
    assert.match(m[1], /list-item-tag-badge/, 'タグバッジのクラス名が使われていること');
    assert.match(m[1], /badge\.textContent = tag/, 'タグ名はtextContentで設定していること');
  });
});
