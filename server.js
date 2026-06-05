// ============================================================================
// CryptoBot Pro v10 — Automated BTC Futures Trading Bot
// CRT (Candle Range Theory) + Mandatory DeepSeek AI Confirmation
// Zero npm dependencies. Built on Node.js core modules only.
// ============================================================================

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');

// ============================================================================
// CONSTANTS & DEFAULTS
// ============================================================================

const PORT          = process.env.PORT || 3000;
const BOT_PIN       = process.env.BOT_PIN || '123456';
const STATE_FILE    = './bot_state.json';
const KEYS_FILE     = './bot_keys.enc';   // stores MEXC + AI keys, all encrypted
const ENC_PASSPHRASE = process.env.ENC_PASSPHRASE || 'cryptobot-default-passphrase-change-me';
const BALANCE_FETCH_MS = 60000;            // refresh wallet balance every 60s
const LOG_BUFFER_SIZE  = 200;              // keep last 200 log lines for /logs

const MEXC_BASE     = 'https://contract.mexc.com';
const MEXC_PRICE    = 'https://contract.mexc.com/api/v1/contract/ticker';
const DEEPSEEK_URL  = 'https://api.deepseek.com/v1/chat/completions';

const CONTRACT_SIZE = 0.0001;   // 1 lot = 0.0001 BTC on MEXC
const TAKER_FEE     = 0.0002;   // 0.02% per side
const TICK_INTERVAL = 1500;     // 1.5 seconds
const TICKS_PER_CANDLE = 40;    // 60-second candles
const COOLDOWN_MS   = 6000;     // 6s between entries
const PENDING_LOCK_MS = 8000;   // pending lock auto-release
const AI_TIMEOUT_MS = 10000;    // AI must reply within 10s
const SYNC_INTERVAL = 30000;    // MEXC sync every 30s
const STATE_SAVE_MS = 8000;     // save state every 8s

// CRT detection filters
const MIN_CANDLE_RANGE_PCT = 0.00010;   // 0.010%
const SWEEP_BUF_RANGE_PCT  = 0.06;      // 6% of range
const SWEEP_BUF_PRICE_PCT  = 0.000040;  // 0.004% of price
const MIN_SWEEP_DEPTH_PCT  = 0.00001;   // 0.001%
const MIN_RR               = 0.70;
const PROFIT_LOCK_GIVEBACK = 0.45;      // give back 45% of peak
const BE_TRIGGER           = 0.40;      // 40% to TP moves SL to break-even

// ============================================================================
// STATE — defaults; load() overrides from disk
// ============================================================================

let state = {
  config: {
    pair: 'BTC_USDT',
    capital: 20,
    originalCapital: 20,
    leverage: 3,
    candleTicks: 40,
    maxPositions: 1,
    aiMinConfidence: 65,
    compound: false,
    compoundPct: 50,
    autoSync: true
  },
  modes: { futuresLive: false, paperMode: true },
  running: { futures: false, spot: false },
  positions: { futures: [], spot: [] },
  trades:    { futures: [], paper: [], spot: [] },
  stats: {
    wins: 0, losses: 0, totalPL: 0, totalFees: 0,
    recentTrades: [], lossStreak: 0
  },
  ai: { confidence: 65, lastDecision: null, hasKey: false },
  balance: { usdt: 0, fetchedAt: 0, error: null },
  lastTick: null,
  lastCandleTime: null,
  candles: [],     // last 50 completed candles
  currentCandle: null,
  tickBuffer: []
};

// Volatile (never persisted) — runtime control state
const runtime = {
  prices:     [],          // last 200 ticks for indicators
  mexcKeys:   { apiKey: '', apiSecret: '' },
  aiKey:      '',
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

// In-memory log buffer (last 200 lines)
const LOG_BUFFER = [];

// ============================================================================
// PERSISTENCE
// ============================================================================

function saveState() {
  try {
    const snap = JSON.parse(JSON.stringify(state));
    // Trim large arrays so file doesn't bloat
    if (snap.candles.length > 50) snap.candles = snap.candles.slice(-50);
    if (snap.trades.futures.length > 500) snap.trades.futures = snap.trades.futures.slice(-500);
    if (snap.trades.paper.length > 500)   snap.trades.paper   = snap.trades.paper.slice(-500);
    if (snap.trades.spot.length > 500)    snap.trades.spot    = snap.trades.spot.slice(-500);
    if (snap.stats.recentTrades.length > 5) snap.stats.recentTrades = snap.stats.recentTrades.slice(-5);
    fs.writeFileSync(STATE_FILE, JSON.stringify(snap, null, 2));
  } catch (e) {
    log('ERR', 'saveState: ' + e.message);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      const loaded = JSON.parse(raw);
      // Deep-merge so new defaults don't get nuked by old state
      state = { ...state, ...loaded, config: { ...state.config, ...(loaded.config || {}) } };
      log('INFO', `State restored: ${state.candles.length} candles, ${state.trades.futures.length} futures trades`);
    }
  } catch (e) {
    log('ERR', 'loadState: ' + e.message);
  }
}

// ============================================================================
// ENCRYPTION (AES-256-GCM for API keys)
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
    const iv  = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const enc = buf.slice(28);
    const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
    dec.setAuthTag(tag);
    return Buffer.concat([dec.update(enc), dec.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

function saveKeys() {
  try {
    const payload = JSON.stringify({
      apiKey:    runtime.mexcKeys.apiKey,
      apiSecret: runtime.mexcKeys.apiSecret,
      aiKey:     runtime.aiKey
    });
    fs.writeFileSync(KEYS_FILE, encrypt(payload));
  } catch (e) {
    log('ERR', 'saveKeys: ' + e.message);
  }
}

function loadKeys() {
  // 1) First check environment variables (set on Railway → Variables tab)
  //    These survive every redeploy automatically and are the recommended way.
  let envMexcKey    = process.env.MEXC_API_KEY    || '';
  let envMexcSecret = process.env.MEXC_API_SECRET || '';
  let envAiKey      = process.env.DEEPSEEK_API_KEY || '';

  if (envMexcKey || envMexcSecret || envAiKey) {
    if (envMexcKey)    runtime.mexcKeys.apiKey    = envMexcKey.trim().replace(/[\r\n\t]/g, '');
    if (envMexcSecret) runtime.mexcKeys.apiSecret = envMexcSecret.trim().replace(/[\r\n\t]/g, '');
    if (envAiKey)      runtime.aiKey              = envAiKey.trim().replace(/[\r\n\t]/g, '');
    state.ai.hasKey = !!runtime.aiKey;
    log('INFO', `Keys loaded from ENV vars — MEXC: ${runtime.mexcKeys.apiKey ? '✓' : '✗'} | AI: ${runtime.aiKey ? '✓' : '✗'}`);
    return;
  }

  // 2) Fall back to the encrypted file on disk
  try {
    if (fs.existsSync(KEYS_FILE)) {
      const dec = decrypt(fs.readFileSync(KEYS_FILE, 'utf8'));
      if (dec) {
        const k = JSON.parse(dec);
        runtime.mexcKeys.apiKey    = k.apiKey || '';
        runtime.mexcKeys.apiSecret = k.apiSecret || '';
        runtime.aiKey              = k.aiKey   || '';
        state.ai.hasKey            = !!runtime.aiKey;
        log('INFO', `Keys loaded from disk — MEXC: ${runtime.mexcKeys.apiKey ? '✓' : '✗'} | AI: ${runtime.aiKey ? '✓' : '✗'}`);
      } else {
        log('WARN', 'Could not decrypt keys file — wrong ENC_PASSPHRASE?');
      }
    } else {
      log('INFO', 'No saved keys file yet — set MEXC_API_KEY, MEXC_API_SECRET, DEEPSEEK_API_KEY env vars OR save via dashboard');
    }
  } catch (e) {
    log('ERR', 'loadKeys: ' + e.message);
  }
}

// ============================================================================
// LOGGING
// ============================================================================

function log(level, msg) {
  const stamp = new Date().toISOString();
  const line = `[${stamp}] [${level}] ${msg}`;
  console.log(line);
  LOG_BUFFER.push({ t: stamp, level, msg });
  if (LOG_BUFFER.length > LOG_BUFFER_SIZE) LOG_BUFFER.shift();
}

// ============================================================================
// HTTPS HELPER (no external libs)
// ============================================================================

function httpsRequest(urlStr, options = {}, body = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port:     u.port || 443,
      path:     u.pathname + u.search,
      method:   options.method || 'GET',
      headers:  options.headers || {},
      timeout:  timeoutMs
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ============================================================================
// MEXC API
// ============================================================================

function mexcSignFutures(apiKey, timestamp, paramsString, secret) {
  // MEXC Contract/Futures v1: sign apiKey + timestamp + paramsString
  // For GET, paramsString is the sorted "k=v&k=v" query string (no api_key, no req_time)
  // For POST, paramsString is the JSON body string
  const target = apiKey + timestamp + paramsString;
  return crypto.createHmac('sha256', secret).update(target).digest('hex');
}

async function mexcPublicPrice(pair) {
  try {
    const url = `${MEXC_PRICE}?symbol=${pair}`;
    const res = await httpsRequest(url, { method: 'GET' }, null, 5000);
    const j = JSON.parse(res.body);
    if (j && j.data && j.data.lastPrice) return parseFloat(j.data.lastPrice);
    return null;
  } catch (e) {
    log('ERR', 'mexcPublicPrice: ' + e.message);
    return null;
  }
}

async function mexcRequest(path, method, params = {}) {
  if (!runtime.mexcKeys.apiKey || !runtime.mexcKeys.apiSecret) {
    return { error: 'no_keys' };
  }

  const apiKey  = runtime.mexcKeys.apiKey;
  const reqTime = String(Date.now());

  let url = `${MEXC_BASE}${path}`;
  let bodyStr = null;
  let paramsString = '';

  if (method === 'GET') {
    // Sort params alphabetically, build "k=v&k=v" — no encoding (MEXC futures spec)
    const keys = Object.keys(params).sort();
    paramsString = keys.map(k => `${k}=${params[k]}`).join('&');
    if (paramsString) url += '?' + paramsString;
  } else {
    // POST: sign the JSON body as-is
    bodyStr = JSON.stringify(params);
    paramsString = bodyStr;
  }

  const sig = mexcSignFutures(apiKey, reqTime, paramsString, runtime.mexcKeys.apiSecret);

  const headers = {
    'ApiKey':       apiKey,
    'Request-Time': reqTime,
    'Signature':    sig,
    'Content-Type': 'application/json'
  };

  try {
    const res = await httpsRequest(url, { method, headers }, bodyStr, 8000);
    try { return JSON.parse(res.body); } catch { return { raw: res.body, status: res.status }; }
  } catch (e) {
    return { error: e.message };
  }
}

async function mexcGetPositions() {
  const r = await mexcRequest('/api/v1/private/position/open_positions', 'GET', { symbol: state.config.pair });
  if (r && r.data) return r.data;
  return [];
}

async function mexcPlaceOrder({ side, openType, vol, price, leverage, type }) {
  // side: 1=open long, 2=close short, 3=open short, 4=close long
  // type: 1=limit, 5=market
  // openType: 1=isolated, 2=cross
  const params = {
    symbol:    state.config.pair,
    side,
    openType:  openType || 1,
    type:      type || 5,        // default market
    vol,
    leverage:  leverage || state.config.leverage
  };
  if (type === 1 && price) params.price = price;
  return await mexcRequest('/api/v1/private/order/submit', 'POST', params);
}

async function mexcClosePosition(positionId) {
  return await mexcRequest('/api/v1/private/position/close', 'POST', { positionId });
}

async function mexcTestConnection() {
  if (!runtime.mexcKeys.apiKey || !runtime.mexcKeys.apiSecret) {
    return { ok: false, msg: 'No MEXC keys saved' };
  }
  const r = await mexcRequest('/api/v1/private/account/assets', 'GET', {});
  if (r && r.success === true) {
    // Find USDT balance for confirmation
    let usdt = 0;
    if (Array.isArray(r.data)) {
      const u = r.data.find(a => a.currency === 'USDT');
      if (u) usdt = parseFloat(u.availableBalance || 0);
    }
    return { ok: true, msg: `Connected ✓  USDT futures balance: $${usdt.toFixed(2)}` };
  }
  if (r && r.code) {
    // MEXC error codes: 700001=signature, 700002=auth, 600=permission, etc.
    return { ok: false, msg: `MEXC error ${r.code}: ${r.message || 'unknown'}` };
  }
  if (r && r.error) return { ok: false, msg: 'Network: ' + r.error };
  return { ok: false, msg: 'Unknown response: ' + JSON.stringify(r).slice(0, 200) };
}

async function mexcGetBalance() {
  const r = await mexcRequest('/api/v1/private/account/assets', 'GET', {});
  if (r && r.data) {
    const usdt = r.data.find(a => a.currency === 'USDT');
    return usdt ? parseFloat(usdt.availableBalance) : 0;
  }
  return 0;
}

// ============================================================================
// DEEPSEEK AI CONFIRMATION (mandatory — no fallback)
// ============================================================================

async function askDeepSeek(setup, indicators) {
  if (!runtime.aiKey) return { confirmed: false, reason: 'no_ai_key' };

  const stats = state.stats;
  const last5 = stats.recentTrades.slice(-5).map(t => t.profit > 0 ? 'W' : 'L').join('');
  const wr    = (stats.wins + stats.losses) > 0 ? (stats.wins / (stats.wins + stats.losses) * 100).toFixed(1) : 'n/a';

  const sysPrompt = `You are a strict crypto futures trading risk filter. Reply ONLY with JSON: {"confirmed":bool,"tp":number,"sl":number,"confidence":0-100,"reason":string,"risk":"low|med|high"}. No prose. No markdown.`;

  const userPrompt = `CRT setup on ${state.config.pair}:
Type: ${setup.type} | Direction: ${setup.direction}
Entry: ${setup.entry}
Proposed TP: ${setup.tp} | Proposed SL: ${setup.sl}
Sweep depth: ${(setup.sweepDepth * 100).toFixed(4)}%
RR: ${setup.rr.toFixed(2)}
Position: ${setup.lots} lots ($${setup.dollars.toFixed(2)} notional)

Indicators:
RSI-14: ${indicators.rsi14.toFixed(1)} | RSI-9: ${indicators.rsi9.toFixed(1)}
EMA-9 vs EMA-21: ${indicators.emaTrend}
Bollinger position: ${indicators.bbPos}
10-tick volatility: ${indicators.volatility.toFixed(4)}%

Account:
Win rate: ${wr}% | Total P/L: $${stats.totalPL.toFixed(2)}
Loss streak: ${stats.lossStreak} | Last 5: ${last5 || 'none'}

Confirm only if setup is clean and risk is acceptable. Adjust TP/SL if better levels exist.`;

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

    let txt = j.choices[0].message.content.trim();
    // Strip markdown fences if present
    txt = txt.replace(/```json|```/g, '').trim();

    // Find first JSON object
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return { confirmed: false, reason: 'ai_bad_format' };

    const parsed = JSON.parse(m[0]);
    return parsed;
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
    return { ok: false, reason: 'bad_tp_sl_types' };
  }
  if (setup.direction === 'LONG' && !(ai.tp > setup.entry && ai.sl < setup.entry)) {
    return { ok: false, reason: 'invalid_levels_long' };
  }
  if (setup.direction === 'SHORT' && !(ai.tp < setup.entry && ai.sl > setup.entry)) {
    return { ok: false, reason: 'invalid_levels_short' };
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

    if (res.status === 401) return { ok: false, msg: 'Invalid API key (401 Unauthorized)' };
    if (res.status === 402) return { ok: false, msg: 'No balance on DeepSeek account — top up at platform.deepseek.com' };
    if (res.status !== 200) return { ok: false, msg: 'HTTP ' + res.status };

    const j = JSON.parse(res.body);
    if (j.choices && j.choices[0]) {
      const reply = j.choices[0].message.content.trim();
      return { ok: true, msg: 'DeepSeek responded: "' + reply + '"' };
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
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
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
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  const last = prices[prices.length - 1];
  if (last > mean + sd)        return 'upper';
  if (last < mean - sd)        return 'lower';
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
  const volatility = recent.length > 1 ? ((Math.max(...recent) - Math.min(...recent)) / Math.min(...recent)) * 100 : 0;
  return { rsi14, rsi9, emaTrend, bbPos, volatility };
}

// ============================================================================
// CANDLE BUILDER
// ============================================================================

function pushTick(price) {
  runtime.prices.push(price);
  if (runtime.prices.length > 200) runtime.prices.shift();

  if (!state.currentCandle) {
    state.currentCandle = {
      startedAt: Date.now(),
      open: price, high: price, low: price, close: price,
      ticks: 1
    };
    return;
  }

  const c = state.currentCandle;
  c.high  = Math.max(c.high, price);
  c.low   = Math.min(c.low, price);
  c.close = price;
  c.ticks++;

  if (c.ticks >= state.config.candleTicks) {
    // Complete the candle
    state.candles.push({
      startedAt: c.startedAt,
      open: c.open, high: c.high, low: c.low, close: c.close,
      range: (c.high - c.low) / c.open
    });
    if (state.candles.length > 50) state.candles.shift();
    state.lastCandleTime = c.startedAt;
    state.currentCandle = {
      startedAt: Date.now(),
      open: price, high: price, low: price, close: price, ticks: 1
    };
  }
}

// ============================================================================
// CRT DETECTION
// ============================================================================

function detectCRT(currentPrice) {
  if (state.candles.length < 2) return null;
  if (!state.currentCandle)     return null;

  const prev = state.candles[state.candles.length - 1];
  const cur  = state.currentCandle;

  // Min candle range filter
  if (prev.range < MIN_CANDLE_RANGE_PCT) return null;

  // Sweep buffer (wider of: range × 6%, or price × 0.004%)
  const buf = Math.max((prev.high - prev.low) * SWEEP_BUF_RANGE_PCT, currentPrice * SWEEP_BUF_PRICE_PCT);

  // -- BULLISH: current candle dipped below prev.low then bounced back above prev.low
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
    if (tp <= entry) return null;

    return {
      type: 'CRT-Bullish', direction: 'LONG',
      entry, tp, sl, rr, sweepDepth,
      prevHigh: prev.high, prevLow: prev.low,
      signature: 'BULL_' + prev.low.toFixed(2) + '_' + prev.high.toFixed(2),
      candleStartUsed: cur.startedAt
    };
  }

  // -- BEARISH: current pushed above prev.high then dropped back below prev.high
  if (cur.high > (prev.high + buf) && currentPrice < prev.high) {
    const sweepDepth = (cur.high - prev.high) / prev.high;
    if (sweepDepth < MIN_SWEEP_DEPTH_PCT) return null;

    const entry = currentPrice;
    const tp    = prev.low;
    const sl    = cur.high + (currentPrice * 0.0001);
    const reward = entry - tp;
    const risk   = sl - entry;
    if (risk <= 0 || reward <= 0) return null;
    const rr = reward / risk;
    if (rr < MIN_RR) return null;
    if (tp >= entry) return null;

    return {
      type: 'CRT-Bearish', direction: 'SHORT',
      entry, tp, sl, rr, sweepDepth,
      prevHigh: prev.high, prevLow: prev.low,
      signature: 'BEAR_' + prev.low.toFixed(2) + '_' + prev.high.toFixed(2),
      candleStartUsed: cur.startedAt
    };
  }

  return null;
}

// ============================================================================
// POSITION SIZING — CORRECT MEXC MATH
// ============================================================================

function computeLots(dollars, price) {
  // 1 lot = 0.0001 BTC, so contract notional at price = 0.0001 × price
  const lots = Math.round(dollars / (CONTRACT_SIZE * price));
  return Math.max(1, lots);
}

function lotsToNotional(lots, price) {
  return lots * CONTRACT_SIZE * price;
}

function calcFee(price, lots) {
  return price * lots * CONTRACT_SIZE * TAKER_FEE;
}

function calcGrossPL(entry, exit, lots, direction) {
  const delta = direction === 'LONG' ? (exit - entry) : (entry - exit);
  return delta * lots * CONTRACT_SIZE;
}

function calcNetPL(entry, exit, lots, direction) {
  return calcGrossPL(entry, exit, lots, direction) - calcFee(entry, lots) - calcFee(exit, lots);
}

// ============================================================================
// GHOST-TRADE PREVENTION (5 LOCKS)
// ============================================================================

function canOpenEntry(setup) {
  const now = Date.now();

  // Lock A: one trade per candle
  if (setup.candleStartUsed === runtime.locks.lastCandleStartUsed) {
    return { ok: false, reason: 'A_same_candle' };
  }

  // Lock B: signature dedup
  if (setup.signature === runtime.locks.lastSignatureUsed) {
    return { ok: false, reason: 'B_dup_signature' };
  }

  // Lock C: pending entry guard
  if (runtime.locks.pendingEntry) {
    // Lock D auto-release
    if (now - runtime.locks.pendingEntryAt > PENDING_LOCK_MS) {
      runtime.locks.pendingEntry = false;
      log('WARN', 'Pending lock auto-released after 8s');
    } else {
      return { ok: false, reason: 'C_pending' };
    }
  }

  // Lock E: AI thinking
  if (runtime.locks.aiThinking) {
    return { ok: false, reason: 'E_ai_thinking' };
  }

  // Cooldown
  if (now - runtime.locks.lastEntryAt < COOLDOWN_MS) {
    return { ok: false, reason: 'cooldown' };
  }

  // Max positions
  if (state.positions.futures.length >= state.config.maxPositions) {
    return { ok: false, reason: 'max_positions' };
  }

  return { ok: true };
}

function resetLocksOnRestart() {
  runtime.locks.pendingEntry = false;
  runtime.locks.aiThinking   = false;
  log('INFO', 'Entry locks reset on startup');
}

// ============================================================================
// OPEN POSITION
// ============================================================================

async function tryOpenPosition(setup) {
  const gate = canOpenEntry(setup);
  if (!gate.ok) return;

  // Mark locks
  runtime.locks.aiThinking = true;
  runtime.locks.pendingEntry = true;
  runtime.locks.pendingEntryAt = Date.now();

  try {
    const lots    = computeLots(state.config.capital, setup.entry);
    const dollars = lotsToNotional(lots, setup.entry);
    setup.lots    = lots;
    setup.dollars = dollars;

    const indicators = computeIndicators();

    log('INFO', `[CRT] ${setup.type} ${setup.direction} @ ${setup.entry.toFixed(2)} TP ${setup.tp.toFixed(2)} SL ${setup.sl.toFixed(2)} RR ${setup.rr.toFixed(2)} — asking AI…`);

    const ai = await askDeepSeek(setup, indicators);
    state.ai.lastDecision = { setup, ai, at: Date.now() };

    const v = validateAIResponse(ai, setup);
    if (!v.ok) {
      log('INFO', `[AI] BLOCKED — ${v.reason} (${ai.reason || 'n/a'} conf=${ai.confidence || 0})`);
      return;
    }

    // Use AI's TP/SL
    const finalTP = ai.tp;
    const finalSL = ai.sl;

    log('INFO', `[AI] APPROVED conf=${ai.confidence} TP=${finalTP.toFixed(2)} SL=${finalSL.toFixed(2)} — ${ai.reason}`);

    const pos = {
      id: 'pos_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      pair: state.config.pair,
      direction: setup.direction,
      entry: setup.entry,
      lots, dollars,
      tp: finalTP, sl: finalSL,
      originalSL: finalSL,
      opened: Date.now(),
      aiConfidence: ai.confidence,
      aiReason: ai.reason,
      // profit protection state
      peakNetPL: 0,
      beMoved: false,
      mode: state.modes.futuresLive ? 'LIVE' : 'PAPER'
    };

    // Live order if enabled
    if (state.modes.futuresLive) {
      const side = setup.direction === 'LONG' ? 1 : 3;
      const ord  = await mexcPlaceOrder({ side, vol: lots, type: 5, leverage: state.config.leverage });
      if (!ord || !ord.success) {
        log('ERR', '[ORDER] MEXC reject: ' + JSON.stringify(ord));
        return;
      }
      pos.mexcOrderId = ord.data;
      log('INFO', `[ORDER] LIVE opened lots=${lots} id=${ord.data}`);
    } else {
      log('INFO', `[ORDER] PAPER opened lots=${lots}`);
    }

    state.positions.futures.push(pos);

    // Update locks AFTER successful entry
    runtime.locks.lastCandleStartUsed = setup.candleStartUsed;
    runtime.locks.lastSignatureUsed   = setup.signature;
    runtime.locks.lastEntryAt         = Date.now();

  } catch (e) {
    log('ERR', 'tryOpenPosition: ' + e.message);
  } finally {
    runtime.locks.aiThinking   = false;
    runtime.locks.pendingEntry = false;
  }
}

// ============================================================================
// POSITION MONITORING — PROFIT PROTECTION
// ============================================================================

async function monitorPositions(currentPrice) {
  for (let i = state.positions.futures.length - 1; i >= 0; i--) {
    const p = state.positions.futures[i];

    const grossPL = calcGrossPL(p.entry, currentPrice, p.lots, p.direction);
    const netPL   = calcNetPL(p.entry, currentPrice, p.lots, p.direction);

    // Track peak
    if (netPL > p.peakNetPL) p.peakNetPL = netPL;

    // Layer 2: move SL to break-even at 40% to TP
    if (!p.beMoved) {
      const tpDist = Math.abs(p.tp - p.entry);
      const moved  = Math.abs(currentPrice - p.entry);
      if (moved / tpDist >= BE_TRIGGER) {
        // BE price = entry + fees, in the favorable direction
        const feePerSide = TAKER_FEE * 2;  // round trip
        const beShift    = p.entry * feePerSide;
        p.sl = p.direction === 'LONG' ? p.entry + beShift : p.entry - beShift;
        p.beMoved = true;
        log('INFO', `[BE] ${p.id} SL moved to break-even ${p.sl.toFixed(2)}`);
      }
    }

    // Layer 1: trailing profit-lock (never close net-negative)
    if (p.peakNetPL > 0) {
      const giveback = p.peakNetPL * PROFIT_LOCK_GIVEBACK;
      const trigger  = p.peakNetPL - giveback;
      if (netPL <= trigger && netPL > 0) {
        await closePosition(p, currentPrice, 'profit_lock');
        continue;
      }
    }

    // Layer 3: hard TP / SL
    if (p.direction === 'LONG') {
      if (currentPrice >= p.tp) { await closePosition(p, currentPrice, 'tp'); continue; }
      if (currentPrice <= p.sl) { await closePosition(p, currentPrice, 'sl'); continue; }
    } else {
      if (currentPrice <= p.tp) { await closePosition(p, currentPrice, 'tp'); continue; }
      if (currentPrice >= p.sl) { await closePosition(p, currentPrice, 'sl'); continue; }
    }
  }
}

async function closePosition(pos, exitPrice, reason) {
  const netPL = calcNetPL(pos.entry, exitPrice, pos.lots, pos.direction);
  const grossPL = calcGrossPL(pos.entry, exitPrice, pos.lots, pos.direction);
  const fees    = calcFee(pos.entry, pos.lots) + calcFee(exitPrice, pos.lots);

  if (pos.mode === 'LIVE' && pos.mexcOrderId) {
    try {
      // Close via opposite-side market order
      const side = pos.direction === 'LONG' ? 4 : 2;
      await mexcPlaceOrder({ side, vol: pos.lots, type: 5, leverage: state.config.leverage });
    } catch (e) {
      log('ERR', 'closePosition live: ' + e.message);
    }
  }

  const trade = {
    id: pos.id,
    pair: pos.pair,
    direction: pos.direction,
    entry: pos.entry,
    exit: exitPrice,
    lots: pos.lots,
    grossPL, fees, netPL, profit: netPL,
    reason,
    aiConfidence: pos.aiConfidence,
    opened: pos.opened,
    closed: Date.now(),
    mode: pos.mode
  };

  if (pos.mode === 'LIVE') state.trades.futures.push(trade);
  else                     state.trades.paper.push(trade);

  // Stats
  if (netPL > 0) { state.stats.wins++;   state.stats.lossStreak = 0; }
  else           { state.stats.losses++; state.stats.lossStreak++; }
  state.stats.totalPL   += netPL;
  state.stats.totalFees += fees;
  state.stats.recentTrades.push(trade);
  if (state.stats.recentTrades.length > 5) state.stats.recentTrades.shift();

  // Compounding (live only, only on win)
  if (pos.mode === 'LIVE' && state.config.compound && netPL > 0) {
    const add = netPL * (state.config.compoundPct / 100);
    state.config.capital += add;
    log('INFO', `[COMPOUND] +$${add.toFixed(4)} → new capital $${state.config.capital.toFixed(2)}`);
  }

  // Remove
  const idx = state.positions.futures.findIndex(x => x.id === pos.id);
  if (idx >= 0) state.positions.futures.splice(idx, 1);

  log('INFO', `[CLOSE] ${pos.id} ${reason} netPL=$${netPL.toFixed(4)} (gross=$${grossPL.toFixed(4)}, fees=$${fees.toFixed(4)})`);
  saveState();
}

// ============================================================================
// AUTO-SYNC WITH MEXC
// ============================================================================

async function syncWithMEXC() {
  if (!state.modes.futuresLive) return;
  if (!runtime.mexcKeys.apiKey) return;

  try {
    const exchPositions = await mexcGetPositions();
    if (!Array.isArray(exchPositions)) return;

    // 1) Import untracked positions
    for (const ep of exchPositions) {
      const known = state.positions.futures.find(p => p.mexcPositionId === ep.positionId);
      if (!known) {
        const direction = ep.positionType === 1 ? 'LONG' : 'SHORT';
        const entry = parseFloat(ep.holdAvgPrice || ep.openAvgPrice || 0);
        const lots  = parseInt(ep.holdVol || ep.vol || 0);
        if (!entry || !lots) continue;

        log('WARN', `[SYNC] Importing untracked MEXC position ${ep.positionId} ${direction} ${lots}@${entry}`);

        const setup = {
          type: 'IMPORTED', direction, entry,
          tp: direction === 'LONG' ? entry * 1.002 : entry * 0.998,
          sl: direction === 'LONG' ? entry * 0.998 : entry * 1.002,
          rr: 1, sweepDepth: 0, lots, dollars: lotsToNotional(lots, entry)
        };
        const ind = computeIndicators();
        const ai = await askDeepSeek(setup, ind);
        const ap = (ai && ai.confirmed && typeof ai.tp === 'number') ? ai : { tp: setup.tp, sl: setup.sl, confidence: 0, reason: 'ai_skipped' };

        state.positions.futures.push({
          id: 'imp_' + ep.positionId,
          pair: state.config.pair,
          mexcPositionId: ep.positionId,
          direction, entry, lots,
          dollars: setup.dollars,
          tp: ap.tp, sl: ap.sl,
          originalSL: ap.sl,
          opened: Date.now(),
          aiConfidence: ap.confidence,
          aiReason: 'imported_' + (ap.reason || 'sync'),
          peakNetPL: 0,
          beMoved: false,
          mode: 'LIVE'
        });
      }
    }

    // 2) Detect exchange-closed positions
    for (let i = state.positions.futures.length - 1; i >= 0; i--) {
      const p = state.positions.futures[i];
      if (p.mode !== 'LIVE') continue;
      if (!p.mexcPositionId) continue;
      const stillOpen = exchPositions.find(ep => ep.positionId === p.mexcPositionId);
      if (!stillOpen) {
        // Closed on exchange side
        const exitPrice = state.lastTick || p.entry;
        log('WARN', `[SYNC] Position ${p.id} closed on MEXC — reconciling at ${exitPrice}`);
        await closePosition(p, exitPrice, 'exchange_close');
      }
    }
  } catch (e) {
    log('ERR', 'syncWithMEXC: ' + e.message);
  }
}

// ============================================================================
// MAIN TICK LOOP
// ============================================================================

async function tick() {
  try {
    const price = await mexcPublicPrice(state.config.pair);
    if (!price) return;
    state.lastTick = price;
    pushTick(price);

    if (!state.running.futures) return;

    // Monitor open positions first
    await monitorPositions(price);

    // Look for new CRT setups
    const setup = detectCRT(price);
    if (setup) {
      // Fire-and-forget; AI lock prevents re-entries
      tryOpenPosition(setup).catch(e => log('ERR', 'tryOpenPosition: ' + e.message));
    } else {
      // Periodic scan log
      if (Math.random() < 0.01) log('INFO', `[CRT T${state.config.candleTicks}] scanning @ ${price.toFixed(2)} candles=${state.candles.length}`);
    }
  } catch (e) {
    log('ERR', 'tick: ' + e.message);
  }
}

async function refreshBalance() {
  if (!runtime.mexcKeys.apiKey) {
    state.balance.error = 'no_mexc_keys';
    return;
  }
  try {
    const bal = await mexcGetBalance();
    state.balance.usdt      = bal;
    state.balance.fetchedAt = Date.now();
    state.balance.error     = null;
  } catch (e) {
    state.balance.error = e.message;
  }
}

function startEngine() {
  if (runtime.intervals.tick) return;
  state.running.futures = true;
  runtime.intervals.tick    = setInterval(tick, TICK_INTERVAL);
  runtime.intervals.sync    = setInterval(syncWithMEXC, SYNC_INTERVAL);
  runtime.intervals.save    = setInterval(saveState, STATE_SAVE_MS);
  runtime.intervals.balance = setInterval(refreshBalance, BALANCE_FETCH_MS);
  refreshBalance().catch(()=>{});
  log('INFO', '== ENGINE STARTED ==');
}

function stopEngine() {
  state.running.futures = false;
  if (runtime.intervals.tick)    { clearInterval(runtime.intervals.tick);    runtime.intervals.tick    = null; }
  if (runtime.intervals.sync)    { clearInterval(runtime.intervals.sync);    runtime.intervals.sync    = null; }
  if (runtime.intervals.save)    { clearInterval(runtime.intervals.save);    runtime.intervals.save    = null; }
  if (runtime.intervals.balance) { clearInterval(runtime.intervals.balance); runtime.intervals.balance = null; }
  log('INFO', '== ENGINE STOPPED ==');
}

// ============================================================================
// HTTP SERVER
// ============================================================================

function send(res, status, obj, extraHeaders = {}) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Bot-Pin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    ...extraHeaders
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => data += c);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
    });
  });
}

function auth(req) {
  return (req.headers['x-bot-pin'] || '') === BOT_PIN;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 204, '');
    const url = new URL(req.url, 'http://x');
    const path = url.pathname;

    // Public endpoints
    if (path === '/ping')   return send(res, 200, { ok: true, version: '10.0.0' });
    if (path === '/prices') return send(res, 200, { price: state.lastTick, pair: state.config.pair });

    // All others require PIN
    if (!auth(req)) return send(res, 401, { error: 'unauthorized' });

    if (path === '/status') {
      return send(res, 200, {
        running: state.running,
        modes: state.modes,
        config: state.config,
        stats: state.stats,
        ai: { confidence: state.config.aiMinConfidence, hasKey: !!runtime.aiKey, lastDecision: state.ai.lastDecision },
        mexc: { hasKey: !!(runtime.mexcKeys.apiKey && runtime.mexcKeys.apiSecret) },
        balance: state.balance,
        positions: state.positions,
        trades: { recent: state.trades.futures.slice(-20).concat(state.trades.paper.slice(-20)) },
        lastTick: state.lastTick,
        candles: state.candles.slice(-5),
        currentCandle: state.currentCandle,
        locks: {
          pendingEntry: runtime.locks.pendingEntry,
          aiThinking:   runtime.locks.aiThinking
        }
      });
    }

    // ---- BOT CONTROL ----
    if (path === '/start')         { startEngine(); return send(res, 200, { ok: true }); }
    if (path === '/stop')          { stopEngine();  return send(res, 200, { ok: true }); }
    if (path === '/startfutures')  { state.running.futures = true;  startEngine(); return send(res, 200, { ok: true }); }
    if (path === '/stopfutures')   { state.running.futures = false; return send(res, 200, { ok: true }); }

    // ---- CONFIG ----
    if (path === '/config' && req.method === 'POST') {
      const body = await readBody(req);
      Object.assign(state.config, body);
      if (body.capital !== undefined && body.captureOriginal) state.config.originalCapital = body.capital;
      saveState();
      return send(res, 200, { ok: true, config: state.config });
    }
    if (path === '/configfutures' && req.method === 'POST') {
      const body = await readBody(req);
      ['capital','leverage','candleTicks','aiMinConfidence','pair','maxPositions','compound','compoundPct','autoSync']
        .forEach(k => { if (body[k] !== undefined) state.config[k] = body[k]; });
      if (body.capital !== undefined && !state.config.originalCapital) state.config.originalCapital = body.capital;
      saveState();
      return send(res, 200, { ok: true, config: state.config });
    }
    if (path === '/savekeys' && req.method === 'POST') {
      const body = await readBody(req);
      // Trim whitespace and strip any non-printable chars that paste sometimes adds
      if (body.apiKey)    runtime.mexcKeys.apiKey    = String(body.apiKey).trim().replace(/[\r\n\t]/g, '');
      if (body.apiSecret) runtime.mexcKeys.apiSecret = String(body.apiSecret).trim().replace(/[\r\n\t]/g, '');
      saveKeys();
      refreshBalance().catch(()=>{});   // fetch balance right away
      return send(res, 200, {
        ok: true,
        apiKeyLen:    runtime.mexcKeys.apiKey.length,
        apiSecretLen: runtime.mexcKeys.apiSecret.length,
        apiKeyHead:   runtime.mexcKeys.apiKey.slice(0, 4),
        apiKeyTail:   runtime.mexcKeys.apiKey.slice(-4)
      });
    }
    if (path === '/mexcdebug') {
      // Diagnostic endpoint: shows exactly what is sent to MEXC and what comes back
      if (!runtime.mexcKeys.apiKey || !runtime.mexcKeys.apiSecret) {
        return send(res, 200, { ok: false, msg: 'no_keys' });
      }
      const reqTime = String(Date.now());
      const apiKey = runtime.mexcKeys.apiKey;
      const paramsString = '';
      const signTarget = apiKey + reqTime + paramsString;
      const sig = crypto.createHmac('sha256', runtime.mexcKeys.apiSecret).update(signTarget).digest('hex');
      const targetUrl = `${MEXC_BASE}/api/v1/private/account/assets`;
      const headers = {
        'ApiKey':       apiKey,
        'Request-Time': reqTime,
        'Signature':    sig,
        'Content-Type': 'application/json'
      };
      let response;
      try {
        const res2 = await httpsRequest(targetUrl, { method: 'GET', headers }, null, 8000);
        response = { status: res2.status, body: res2.body };
      } catch (e) {
        response = { error: e.message };
      }
      return send(res, 200, {
        ok: true,
        sent: {
          url: targetUrl,
          method: 'GET',
          headers: {
            ApiKey:       apiKey.slice(0, 4) + '...' + apiKey.slice(-4) + ` (len ${apiKey.length})`,
            'Request-Time': reqTime,
            Signature:    sig.slice(0, 8) + '...' + sig.slice(-8) + ` (len ${sig.length})`,
            'Content-Type': 'application/json'
          },
          signTarget:     apiKey.slice(0, 4) + '...' + apiKey.slice(-4) + ' + ' + reqTime + ' + "' + paramsString + '"',
          apiSecretLen:   runtime.mexcKeys.apiSecret.length,
          apiSecretHead:  runtime.mexcKeys.apiSecret.slice(0, 4),
          apiSecretTail:  runtime.mexcKeys.apiSecret.slice(-4)
        },
        response
      });
    }
    if (path === '/setaikey' && req.method === 'POST') {
      const body = await readBody(req);
      runtime.aiKey = body.aiKey || '';
      state.ai.hasKey = !!runtime.aiKey;
      saveKeys();    // <-- now persists AI key to encrypted file
      saveState();
      return send(res, 200, { ok: true, hasKey: !!runtime.aiKey });
    }
    if (path === '/testai') {
      const r = await testDeepSeek();
      return send(res, 200, r);
    }
    if (path === '/logs') {
      // Optional ?n=50 query param, default 100
      const n = Math.min(parseInt(url.searchParams.get('n') || '100'), LOG_BUFFER_SIZE);
      return send(res, 200, { logs: LOG_BUFFER.slice(-n) });
    }
    if (path === '/refreshbalance') {
      await refreshBalance();
      return send(res, 200, { balance: state.balance });
    }
    if (path === '/setlive')  { state.modes.futuresLive = true;  state.modes.paperMode = false; saveState(); return send(res, 200, { ok: true, modes: state.modes }); }
    if (path === '/setpaper') { state.modes.futuresLive = false; state.modes.paperMode = true;  saveState(); return send(res, 200, { ok: true, modes: state.modes }); }
    if (path === '/testconnection') {
      const r = await mexcTestConnection();
      return send(res, 200, r);
    }

    // ---- POSITIONS ----
    if (path === '/closetrade' && req.method === 'POST') {
      const body = await readBody(req);
      const p = state.positions.futures.find(x => x.id === body.id);
      if (!p) return send(res, 404, { error: 'not_found' });
      await closePosition(p, state.lastTick || p.entry, 'manual');
      return send(res, 200, { ok: true });
    }
    if (path === '/closefuttrade' && req.method === 'POST') {
      const body = await readBody(req);
      const p = state.positions.futures.find(x => x.id === body.id);
      if (!p) return send(res, 404, { error: 'not_found' });
      await closePosition(p, state.lastTick || p.entry, 'manual');
      return send(res, 200, { ok: true });
    }
    if (path === '/closeallfutures') {
      const price = state.lastTick;
      const list = [...state.positions.futures];
      for (const p of list) await closePosition(p, price || p.entry, 'emergency');
      return send(res, 200, { ok: true, closed: list.length });
    }
    if (path === '/syncpositions') {
      await syncWithMEXC();
      return send(res, 200, { ok: true });
    }
    if (path === '/toggleautosync' && req.method === 'POST') {
      const body = await readBody(req);
      state.config.autoSync = !!body.autoSync;
      saveState();
      return send(res, 200, { ok: true, autoSync: state.config.autoSync });
    }

    // ---- FINANCE & AI ----
    if (path === '/balance' || path === '/futuresbalance') {
      const bal = await mexcGetBalance();
      return send(res, 200, { balance: bal, capital: state.config.capital });
    }
    if (path === '/aidecision') {
      return send(res, 200, { decision: state.ai.lastDecision });
    }
    if (path === '/setcompound' && req.method === 'POST') {
      const body = await readBody(req);
      state.config.compound    = !!body.compound;
      if (typeof body.compoundPct === 'number') state.config.compoundPct = body.compoundPct;
      saveState();
      return send(res, 200, { ok: true, compound: state.config.compound, pct: state.config.compoundPct });
    }
    if (path === '/resetcompound') {
      state.config.capital = state.config.originalCapital || state.config.capital;
      saveState();
      return send(res, 200, { ok: true, capital: state.config.capital });
    }
    if (path === '/reset' || path === '/resetfutures') {
      state.trades.futures = [];
      state.stats = { wins: 0, losses: 0, totalPL: 0, totalFees: 0, recentTrades: [], lossStreak: 0 };
      saveState();
      return send(res, 200, { ok: true });
    }
    if (path === '/resetpaper') {
      state.trades.paper = [];
      saveState();
      return send(res, 200, { ok: true });
    }

    // Serve nothing else (dashboard is hosted separately on Netlify)
    return send(res, 404, { error: 'not_found' });
  } catch (e) {
    log('ERR', 'server: ' + e.message);
    return send(res, 500, { error: e.message });
  }
});

// ============================================================================
// CRASH PROTECTION
// ============================================================================

process.on('uncaughtException',  (e) => log('FATAL', 'uncaughtException: ' + (e.stack || e.message)));
process.on('unhandledRejection', (e) => log('FATAL', 'unhandledRejection: ' + (e && e.stack || e)));

// ============================================================================
// STARTUP
// ============================================================================

loadState();
loadKeys();
resetLocksOnRestart();

server.listen(PORT, () => {
  log('INFO', `========================================`);
  log('INFO', `CryptoBot Pro v10.5-FINAL  (build: env-vars + sig-fix + mexcdebug)`);
  log('INFO', `If you see this banner, the LATEST code is running ✓`);
  log('INFO', `========================================`);
  log('INFO', `Listening on :${PORT}  |  PIN: ${BOT_PIN}`);
  log('INFO', `Pair: ${state.config.pair} | Capital: $${state.config.capital} | Leverage: ${state.config.leverage}x`);
  log('INFO', `Mode: ${state.modes.futuresLive ? 'LIVE' : 'PAPER'} | MEXC key: ${runtime.mexcKeys.apiKey ? 'set' : 'MISSING'} | AI key: ${runtime.aiKey ? 'set' : 'MISSING'}`);
  log('INFO', `========================================`);

  // If we were running before restart, resume
  if (state.running.futures) {
    log('INFO', 'Auto-resuming engine from saved state…');
    startEngine();
  }
});
