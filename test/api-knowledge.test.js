// ============================================================
// api/knowledge.js（Claude.ai中継API）の自動テスト
//
//   Vercel環境を実際には起動せず、req/resを最小限のオブジェクトで
//   モックして直接ハンドラを呼び出す。GASへの通信はglobal.fetchを
//   差し替えてモックする。
//
//   実行方法: node --test test/api-knowledge.test.js
// ============================================================

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const handler = require('../api/knowledge.js');

const ORIGINAL_ENV = { GAS_URL: process.env.GAS_URL, SHARED_TOKEN: process.env.SHARED_TOKEN };
const ORIGINAL_FETCH = global.fetch;

function createReq(query) {
  return { query: query || {} };
}

function createRes() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; }
  };
}

beforeEach(() => {
  delete process.env.GAS_URL;
  delete process.env.SHARED_TOKEN;
});

afterEach(() => {
  process.env.GAS_URL = ORIGINAL_ENV.GAS_URL;
  process.env.SHARED_TOKEN = ORIGINAL_ENV.SHARED_TOKEN;
  global.fetch = ORIGINAL_FETCH;
});

test('GAS_URL / SHARED_TOKEN が未設定なら500を返す', async () => {
  const req = createReq({ action: 'search', keyword: 'test' });
  const res = createRes();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(res.body.ok, false);
  assert.match(res.body.error, /GAS_URL|SHARED_TOKEN/);
});

test('想定クエリから正しいGAS URLを組み立てて呼び出す', async () => {
  process.env.GAS_URL = 'https://script.google.com/macros/s/xxx/exec';
  process.env.SHARED_TOKEN = 'himitsu';

  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { json: async () => ({ ok: true, items: [] }) };
  };

  const req = createReq({ action: 'search', keyword: 'ナレッジ', offset: '10' });
  const res = createRes();

  await handler(req, res);

  const url = new URL(calledUrl);
  assert.strictEqual(url.origin + url.pathname, 'https://script.google.com/macros/s/xxx/exec');
  assert.strictEqual(url.searchParams.get('action'), 'search');
  assert.strictEqual(url.searchParams.get('keyword'), 'ナレッジ');
  assert.strictEqual(url.searchParams.get('offset'), '10');
  assert.strictEqual(url.searchParams.get('token'), 'himitsu');
  assert.strictEqual(res.statusCode, 200);
});

test('クライアントから渡されたtokenパラメータは無視され、環境変数の値で上書きされる', async () => {
  process.env.GAS_URL = 'https://script.google.com/macros/s/xxx/exec';
  process.env.SHARED_TOKEN = 'himitsu';

  let calledUrl = null;
  global.fetch = async (url) => {
    calledUrl = url;
    return { json: async () => ({ ok: true }) };
  };

  const req = createReq({ action: 'categories', token: 'nusumareta' });
  const res = createRes();

  await handler(req, res);

  const url = new URL(calledUrl);
  assert.strictEqual(url.searchParams.get('token'), 'himitsu');
});

test('GASがok:trueを返した場合、そのまま透過する', async () => {
  process.env.GAS_URL = 'https://script.google.com/macros/s/xxx/exec';
  process.env.SHARED_TOKEN = 'himitsu';

  const gasBody = { ok: true, categories: ['PC系'], tags: [] };
  global.fetch = async () => ({ json: async () => gasBody });

  const req = createReq({ action: 'categories' });
  const res = createRes();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, gasBody);
  assert.strictEqual(res.headers['Cache-Control'], 'no-store');
});

test('GASがok:falseを返した場合も、そのまま透過する', async () => {
  process.env.GAS_URL = 'https://script.google.com/macros/s/xxx/exec';
  process.env.SHARED_TOKEN = 'himitsu';

  const gasBody = { ok: false, error: '不明なカテゴリです: 存在しないカテゴリ' };
  global.fetch = async () => ({ json: async () => gasBody });

  const req = createReq({ action: 'list', category: '存在しないカテゴリ' });
  const res = createRes();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, gasBody);
});

test('GASへのfetch自体が失敗した場合は502を返す', async () => {
  process.env.GAS_URL = 'https://script.google.com/macros/s/xxx/exec';
  process.env.SHARED_TOKEN = 'himitsu';

  global.fetch = async () => { throw new Error('network error'); };

  const req = createReq({ action: 'search', keyword: 'x' });
  const res = createRes();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.ok, false);
});

test('GASの応答がJSONとして解析できない場合も502を返す', async () => {
  process.env.GAS_URL = 'https://script.google.com/macros/s/xxx/exec';
  process.env.SHARED_TOKEN = 'himitsu';

  global.fetch = async () => ({ json: async () => { throw new SyntaxError('Unexpected token <'); } });

  const req = createReq({ action: 'categories' });
  const res = createRes();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.ok, false);
});
