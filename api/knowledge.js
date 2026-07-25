// ============================================================
// Claude.ai (web_fetch) から GAS のナレッジ検索APIを呼ぶための中継API。
//
//   合言葉(SHARED_TOKEN)をVercelの環境変数側だけに保持し、
//   クライアント(Claude.ai)からはtokenを一切受け取らずにGASへ付与する。
//   GET /api/knowledge?action=search&keyword=xxx のように呼ぶ。
//
//   必要な環境変数（Vercelダッシュボードで設定）:
//     GAS_URL       : GAS Webアプリの exec URL
//     SHARED_TOKEN  : GAS側の SHARED_TOKEN と同じ合言葉
// ============================================================

'use strict';

const ALLOWED_PARAMS = ['action', 'keyword', 'category', 'offset'];

module.exports = async function handler(req, res) {
  const gasUrl = process.env.GAS_URL;
  const token = process.env.SHARED_TOKEN;

  if (!gasUrl || !token) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(500).json({
      ok: false,
      error: 'サーバー側の環境変数(GAS_URL / SHARED_TOKEN)が設定されていません'
    });
    return;
  }

  const params = new URLSearchParams();
  for (const key of ALLOWED_PARAMS) {
    const value = req.query ? req.query[key] : undefined;
    if (value !== undefined && value !== null) {
      params.set(key, String(value));
    }
  }
  params.set('token', token);

  const targetUrl = gasUrl + (gasUrl.indexOf('?') === -1 ? '?' : '&') + params.toString();

  let gasRes;
  try {
    gasRes = await fetch(targetUrl);
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ ok: false, error: 'GASへの通信に失敗しました' });
    return;
  }

  let data;
  try {
    data = await gasRes.json();
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ ok: false, error: 'GASからの応答を解析できませんでした' });
    return;
  }

  // GASのWebアプリはHTTPステータスを持たず常に200で返す(ok:trueもok:falseも)ため、
  // ここでも常に200でそのまま透過する。
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json(data);
};
