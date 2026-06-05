// ============================================================================
//                    ★★★ CRYPTOBOT PRO v12.0 SPOT ★★★
//                       BUILD: 2026-06-05  SPOT-FINAL
// ============================================================================
//   This build trades MEXC SPOT (BTCUSDT) using CRT strategy with DeepSeek AI
//   confirmation. SPOT is universally accessible — no futures permission hell.
//
//   HOW TO VERIFY THIS BUILD IS RUNNING:
//   ────────────────────────────────────────────────────────────────────────
//   1. On GitHub: this banner must be the FIRST thing in server.js
//   2. In Railway deploy logs: look for "v12.0-SPOT-FINAL"
//   3. In browser: visit  YOUR_URL/version  — returns v12.0-SPOT-FINAL
//   4. Dashboard header shows green "✓ server v12.0-SPOT" badge
//   ────────────────────────────────────────────────────────────────────────
//
//   ENV VARS (set on Railway → Variables tab):
//     BOT_PIN          — dashboard PIN (default 123456)
//     ENC_PASSPHRASE   — random 30+ char string for key encryption
//     MEXC_API_KEY     — your MEXC API key
//     MEXC_API_SECRET  — your MEXC API secret
//     DEEPSEEK_API_KEY — your DeepSeek API key (sk-...)
//
//   IMPORTANT NOTES:
//     - SPOT only allows LONG. Bearish CRT setups are skipped (logged).
//     - Capital is direct USDT amount (no leverage, no contracts).
//     - MEXC spot taker fee is 0.10% per side (0.20% round trip).
// ============================================================================

const BUILD_VERSION = 'v12.0-SPOT-FINAL';
const BUILD_DATE    = '2026-06-05';

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');

// ============================================================================
// CONFIG
// ============================================================================

const PORT             = process.env.PORT || 3000;
const BOT_PIN          = process.env.BOT_PIN || '123456';
const ENC_PASSPHRASE   = process.env.ENC_PASSPHRASE || 'cryptobot-default-change-me-please';
const STATE_FILE       = './bot_state.json';
const KEYS_FILE        = './bot_keys.enc';

const MEXC_BASE        = 'https://api.mexc.com';      // SPOT base
const DEEPSEEK_URL     = 'https://api.deepseek.com/v1/chat/completions';

// MEXC spot
const SPOT_TAKER_FEE   = 0.001;     // 0.10% per side
const DEFAULT_SYMBOL   = 'BTCUSDT'; // MEXC spot uses NO underscore
const MIN_NOTIONAL     = 5;         // MEXC min order ~$5 USDT

// Engine timings
const TICK_INTERVAL    = 1500;      // 1.5s
const TICKS_PER_CANDLE = 40;        // 60s candles
const COOLDOWN_MS      = 6000;
const PENDING_LOCK_MS  = 8000;
const AI_TIMEOUT_MS    = 10000;
const SYNC_INTERVAL    = 30000;
const STATE_SAVE_MS    = 8000;
const BALANCE_FETCH_MS = 60000;
const LOG_BUFFER_SIZE  = 200;

// CRT detection filters
const MIN_CANDLE_RANGE_PCT = 0.00010;   // 0.010%
const SWEEP_BUF_RANGE_PCT  = 0.06;      // 6% of range
const SWEEP_BUF_PRICE_PCT  = 0.000040;  // 0.004% of price
const MIN_SWEEP_DEPTH_PCT  = 0.00001;   // 0.001%
const MIN_RR               = 0.70;
const PROFIT_LOCK_GIVEBACK = 0.45;      // give back 45% of peak
const BE_TRIGGER           = 0.40;      // SL → break-even at 40% to TP

// ============================================================================
// STATE
// ============================================================================

let state = {
  config: {
    pair:            DEFAULT_SYMBOL,
    capital:         20,
    originalCapital: 20,
    candleTicks:     40,
    maxPositions:    1,
    aiMinConfidence: 65,
    compound:        false,
    compoundPct:     50,
    autoSync:        true
  },
  modes:   { live: false, paper: true },
  running: { engine: false },
  positions: [],
  trades:    { live: [], paper: [] },
  stats: {
    wins: 0, losses: 0, totalPL: 0, totalFees: 0,
    recentTrades: [], lossStreak: 0,
    bearishSkipped: 0   // we don't short on spot, count skipped setups
  },
  ai: { lastDecision: null, hasKey: false },
  balance: { usdt: 0, btc: 0, fetchedAt: 0, error: null },
  lastTick: null,
  candles: [],
  currentCandle: null
};

const runtime = {
  prices: [],
  mexcKeys: { apiKey: '', apiSecret: '' },
  aiKey: '',
  locks: {
    pendingEntry: false,
    pendingEntryAt: 0,
    aiThinking: false,
    lastCandleStartUsed: 0,
    lastSignatureUsed: '',
    lastEntryAt: 0
  },
  intervals: { tick: null, sync: null, save: null, balance: null }
};

const LOG_BUFFER = [];

// ============================================================================
// LOGGING
// ============================================================================

function log(level, msg) {
  const stamp = new Date().toISOString();
  console.log(`[${stamp}] [${level}] ${msg}`);
  LOG_BUFFER.push({ t: stamp, level, msg });
  if (LOG_BUFFER.length > LOG_BUFFER_SIZE) LOG_BUFFER.shift();
}

// ============================================================================
// PERSISTENCE
// ============================================================================

function saveState() {
  try {
    const snap = JSON.parse(JSON.stringify(state));
    if (snap.candles.length > 50) snap.candles = snap.candles.slice(-50);
    if (snap.trades.live.length  > 500) snap.trades.live  = snap.trades.live.slice(-500);
    if (snap.trades.paper.length > 500) snap.trades.paper = snap.trades.paper.slice(-500);
    if (snap.stats.recentTrades.length > 5) snap.stats.recentTrades = snap.stats.recentTrades.slice(-5);
    fs.writeFileSync(STATE_FILE, JSON.stringify(snap, null, 2));
  } catch (e) { log('ERR', 'saveState: ' + e.message); }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      state = { ...state, ...loaded, config: { ...state.config, ...(loaded.config || {}) } };
      log('INFO', `State restored: ${state.candles.length} candles, ${state.trades.live.length + state.trades.paper.length} trades`);
    }
  } catch (e) { log('ERR', 'loadState: ' + e.message); }
}

// ============================================================================
// ENCRYPTION (AES-256-GCM)
// ============================================================================

function encrypt(text) {
  const key = crypto.createHash('sha256').update(ENC_PASSPHRASE).digest();
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(b64) {
  try {
    const key = crypto.createHash('sha256').update(ENC_PASSPHRASE).digest();
    const buf = Buffer.from(b64, 'base64');
    const dec = crypto.createDecipheriv('aes-256-gcm', key, buf.slice(0, 12));
    dec.setAuthTag(buf.slice(12, 28));
    return Buffer.concat([dec.update(buf.slice(28)), dec.final()]).toString('utf8');
  } catch { return null; }
}

function saveKeys() {
  try {
    fs.writeFileSync(KEYS_FILE, encrypt(JSON.stringify({
      apiKey:    runtime.mexcKeys.apiKey,
      apiSecret: runtime.mexcKeys.apiSecret,
      aiKey:     runtime.aiKey
    })));
  } catch (e) { log('ERR', 'saveKeys: ' + e.message); }
}

function loadKeys() {
  // First: env vars (recommended)
  const envMexcKey    = (process.env.MEXC_API_KEY    || '').trim().replace(/[\r\n\t]/g, '');
  const envMexcSecret = (process.env.MEXC_API_SECRET || '').trim().replace(/[\r\n\t]/g, '');
  const envAiKey      = (process.env.DEEPSEEK_API_KEY || '').trim().replace(/[\r\n\t]/g, '');

  if (envMexcKey || envMexcSecret || envAiKey) {
    if (envMexcKey)    runtime.mexcKeys.apiKey    = envMexcKey;
    if (envMexcSecret) runtime.mexcKeys.apiSecret = envMexcSecret;
    if (envAiKey)      runtime.aiKey              = envAiKey;
    state.ai.hasKey = !!runtime.aiKey;
    log('INFO', `Keys loaded from ENV vars — MEXC: ${runtime.mexcKeys.apiKey ? '✓' : '✗'} | AI: ${runtime.aiKey ? '✓' : '✗'}`);
    return;
  }
  // Fallback: encrypted file
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const dec = decrypt(fs.readFileSync(KEYS_FILE, 'utf8'));
      if (dec) {
        const k = JSON.parse(dec);
        runtime.mexcKeys.apiKey    = k.apiKey || '';
        runtime.mexcKeys.apiSecret = k.apiSecret || '';
        runtime.aiKey              = k.aiKey || '';
        state.ai.hasKey            = !!runtime.aiKey;
        log('INFO', `Keys loaded from disk — MEXC: ${runtime.mexcKeys.apiKey ? '✓' : '✗'} | AI: ${runtime.aiKey ? '✓' : '✗'}`);
      } else {
        log('WARN', 'Could not decrypt keys file — wrong ENC_PASSPHRASE?');
      }
    } else {
      log('INFO', 'No keys yet — set MEXC_API_KEY, MEXC_API_SECRET, DEEPSEEK_API_KEY env vars OR save via dashboard');
    }
  } catch (e) { log('ERR', 'loadKeys: ' + e.message); }
}

// ============================================================================
// HTTPS REQUEST HELPER
// ============================================================================

function httpsRequest(urlStr, options = {}, body = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = https.request({
      hostname: u.hostname,
      port:     u.port || 443,
      path:     u.pathname + u.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
      timeout:  timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================================
// MEXC SPOT API — using documented working signature format
// ============================================================================
// Spot signing: HMAC-SHA256(queryString, secret), put result as &signature=...
// Header: X-MEXC-APIKEY: <apiKey>
// All signed endpoints need a `timestamp` parameter

function mexcSpotSign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

function buildQuery(params) {
  return Object.keys(params)
    .filter(k => params[k] !== undefined && params[k] !== null && params[k] !== '')
    .map(k => `${k}=${encodeURIComponent(params[k])}`)
    .join('&');
}

async function mexcPublicPrice(symbol) {
  try {
    const url = `${MEXC_BASE}/api/v3/ticker/price?symbol=${symbol}`;
    const res = await httpsRequest(url, { method: 'GET' }, null, 5000);
    const j = JSON.parse(res.body);
    if (j && j.price) return parseFloat(j.price);
    return null;
  } catch (e) {
    log('ERR', 'mexcPublicPrice: ' + e.message);
    return null;
  }
}

async function mexcSpotRequest(path, method, params = {}) {
  if (!runtime.mexcKeys.apiKey || !runtime.mexcKeys.apiSecret) {
    return { ok: false, error: 'no_keys' };
  }
  // Add timestamp + recvWindow
  const allParams = { ...params, timestamp: Date.now(), recvWindow: 10000 };
  const qs = buildQuery(allParams);
  const sig = mexcSpotSign(qs, runtime.mexcKeys.apiSecret);
  const fullQs = `${qs}&signature=${sig}`;

  const url = `${MEXC_BASE}${path}?${fullQs}`;
  const headers = {
    'X-MEXC-APIKEY': runtime.mexcKeys.apiKey,
    'Content-Type':  'application/json'
  };

  try {
    const res = await httpsRequest(url, { method, headers }, null, 8000);
    let parsed;
    try { parsed = JSON.parse(res.body); }
    catch { parsed = { raw: res.body }; }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, data: parsed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function mexcTestConnection() {
  if (!runtime.mexcKeys.apiKey || !runtime.mexcKeys.apiSecret) {
    return { ok: false, msg: 'No MEXC keys saved' };
  }
  const r = await mexcSpotRequest('/api/v3/account', 'GET');
  if (r.ok && r.data && Array.isArray(r.data.balances)) {
    const usdt = r.data.balances.find(b => b.asset === 'USDT');
    const btc  = r.data.balances.find(b => b.asset === 'BTC');
    const usdtBal = usdt ? parseFloat(usdt.free) : 0;
    const btcBal  = btc  ? parseFloat(btc.free)  : 0;
    return { ok: true, msg: `Connected ✓ USDT: $${usdtBal.toFixed(2)} | BTC: ${btcBal.toFixed(8)}` };
  }
  if (r.data && r.data.code) {
    return { ok: false, msg: `MEXC error ${r.data.code}: ${r.data.msg || 'unknown'}` };
  }
  if (r.data && r.data.raw) {
    return { ok: false, msg: 'Non-JSON response: ' + r.data.raw.slice(0, 200) };
  }
  return { ok: false, msg: r.error || 'unknown error' };
}

async function mexcGetBalance() {
  const r = await mexcSpotRequest('/api/v3/account', 'GET');
  if (r.ok && r.data && Array.isArray(r.data.balances)) {
    const usdt = r.data.balances.find(b => b.asset === 'USDT');
    const btc  = r.data.balances.find(b => b.asset === 'BTC');
    return {
      usdt: usdt ? parseFloat(usdt.free) : 0,
      btc:  btc  ? parseFloat(btc.free)  : 0
    };
  }
  return { usdt: 0, btc: 0, error: (r.data && r.data.msg) || r.error || 'unknown' };
}

async function mexcMarketBuy(symbol, quoteOrderQty) {
  // Spend exactly quoteOrderQty USDT to buy BTC
  return await mexcSpotRequest('/api/v3/order', 'POST', {
    symbol,
    side:          'BUY',
    type:          'MARKET',
    quoteOrderQty: quoteOrderQty.toFixed(2)
  });
}

async function mexcMarketSell(symbol, quantity) {
  // Sell quantity BTC at market
  return await mexcSpotRequest('/api/v3/order', 'POST', {
    symbol,
    side:     'SELL',
    type:     'MARKET',
    quantity: quantity.toFixed(8)
  });
}

// ============================================================================
// DEEPSEEK AI CONFIRMATION
// ============================================================================

async function askDeepSeek(setup, indicators) {
  if (!runtime.aiKey) return { confirmed: false, reason: 'no_ai_key' };

  const stats = state.stats;
  const last5 = stats.recentTrades.slice(-5).map(t => t.profit > 0 ? 'W' : 'L').join('');
  const wr = (stats.wins + stats.losses) > 0
    ? (stats.wins / (stats.wins + stats.losses) * 100).toFixed(1) : 'n/a';

  const sysPrompt = `You are a strict crypto SPOT trading risk filter. SPOT means LONG only — no shorts possible. Reply ONLY with JSON: {"confirmed":bool,"tp":number,"sl":number,"confidence":0-100,"reason":string,"risk":"low|med|high"}. No prose, no markdown.`;

  const userPrompt = `CRT-Bullish SPOT setup on ${state.config.pair}:
Entry: ${setup.entry}
Proposed TP: ${setup.tp} | Proposed SL: ${setup.sl}
Sweep depth: ${(setup.sweepDepth * 100).toFixed(4)}%
RR: ${setup.rr.toFixed(2)}
Notional: $${setup.dollars.toFixed(2)} USDT

Indicators:
RSI-14: ${indicators.rsi14.toFixed(1)} | RSI-9: ${indicators.rsi9.toFixed(1)}
EMA-9 vs EMA-21: ${indicators.emaTrend}
Bollinger position: ${indicators.bbPos}
10-tick volatility: ${indicators.volatility.toFixed(4)}%

Account:
Win rate: ${wr}% | Total P/L: $${stats.totalPL.toFixed(2)}
Loss streak: ${stats.lossStreak} | Last 5: ${last5 || 'none'}

Confirm only if clean and risk acceptable. Adjust TP/SL if better levels exist.`;

  const reqBody = JSON.stringify({
    model: 'deepseek-chat',
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user',   content: userPrompt }
    ],
    temperature: 0.2,
    max_tokens: 200
  });

  try {
    const res = await httpsRequest(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + runtime.aiKey
      }
    }, reqBody, AI_TIMEOUT_MS);

    const j = JSON.parse(res.body);
    if (!j.choices || !j.choices[0]) return { confirmed: false, reason: 'ai_no_choices' };

    let txt = j.choices[0].message.content.trim().replace(/```json|```/g, '').trim();
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { confirmed: false, reason: 'ai_bad_format' };
    return JSON.parse(m[0]);
  } catch (e) {
    log('ERR', 'askDeepSeek: ' + e.message);
    return { confirmed: false, reason: 'ai_error_' + e.message };
  }
}

function validateAIResponse(ai, setup) {
  if (!ai || ai.confirmed !== true) return { ok: false, reason: 'not_confirmed' };
  if (typeof ai.confidence !== 'number' || ai.confidence < state.config.aiMinConfidence) {
    return { ok: false, reason: 'low_confidence_' + ai.confidence };
  }
  if (typeof ai.tp !== 'number' || typeof ai.sl !== 'number') {
    return { ok: false, reason: 'bad_tp_sl' };
  }
  // SPOT: LONG only — TP must be above entry, SL below entry
  if (!(ai.tp > setup.entry && ai.sl < setup.entry)) {
    return { ok: false, reason: 'invalid_levels' };
  }
  return { ok: true };
}

async function testDeepSeek() {
  if (!runtime.aiKey) return { ok: false, msg: 'No DeepSeek key saved' };
  const reqBody = JSON.stringify({
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    max_tokens: 5
  });
  try {
    const res = await httpsRequest(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': 'Bearer ' + runtime.aiKey
      }
    }, reqBody, 8000);
    if (res.status === 401) return { ok: false, msg: 'Invalid API key (401)' };
    if (res.status === 402) return { ok: false, msg: 'No balance on DeepSeek — top up at platform.deepseek.com' };
    if (res.status !== 200) return { ok: false, msg: 'HTTP ' + res.status };
    const j = JSON.parse(res.body);
    if (j.choices && j.choices[0]) {
      return { ok: true, msg: 'DeepSeek responded: "' + j.choices[0].message.content.trim() + '"' };
    }
    return { ok: false, msg: 'No choices in response' };
  } catch (e) {
    return { ok: false, msg: 'Network error: ' + e.message };
  }
}

// ============================================================================
// INDICATORS
// ============================================================================

function rsi(prices, period) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const d = prices[i] - prices[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function ema(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}

function bollingerPos(prices, period = 20) {
  if (prices.length < period) return 'mid';
  const slice = prices.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const last = prices[prices.length - 1];
  if (last > mean + sd) return 'upper';
  if (last < mean - sd) return 'lower';
  return 'mid';
}

function computeIndicators() {
  const p = runtime.prices.slice(-100);
  const rsi14 = rsi(p, 14);
  const rsi9  = rsi(p, 9);
  const e9    = ema(p, 9);
  const e21   = ema(p, 21);
  const emaTrend = e9 > e21 ? 'bullish' : 'bearish';
  const bbPos = bollingerPos(p);
  const recent = p.slice(-10);
  const volatility = recent.length > 1
    ? ((Math.max(...recent) - Math.min(...recent)) / Math.min(...recent)) * 100 : 0;
  return { rsi14, rsi9, emaTrend, bbPos, volatility };
}

// ============================================================================
// CANDLE BUILDER
// ============================================================================

function pushTick(price) {
  runtime.prices.push(price);
  if (runtime.prices.length > 200) runtime.prices.shift();

  if (!state.currentCandle) {
    state.currentCandle = { startedAt: Date.now(), open: price, high: price, low: price, close: price, ticks: 1 };
    return;
  }
  const c = state.currentCandle;
  c.high  = Math.max(c.high, price);
  c.low   = Math.min(c.low, price);
  c.close = price;
  c.ticks++;

  if (c.ticks >= state.config.candleTicks) {
    state.candles.push({
      startedAt: c.startedAt,
      open: c.open, high: c.high, low: c.low, close: c.close,
      range: (c.high - c.low) / c.open
    });
    if (state.candles.length > 50) state.candles.shift();
    state.currentCandle = { startedAt: Date.now(), open: price, high: price, low: price, close: price, ticks: 1 };
  }
}

// ============================================================================
// CRT DETECTION (SPOT: bullish only, bearish counted but skipped)
// ============================================================================

function detectCRT(currentPrice) {
  if (state.candles.length < 2 || !state.currentCandle) return null;

  const prev = state.candles[state.candles.length - 1];
  const cur  = state.currentCandle;

  if (prev.range < MIN_CANDLE_RANGE_PCT) return null;

  const buf = Math.max(
    (prev.high - prev.low) * SWEEP_BUF_RANGE_PCT,
    currentPrice * SWEEP_BUF_PRICE_PCT
  );

  // BULLISH — we trade this
  if (cur.low < (prev.low - buf) && currentPrice > prev.low) {
    const sweepDepth = (prev.low - cur.low) / prev.low;
    if (sweepDepth < MIN_SWEEP_DEPTH_PCT) return null;

    const entry = currentPrice;
    const tp    = prev.high;
    const sl    = cur.low - (currentPrice * 0.0001);
    const reward = tp - entry;
    const risk   = entry - sl;
    if (risk <= 0 || reward <= 0) return null;
    const rr = reward / risk;
    if (rr < MIN_RR) return null;

    return {
      type: 'CRT-Bullish', direction: 'LONG',
      entry, tp, sl, rr, sweepDepth,
      signature: 'BULL_' + prev.low.toFixed(2) + '_' + prev.high.toFixed(2),
      candleStartUsed: cur.startedAt
    };
  }

  // BEARISH — detected but skipped (spot can't short)
  if (cur.high > (prev.high + buf) && currentPrice < prev.high) {
    const sweepDepth = (cur.high - prev.high) / prev.high;
    if (sweepDepth >= MIN_SWEEP_DEPTH_PCT) {
      // log occasionally so user sees we're not missing all bearish setups silently
      if (state.stats.bearishSkipped % 5 === 0) {
        log('INFO', `[CRT] Bearish setup skipped (spot can't short) — sweep depth ${(sweepDepth * 100).toFixed(3)}%`);
      }
      state.stats.bearishSkipped++;
    }
    return null;
  }

  return null;
}

// ============================================================================
// POSITION MANAGEMENT
// ============================================================================

function calcGrossPL(entry, exit, qty) {
  return (exit - entry) * qty;
}

function calcFee(price, qty) {
  return price * qty * SPOT_TAKER_FEE;
}

function calcNetPL(entry, exit, qty) {
  return calcGrossPL(entry, exit, qty) - calcFee(entry, qty) - calcFee(exit, qty);
}

function canOpenEntry(setup) {
  const now = Date.now();
  if (setup.candleStartUsed === runtime.locks.lastCandleStartUsed)
    return { ok: false, reason: 'A_same_candle' };
  if (setup.signature === runtime.locks.lastSignatureUsed)
    return { ok: false, reason: 'B_dup_signature' };
  if (runtime.locks.pendingEntry) {
    if (now - runtime.locks.pendingEntryAt > PENDING_LOCK_MS) {
      runtime.locks.pendingEntry = false;
      log('WARN', 'Pending lock auto-released');
    } else return { ok: false, reason: 'C_pending' };
  }
  if (runtime.locks.aiThinking) return { ok: false, reason: 'E_ai_thinking' };
  if (now - runtime.locks.lastEntryAt < COOLDOWN_MS) return { ok: false, reason: 'cooldown' };
  if (state.positions.length >= state.config.maxPositions) return { ok: false, reason: 'max_positions' };
  return { ok: true };
}

async function tryOpenPosition(setup) {
  const gate = canOpenEntry(setup);
  if (!gate.ok) return;

  runtime.locks.aiThinking = true;
  runtime.locks.pendingEntry = true;
  runtime.locks.pendingEntryAt = Date.now();

  try {
    const dollars = Math.max(MIN_NOTIONAL, state.config.capital);
    setup.dollars = dollars;

    const indicators = computeIndicators();
    log('INFO', `[CRT] ${setup.type} LONG @ ${setup.entry.toFixed(2)} TP ${setup.tp.toFixed(2)} SL ${setup.sl.toFixed(2)} RR ${setup.rr.toFixed(2)} — asking AI…`);

    const ai = await askDeepSeek(setup, indicators);
    state.ai.lastDecision = { setup, ai, at: Date.now() };

    const v = validateAIResponse(ai, setup);
    if (!v.ok) {
      log('INFO', `[AI] BLOCKED — ${v.reason} (${ai.reason || 'n/a'} conf=${ai.confidence || 0})`);
      return;
    }

    const finalTP = ai.tp;
    const finalSL = ai.sl;
    log('INFO', `[AI] APPROVED conf=${ai.confidence} TP=${finalTP.toFixed(2)} SL=${finalSL.toFixed(2)} — ${ai.reason}`);

    // Estimate quantity for tracking (live order will return real qty)
    const estQty = dollars / setup.entry;

    const pos = {
      id: 'pos_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      pair: state.config.pair,
      direction: 'LONG',
      entry: setup.entry,
      qty: estQty,
      dollars,
      tp: finalTP,
      sl: finalSL,
      originalSL: finalSL,
      opened: Date.now(),
      aiConfidence: ai.confidence,
      aiReason: ai.reason,
      peakNetPL: 0,
      beMoved: false,
      mode: state.modes.live ? 'LIVE' : 'PAPER'
    };

    if (state.modes.live) {
      const ord = await mexcMarketBuy(state.config.pair, dollars);
      if (!ord.ok || (ord.data && ord.data.code)) {
        log('ERR', '[ORDER] MEXC reject: ' + JSON.stringify(ord.data || ord.error));
        return;
      }
      // MEXC returns executedQty for the actual filled amount
      if (ord.data.executedQty) {
        pos.qty   = parseFloat(ord.data.executedQty);
        pos.entry = parseFloat(ord.data.cummulativeQuoteQty || dollars) / pos.qty;
      }
      pos.mexcOrderId = ord.data.orderId;
      log('INFO', `[ORDER] LIVE BUY filled qty=${pos.qty} entry=${pos.entry.toFixed(2)} orderId=${ord.data.orderId}`);
    } else {
      log('INFO', `[ORDER] PAPER BUY qty=${estQty.toFixed(8)} @ ${setup.entry.toFixed(2)}`);
    }

    state.positions.push(pos);
    runtime.locks.lastCandleStartUsed = setup.candleStartUsed;
    runtime.locks.lastSignatureUsed   = setup.signature;
    runtime.locks.lastEntryAt         = Date.now();

  } catch (e) {
    log('ERR', 'tryOpenPosition: ' + e.message);
  } finally {
    runtime.locks.aiThinking = false;
    runtime.locks.pendingEntry = false;
  }
}

async function monitorPositions(currentPrice) {
  for (let i = state.positions.length - 1; i >= 0; i--) {
    const p = state.positions[i];
    const netPL = calcNetPL(p.entry, currentPrice, p.qty);
    if (netPL > p.peakNetPL) p.peakNetPL = netPL;

    // Layer 2: SL → break-even at 40% to TP
    if (!p.beMoved) {
      const tpDist = Math.abs(p.tp - p.entry);
      const moved  = Math.abs(currentPrice - p.entry);
      if (moved / tpDist >= BE_TRIGGER) {
        const beShift = p.entry * SPOT_TAKER_FEE * 2;
        p.sl = p.entry + beShift;
        p.beMoved = true;
        log('INFO', `[BE] ${p.id} SL moved to break-even ${p.sl.toFixed(2)}`);
      }
    }

    // Layer 1: trailing profit lock (never below zero)
    if (p.peakNetPL > 0) {
      const trigger = p.peakNetPL - (p.peakNetPL * PROFIT_LOCK_GIVEBACK);
      if (netPL <= trigger && netPL > 0) {
        await closePosition(p, currentPrice, 'profit_lock');
        continue;
      }
    }

    // Layer 3: hard TP/SL
    if (currentPrice >= p.tp) { await closePosition(p, currentPrice, 'tp'); continue; }
    if (currentPrice <= p.sl) { await closePosition(p, currentPrice, 'sl'); continue; }
  }
}

async function closePosition(pos, exitPrice, reason) {
  let actualExit = exitPrice;
  let actualQty  = pos.qty;

  if (pos.mode === 'LIVE') {
    try {
      const ord = await mexcMarketSell(pos.pair, pos.qty);
      if (ord.ok && ord.data && ord.data.executedQty) {
        actualQty  = parseFloat(ord.data.executedQty);
        actualExit = parseFloat(ord.data.cummulativeQuoteQty) / actualQty;
        log('INFO', `[ORDER] LIVE SELL filled qty=${actualQty} exit=${actualExit.toFixed(2)}`);
      } else {
        log('ERR', '[ORDER] SELL failed: ' + JSON.stringify(ord.data || ord.error));
      }
    } catch (e) {
      log('ERR', 'closePosition live: ' + e.message);
    }
  }

  const grossPL = calcGrossPL(pos.entry, actualExit, actualQty);
  const fees    = calcFee(pos.entry, actualQty) + calcFee(actualExit, actualQty);
  const netPL   = grossPL - fees;

  const trade = {
    id: pos.id,
    pair: pos.pair,
    direction: 'LONG',
    entry: pos.entry,
    exit:  actualExit,
    qty:   actualQty,
    grossPL, fees, netPL, profit: netPL,
    reason,
    aiConfidence: pos.aiConfidence,
    opened: pos.opened,
    closed: Date.now(),
    mode: pos.mode
  };

  if (pos.mode === 'LIVE') state.trades.live.push(trade);
  else                     state.trades.paper.push(trade);

  if (netPL > 0) { state.stats.wins++;   state.stats.lossStreak = 0; }
  else           { state.stats.losses++; state.stats.lossStreak++; }
  state.stats.totalPL   += netPL;
  state.stats.totalFees += fees;
  state.stats.recentTrades.push(trade);
  if (state.stats.recentTrades.length > 5) state.stats.recentTrades.shift();

  if (pos.mode === 'LIVE' && state.config.compound && netPL > 0) {
    const add = netPL * (state.config.compoundPct / 100);
    state.config.capital += add;
    log('INFO', `[COMPOUND] +$${add.toFixed(4)} → new capital $${state.config.capital.toFixed(2)}`);
  }

  const idx = state.positions.findIndex(x => x.id === pos.id);
  if (idx >= 0) state.positions.splice(idx, 1);

  log('INFO', `[CLOSE] ${pos.id} ${reason} netPL=$${netPL.toFixed(4)} (gross=$${grossPL.toFixed(4)}, fees=$${fees.toFixed(4)})`);
  saveState();
}

// ============================================================================
// BALANCE REFRESH
// ============================================================================

async function refreshBalance() {
  if (!runtime.mexcKeys.apiKey) {
    state.balance.error = 'no_mexc_keys';
    return;
  }
  try {
    const b = await mexcGetBalance();
    state.balance.usdt = b.usdt;
    state.balance.btc  = b.btc;
    state.balance.fetchedAt = Date.now();
    state.balance.error = b.error || null;
  } catch (e) {
    state.balance.error = e.message;
  }
}

// ============================================================================
// MAIN TICK
// ============================================================================

async function tick() {
  try {
    const price = await mexcPublicPrice(state.config.pair);
    if (!price) return;
    state.lastTick = price;
    pushTick(price);

    if (!state.running.engine) return;

    await monitorPositions(price);

    const setup = detectCRT(price);
    if (setup) {
      tryOpenPosition(setup).catch(e => log('ERR', 'tryOpenPosition: ' + e.message));
    } else {
      if (Math.random() < 0.005) {
        log('INFO', `[CRT] scanning @ ${price.toFixed(2)} candles=${state.candles.length} bearishSkipped=${state.stats.bearishSkipped}`);
      }
    }
  } catch (e) {
    log('ERR', 'tick: ' + e.message);
  }
}

function startEngine() {
  if (runtime.intervals.tick) return;
  state.running.engine = true;
  runtime.intervals.tick    = setInterval(tick, TICK_INTERVAL);
  runtime.intervals.save    = setInterval(saveState, STATE_SAVE_MS);
  runtime.intervals.balance = setInterval(refreshBalance, BALANCE_FETCH_MS);
  refreshBalance().catch(()=>{});
  log('INFO', '== ENGINE STARTED ==');
}

function stopEngine() {
  state.running.engine = false;
  Object.keys(runtime.intervals).forEach(k => {
    if (runtime.intervals[k]) { clearInterval(runtime.intervals[k]); runtime.intervals[k] = null; }
  });
  log('INFO', '== ENGINE STOPPED ==');
}

// ============================================================================
// HTTP SERVER
// ============================================================================

function send(res, status, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bot-Pin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => data += c);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

function auth(req) { return (req.headers['x-bot-pin'] || '') === BOT_PIN; }

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    // Public
    if (path === '/ping')    return send(res, 200, { ok: true, version: BUILD_VERSION });
    if (path === '/version') return send(res, 200, {
      version: BUILD_VERSION, date: BUILD_DATE,
      uptime: Math.floor(process.uptime()),
      hint: 'If you see this, the v12 SPOT build IS deployed.'
    });
    if (path === '/prices')  return send(res, 200, { price: state.lastTick, pair: state.config.pair });

    // Auth
    if (!auth(req)) return send(res, 401, { error: 'unauthorized' });

    if (path === '/status') {
      return send(res, 200, {
        version: BUILD_VERSION,
        running: state.running,
        modes: state.modes,
        config: state.config,
        stats: state.stats,
        ai: { confidence: state.config.aiMinConfidence, hasKey: !!runtime.aiKey, lastDecision: state.ai.lastDecision },
        mexc: { hasKey: !!(runtime.mexcKeys.apiKey && runtime.mexcKeys.apiSecret) },
        balance: state.balance,
        positions: state.positions,
        lastTick: state.lastTick,
        candles: state.candles.slice(-5),
        currentCandle: state.currentCandle,
        locks: {
          pendingEntry: runtime.locks.pendingEntry,
          aiThinking:   runtime.locks.aiThinking
        }
      });
    }

    if (path === '/start')        { startEngine(); return send(res, 200, { ok: true }); }
    if (path === '/stop')         { stopEngine();  return send(res, 200, { ok: true }); }
    if (path === '/setlive')      { state.modes.live = true;  state.modes.paper = false; saveState(); return send(res, 200, { ok: true, modes: state.modes }); }
    if (path === '/setpaper')     { state.modes.live = false; state.modes.paper = true;  saveState(); return send(res, 200, { ok: true, modes: state.modes }); }

    if (path === '/configfutures' || path === '/config') {
      const body = await readBody(req);
      ['pair','capital','candleTicks','aiMinConfidence','maxPositions','compound','compoundPct','autoSync']
        .forEach(k => { if (body[k] !== undefined) state.config[k] = body[k]; });
      if (body.capital !== undefined && !state.config.originalCapital) state.config.originalCapital = body.capital;
      saveState();
      return send(res, 200, { ok: true, config: state.config });
    }

    if (path === '/savekeys' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.apiKey)    runtime.mexcKeys.apiKey    = String(body.apiKey).trim().replace(/[\r\n\t]/g, '');
      if (body.apiSecret) runtime.mexcKeys.apiSecret = String(body.apiSecret).trim().replace(/[\r\n\t]/g, '');
      saveKeys();
      refreshBalance().catch(()=>{});
      return send(res, 200, {
        ok: true,
        apiKeyLen: runtime.mexcKeys.apiKey.length,
        apiKeyHead: runtime.mexcKeys.apiKey.slice(0, 4),
        apiKeyTail: runtime.mexcKeys.apiKey.slice(-4)
      });
    }

    if (path === '/setaikey' && req.method === 'POST') {
      const body = await readBody(req);
      runtime.aiKey = (body.aiKey || '').trim();
      state.ai.hasKey = !!runtime.aiKey;
      saveKeys();
      return send(res, 200, { ok: true, hasKey: !!runtime.aiKey });
    }

    if (path === '/testconnection') return send(res, 200, await mexcTestConnection());
    if (path === '/testai')         return send(res, 200, await testDeepSeek());

    if (path === '/mexcdebug') {
      if (!runtime.mexcKeys.apiKey) return send(res, 200, { ok: false, msg: 'no_keys' });
      const params = { timestamp: Date.now(), recvWindow: 10000 };
      const qs = buildQuery(params);
      const sig = mexcSpotSign(qs, runtime.mexcKeys.apiSecret);
      const targetUrl = `${MEXC_BASE}/api/v3/account?${qs}&signature=${sig}`;
      let response;
      try {
        const r = await httpsRequest(targetUrl, {
          method: 'GET',
          headers: { 'X-MEXC-APIKEY': runtime.mexcKeys.apiKey }
        }, null, 8000);
        response = { status: r.status, body: r.body };
      } catch (e) { response = { error: e.message }; }
      return send(res, 200, {
        sent: {
          url: targetUrl.replace(runtime.mexcKeys.apiSecret, '<SECRET>').replace(sig, sig.slice(0,8) + '...'),
          method: 'GET',
          signedString: qs,
          apiKey: runtime.mexcKeys.apiKey.slice(0,4) + '...' + runtime.mexcKeys.apiKey.slice(-4) + ` (len ${runtime.mexcKeys.apiKey.length})`,
          secretLen: runtime.mexcKeys.apiSecret.length
        },
        response
      });
    }

    if (path === '/logs') {
      const n = Math.min(parseInt(url.searchParams.get('n') || '100'), LOG_BUFFER_SIZE);
      return send(res, 200, { logs: LOG_BUFFER.slice(-n) });
    }

    if (path === '/closetrade' && req.method === 'POST') {
      const body = await readBody(req);
      const p = state.positions.find(x => x.id === body.id);
      if (!p) return send(res, 404, { error: 'not_found' });
      await closePosition(p, state.lastTick || p.entry, 'manual');
      return send(res, 200, { ok: true });
    }

    if (path === '/closeall') {
      const list = [...state.positions];
      for (const p of list) await closePosition(p, state.lastTick || p.entry, 'emergency');
      return send(res, 200, { ok: true, closed: list.length });
    }

    if (path === '/balance')        return send(res, 200, state.balance);
    if (path === '/refreshbalance') { await refreshBalance(); return send(res, 200, state.balance); }

    if (path === '/reset') {
      state.trades.live  = [];
      state.trades.paper = [];
      state.stats = { wins: 0, losses: 0, totalPL: 0, totalFees: 0, recentTrades: [], lossStreak: 0, bearishSkipped: 0 };
      saveState();
      return send(res, 200, { ok: true });
    }

    if (path === '/resetcompound') {
      state.config.capital = state.config.originalCapital || state.config.capital;
      saveState();
      return send(res, 200, { ok: true, capital: state.config.capital });
    }

    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    log('ERR', 'server: ' + e.message);
    return send(res, 500, { error: e.message });
  }
});

// ============================================================================
// CRASH PROTECTION & STARTUP
// ============================================================================

process.on('uncaughtException',  (e) => log('FATAL', 'uncaughtException: ' + (e.stack || e.message)));
process.on('unhandledRejection', (e) => log('FATAL', 'unhandledRejection: ' + (e && e.stack || e)));

loadState();
loadKeys();
runtime.locks.pendingEntry = false;
runtime.locks.aiThinking   = false;

server.listen(PORT, () => {
  log('INFO', `=============================================================`);
  log('INFO', `   ★ ★ ★   CRYPTOBOT PRO  ${BUILD_VERSION}   ★ ★ ★`);
  log('INFO', `   Build date: ${BUILD_DATE}`);
  log('INFO', `   SPOT TRADING ONLY (LONG only, MEXC api.mexc.com)`);
  log('INFO', `   Verify externally: visit  YOUR_URL/version  in browser`);
  log('INFO', `=============================================================`);
  log('INFO', `Listening on :${PORT}  |  PIN: ${BOT_PIN}`);
  log('INFO', `Pair: ${state.config.pair} | Capital: $${state.config.capital}`);
  log('INFO', `Mode: ${state.modes.live ? 'LIVE' : 'PAPER'} | MEXC: ${runtime.mexcKeys.apiKey ? 'set' : 'MISSING'} | AI: ${runtime.aiKey ? 'set' : 'MISSING'}`);
  log('INFO', `=============================================================`);

  if (state.running.engine) {
    log('INFO', 'Auto-resuming engine from saved state…');
    startEngine();
  }
});
