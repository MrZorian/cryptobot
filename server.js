/**
 * CryptoBot Pro — Node.js Trading Server
 * Runs 24/7 on any hosting provider.
 * Dashboard connects via HTTP API — no browser needed to keep trading.
 *
 * Install: npm install
 * Run:     node server.js
 * Deploy:  see README.md
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// ─── CONFIG ────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_FILE = './bot_state.json';

// ─── STATE ─────────────────────────────────────────────────────────────────
let state = {
  botOn: false,
  strategy: 'grid',
  pair: 'BTC/USDT',
  exchange: 'binance',
  apiKey: '',
  apiSecret: '',
  capital: 20,
  levels: 5,
  spacing: 0.5,
  tp: 0.8,
  sl: 2.0,
  maxDaily: 100,
  // Runtime stats
  liveProfit: 0,
  todayProfit: 0,
  tradeCount: 0,
  wins: 0,
  losses: 0,
  bestTrade: 0,
  orders: [],
  trades: [],
  log: [],
  lastPrice: 0,
  startedAt: null,
  savedAt: null
};

// ─── LOAD SAVED STATE ───────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Restore config + stats, but not active orders (will rebuild)
      state = { ...state, ...saved };
      addLog('State loaded from disk.', 'info');
    }
  } catch(e) {
    addLog('Could not load saved state: ' + e.message, 'err');
  }
}

function saveState() {
  try {
    state.savedAt = Date.now();
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch(e) {
    addLog('Save failed: ' + e.message, 'err');
  }
}

// Auto-save every 10 seconds
setInterval(saveState, 10000);

// ─── LOGGING ────────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const ts = new Date().toISOString().slice(11,19);
  const entry = { ts, msg, type };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log.pop();
  console.log(`[${ts}] [${type.toUpperCase()}] ${msg}`);
}

// ─── PRICE FEED ─────────────────────────────────────────────────────────────
let priceWs = null;
let priceHistory = [];
let rsiPrices = [], emaPrices = [], bbPrices = [];
let wsReconnectTimer = null;
let pollTimer = null;

function connectPriceFeed() {
  if (priceWs) { try { priceWs.destroy(); } catch(e){} priceWs = null; }
  clearTimeout(wsReconnectTimer);
  clearInterval(pollTimer);

  const sym = state.pair.replace('/', '').toLowerCase();
  const ex = state.exchange;

  // Use REST polling (works everywhere, no WS dependency issues on servers)
  addLog(`Starting price feed: ${ex.toUpperCase()} ${state.pair}`, 'ws');
  pollTimer = setInterval(() => fetchPrice(), 2000);
  fetchPrice(); // immediate first fetch
}

function fetchPrice() {
  const sym = state.pair.replace('/', '');
  const ex = state.exchange;
  let url;

  if (ex === 'binance' || ex === 'binance_us') {
    const base = ex === 'binance_us' ? 'api.binance.us' : 'api.binance.com';
    url = `https://${base}/api/v3/ticker/price?symbol=${sym}`;
  } else if (ex === 'bybit') {
    url = `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${sym}`;
  } else if (ex === 'okx') {
    url = `https://www.okx.com/api/v5/market/ticker?instId=${state.pair.replace('/', '-')}`;
  } else if (ex === 'mexc') {
    url = `https://api.mexc.com/api/v3/ticker/price?symbol=${sym}`;
  } else {
    url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`;
  }

  httpsGet(url)
    .then(data => {
      let px = 0;
      if (ex === 'binance' || ex === 'binance_us' || ex === 'mexc') {
        px = parseFloat(data.price);
      } else if (ex === 'bybit') {
        px = parseFloat(data.result?.list?.[0]?.lastPrice || 0);
      } else if (ex === 'okx') {
        px = parseFloat(data.data?.[0]?.last || 0);
      }
      if (px && !isNaN(px)) onPriceTick(px);
    })
    .catch(e => addLog('Price fetch error: ' + e.message, 'err'));
}

function onPriceTick(px) {
  state.lastPrice = px;
  priceHistory.push(px); if (priceHistory.length > 200) priceHistory.shift();
  rsiPrices.push(px);    if (rsiPrices.length > 60)    rsiPrices.shift();
  emaPrices.push(px);    if (emaPrices.length > 60)    emaPrices.shift();
  bbPrices.push(px);     if (bbPrices.length > 30)     bbPrices.shift();

  if (state.botOn) runTradingEngine(px);
}

// ─── HTTPS HELPER ───────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CryptoBotPro/1.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

// Signed request for live trading (Binance HMAC-SHA256)
function signedRequest(method, path, params = {}) {
  return new Promise((resolve, reject) => {
    params.timestamp = Date.now();
    params.recvWindow = 5000;
    const query = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const sig = crypto.createHmac('sha256', state.apiSecret).update(query).digest('hex');
    const fullQuery = `${query}&signature=${sig}`;
    const ex = state.exchange;
    const host = ex === 'binance_us' ? 'api.binance.us' : 'api.binance.com';
    const options = {
      hostname: host,
      path: `${path}?${fullQuery}`,
      method,
      headers: {
        'X-MBX-APIKEY': state.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('JSON parse')); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Place a real order (Binance spot)
async function placeOrder(side, quantity, symbol) {
  if (!state.apiKey || !state.apiSecret) {
    addLog('No API keys — cannot place real order', 'err');
    return null;
  }
  try {
    const sym = symbol.replace('/', '');
    const result = await signedRequest('POST', '/api/v3/order', {
      symbol: sym,
      side: side.toUpperCase(),
      type: 'MARKET',
      quantity: quantity.toFixed(6)
    });
    addLog(`Order placed: ${side} ${quantity.toFixed(6)} ${symbol} → ${JSON.stringify(result)}`, 'buy');
    return result;
  } catch(e) {
    addLog(`Order failed: ${e.message}`, 'err');
    return null;
  }
}

// ─── INDICATOR CALCULATIONS ─────────────────────────────────────────────────
function calcRSI(arr, period = 14) {
  if (arr.length < period + 1) return null;
  const r = arr.slice(-(period + 1));
  let g = 0, l = 0;
  for (let i = 1; i < r.length; i++) {
    const d = r[i] - r[i-1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g / period, al = l / period;
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag / al));
}

function calcEMA(arr, p) {
  if (arr.length < p) return null;
  const k = 2 / (p + 1);
  let e = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
  for (let i = p; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}

function calcBB(arr, p = 20) {
  if (arr.length < p) return null;
  const sl = arr.slice(-p);
  const m = sl.reduce((a, b) => a + b, 0) / p;
  const std = Math.sqrt(sl.reduce((a, b) => a + (b - m) ** 2, 0) / p);
  return { upper: m + 2 * std, middle: m, lower: m - 2 * std };
}

// ─── TRADING ENGINE ─────────────────────────────────────────────────────────
function runTradingEngine(px) {
  if (state.tradeCount >= state.maxDaily) {
    return;
  }
  const strat = state.strategy || 'grid';
  if (strat === 'grid') runGridStrategy(px);
  else runIndicatorStrategy(strat, px);
}

// ── GRID ──
function runGridStrategy(px) {
  const sp = state.spacing / 100;
  const tp = state.tp / 100;
  const slp = state.sl / 100;
  const perLvl = state.capital / state.levels;

  if (!state.orders.length) {
    for (let i = 1; i <= state.levels; i++) {
      const bp = px * (1 - sp * i);
      state.orders.push({
        i, bp: round2(bp),
        sellAt: round2(bp * (1 + tp)),
        stopAt: round2(bp * (1 - slp)),
        amt: perLvl, status: 'wait', qty: 0, entryPx: 0
      });
    }
    addLog(`Grid set: ${state.levels} levels. L1 buy@$${state.orders[0].bp.toFixed(2)}`, 'info');
    return;
  }

  let dirty = false;
  state.orders.forEach(o => {
    if (o.status === 'wait' && px <= o.bp) {
      o.status = 'open'; o.qty = o.amt / px; o.entryPx = px;
      addLog(`▲ BUY L${o.i} @ $${px.toFixed(2)} qty:${o.qty.toFixed(6)} cost:$${o.amt.toFixed(2)}`, 'buy');
      // Place real order if API keys set
      if (state.apiKey) placeOrder('BUY', o.qty, state.pair);
      dirty = true;
    }
    if (o.status === 'open') {
      if (px >= o.sellAt) {
        const fee = o.amt * 0.002;
        const net = (px - o.entryPx) * o.qty - fee;
        commitTrade(o, 'SELL', px, net);
        if (state.apiKey) placeOrder('SELL', o.qty, state.pair);
        o.status = 'done'; dirty = true;
        setTimeout(() => {
          o.bp = round2(state.lastPrice * (1 - sp * o.i));
          o.sellAt = round2(o.bp * (1 + tp));
          o.stopAt = round2(o.bp * (1 - slp));
          o.status = 'wait'; o.qty = 0; o.entryPx = 0;
          addLog(`↺ L${o.i} reset → buy@$${o.bp.toFixed(2)}`, 'info');
        }, 3000);
      } else if (px <= o.stopAt) {
        const fee = o.amt * 0.002;
        const net = (px - o.entryPx) * o.qty - fee;
        commitTrade(o, 'STOP', px, net);
        if (state.apiKey) placeOrder('SELL', o.qty, state.pair);
        o.status = 'done'; dirty = true;
        setTimeout(() => {
          o.bp = round2(state.lastPrice * (1 - sp * o.i));
          o.sellAt = round2(o.bp * (1 + tp));
          o.stopAt = round2(o.bp * (1 - slp));
          o.status = 'wait'; o.qty = 0; o.entryPx = 0;
        }, 3000);
      }
    }
  });
  if (dirty) saveState();
}

// ── INDICATOR STRATEGIES ──
function runIndicatorStrategy(strat, px) {
  const tpMap = { rsi: 0.008, ema: 0.012, bb: 0.008, mom: 0.015 };
  const slMap = { rsi: 0.015, ema: 0.015, bb: 0.015, mom: 0.01 };
  const tp = tpMap[strat] || 0.008;
  const slp = slMap[strat] || 0.015;
  const open = state.orders.find(o => o.status === 'open');

  let sig = null;
  if (strat === 'rsi') {
    const rsi = calcRSI(rsiPrices);
    if (rsi !== null) { if (rsi < 30 && !open) sig = 'buy'; else if (rsi > 55 && open) sig = 'sell'; }
  } else if (strat === 'ema') {
    const e9 = calcEMA(emaPrices, 9), e21 = calcEMA(emaPrices, 21);
    const pe9 = calcEMA(emaPrices.slice(0,-1), 9), pe21 = calcEMA(emaPrices.slice(0,-1), 21);
    if (e9 && e21 && pe9 && pe21) {
      if (e9 > e21 && pe9 <= pe21 && !open) sig = 'buy';
      else if (e9 < e21 && open) sig = 'sell';
    }
  } else if (strat === 'bb') {
    const bb = calcBB(bbPrices);
    if (bb) { if (px <= bb.lower && !open) sig = 'buy'; else if (px >= bb.middle && open) sig = 'sell'; }
  } else if (strat === 'mom') {
    if (priceHistory.length >= 5) {
      const mv = (px - priceHistory[priceHistory.length - 5]) / priceHistory[priceHistory.length - 5] * 100;
      if (mv > 1 && !open) sig = 'buy';
      else if (open && (mv < -0.5 || px >= open.sellAt)) sig = 'sell';
    }
  }

  if (sig === 'buy' && !open) {
    const o = { status: 'open', strat, entryPx: px, amt: state.capital,
      qty: state.capital / px, sellAt: round2(px * (1 + tp)), stopAt: round2(px * (1 - slp)), i: 'S' };
    state.orders.push(o);
    addLog(`▲ BUY ${strat} @ $${px.toFixed(2)} TP:$${o.sellAt.toFixed(2)} SL:$${o.stopAt.toFixed(2)}`, 'buy');
    if (state.apiKey) placeOrder('BUY', o.qty, state.pair);
    saveState();
  }

  if (open) {
    let why = null;
    if (sig === 'sell') why = 'Signal';
    else if (px >= open.sellAt) why = 'TP';
    else if (px <= open.stopAt) why = 'SL';
    if (why) {
      const fee = open.amt * 0.002;
      const net = (px - open.entryPx) * open.qty - fee;
      commitTrade(open, why, px, net);
      if (state.apiKey) placeOrder('SELL', open.qty, state.pair);
      open.status = 'closed';
      saveState();
    }
  }
}

function commitTrade(o, side, px, net) {
  state.tradeCount++;
  state.liveProfit += net;
  state.todayProfit += net;
  if (net >= 0) { state.wins++; if (net > state.bestTrade) state.bestTrade = net; }
  else state.losses++;

  const trade = {
    n: state.tradeCount,
    time: new Date().toISOString().slice(11,19),
    pair: state.pair,
    strat: o.strat || 'grid',
    side,
    entryPx: o.entryPx,
    exitPx: px,
    amt: o.amt,
    net
  };
  state.trades.unshift(trade);
  if (state.trades.length > 200) state.trades.pop();

  const emoji = net >= 0 ? '▼ SELL' : '🛑 ' + side;
  addLog(`${emoji} @ $${px.toFixed(2)} | Entry:$${o.entryPx?.toFixed(2)} | NET:${net >= 0 ? '+' : ''}$${net.toFixed(4)}`, net >= 0 ? 'sell' : 'err');
  if (net > 0) addLog(`PROFIT: +$${net.toFixed(4)} ✓`, 'profit');
}

function round2(n) { return Math.round(n * 100) / 100; }

// ─── HTTP API SERVER ─────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // CORS headers — allows your website to talk to this server
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bot-Pin');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const url = req.url.split('?')[0];
  const pin = req.headers['x-bot-pin'];

  // All endpoints except /ping require PIN
  if (url !== '/ping' && pin !== (process.env.BOT_PIN || '123456')) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid PIN' }));
    return;
  }

  // ── GET /ping — health check, no auth ──
  if (req.method === 'GET' && url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: process.uptime().toFixed(0) + 's' }));
    return;
  }

  // ── GET /status — full bot state ──
  if (req.method === 'GET' && url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      botOn: state.botOn,
      strategy: state.strategy,
      pair: state.pair,
      exchange: state.exchange,
      capital: state.capital,
      lastPrice: state.lastPrice,
      liveProfit: state.liveProfit,
      todayProfit: state.todayProfit,
      tradeCount: state.tradeCount,
      wins: state.wins,
      losses: state.losses,
      bestTrade: state.bestTrade,
      winRate: state.tradeCount > 0 ? Math.round(state.wins / state.tradeCount * 100) : 0,
      orders: state.orders,
      trades: state.trades.slice(0, 50),
      log: state.log.slice(0, 100),
      savedAt: state.savedAt,
      startedAt: state.startedAt,
      hasApiKeys: !!(state.apiKey && state.apiSecret)
    }));
    return;
  }

  // ── POST endpoints — parse body ──
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch(e) {}

      // POST /config — save settings + encrypted keys
      if (url === '/config') {
        const { exchange, pair, strategy, capital, levels, spacing, tp, sl, maxDaily, apiKey, apiSecret, passphrase } = data;
        if (exchange) state.exchange = exchange;
        if (pair) state.pair = pair;
        if (strategy) state.strategy = strategy;
        if (capital) state.capital = parseFloat(capital);
        if (levels) state.levels = parseInt(levels);
        if (spacing) state.spacing = parseFloat(spacing);
        if (tp) state.tp = parseFloat(tp);
        if (sl) state.sl = parseFloat(sl);
        if (maxDaily) state.maxDaily = parseInt(maxDaily);
        // Store API keys encrypted
        if (apiKey) state.apiKey = apiKey;
        if (apiSecret) state.apiSecret = apiSecret;
        if (passphrase) state.passphrase = passphrase;
        saveState();
        addLog('Config updated.', 'info');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // POST /start — start the bot
      if (url === '/start') {
        if (state.botOn) { res.writeHead(200); res.end(JSON.stringify({ ok: true, msg: 'Already running' })); return; }
        state.botOn = true;
        state.orders = [];
        state.startedAt = new Date().toISOString();
        connectPriceFeed();
        addLog(`▶ Bot started: ${state.pair} $${state.capital} [${state.strategy}]`, 'buy');
        saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: 'Bot started' }));
        return;
      }

      // POST /stop — stop the bot
      if (url === '/stop') {
        state.botOn = false;
        clearInterval(pollTimer);
        state.orders = [];
        addLog('■ Bot stopped.', 'info');
        saveState();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, msg: 'Bot stopped' }));
        return;
      }

      // POST /reset — reset stats
      if (url === '/reset') {
        state.liveProfit = 0; state.todayProfit = 0; state.tradeCount = 0;
        state.wins = 0; state.losses = 0; state.bestTrade = 0;
        state.trades = []; state.orders = []; state.log = [];
        saveState();
        addLog('Stats reset.', 'info');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' }));
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ─── START ──────────────────────────────────────────────────────────────────
loadState();
server.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════╗`);
  console.log(`║     CryptoBot Pro Server Running     ║`);
  console.log(`║     Port: ${PORT}                       ║`);
  console.log(`║     PIN:  ${process.env.BOT_PIN || '123456'} (set BOT_PIN env)    ║`);
  console.log(`╚══════════════════════════════════════╝\n`);
});

// Resume bot if it was running before restart
if (state.botOn) {
  addLog('Resuming bot from saved state...', 'info');
  state.orders = []; // rebuild orders on next tick
  connectPriceFeed();
}
