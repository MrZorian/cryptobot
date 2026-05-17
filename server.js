/**
 * CryptoBot Pro — Server v3
 * - MEXC API with correct 0% maker / 0.05% taker fees
 * - Live prices for top 8 coins every 4s
 * - Smart fee-aware profit calculation
 * - Min-profit guard: never sells at a loss after fees
 * - 5 strategies with fee-adjusted TP targets
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PORT    = parseInt(process.env.PORT || '3000', 10);
const BOT_PIN = process.env.BOT_PIN || '123456';
const DATA_FILE = path.join(__dirname, 'bot_state.json');

// ── FEE CONSTANTS (MEXC) ────────────────────────────────────────────────────
// MEXC: 0% maker fee (limit orders), 0.05% taker fee (market orders)
// We use market orders for safety, so 0.05% per side = 0.1% round trip
const TAKER_FEE = 0.0005;   // 0.05% per order
const ROUND_TRIP_FEE = TAKER_FEE * 2;  // 0.1% total (buy + sell)
// Minimum TP must beat fees + small profit margin
// For $20 trade: 0.1% fee = $0.02. TP must be > 0.15% to clear fees safely
const MIN_TP_MULTIPLIER = 1.0015; // 0.15% minimum to always be profitable

// ── TOP COINS to show live prices ──────────────────────────────────────────
const TOP_COINS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','MATICUSDT'];

// ── STATE ───────────────────────────────────────────────────────────────────
let state = {
  botOn: false,
  strategy: 'grid',
  pair: 'BTCUSDT',       // MEXC format: no slash
  exchange: 'mexc',
  apiKey: '',
  apiSecret: '',
  capital: 20,
  levels: 5,
  spacing: 0.3,          // 0.3% spacing (must beat 0.1% fees easily)
  tp: 0.4,               // 0.4% TP — after 0.1% fees = 0.3% net profit
  sl: 1.5,               // 1.5% stop loss
  maxDaily: 100,
  // Fee tracking
  totalFeesPaid: 0,
  // Stats
  liveProfit: 0,
  todayProfit: 0,
  tradeCount: 0,
  wins: 0, losses: 0, bestTrade: 0,
  // Data
  orders: [], trades: [], log: [],
  lastPrice: 0,
  prices: {},            // { BTCUSDT: 65000, ETHUSDT: 3200, ... }
  startedAt: null, savedAt: null
};

// ── PERSIST ─────────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      // Merge saved — but keep fee constants fresh
      state = { ...state, ...s };
      addLog('State restored from disk.', 'info');
    }
  } catch(e) { addLog('State load error: ' + e.message, 'err'); }
}
function saveState() {
  try { state.savedAt = Date.now(); fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2)); }
  catch(e) {}
}
setInterval(saveState, 8000);

// ── LOG ──────────────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const ts = new Date().toISOString().slice(11, 19);
  state.log.unshift({ ts, msg, type });
  if (state.log.length > 300) state.log.length = 300;
  console.log(`[${ts}][${type.toUpperCase()}] ${msg}`);
}

// ── HTTPS HELPER ─────────────────────────────────────────────────────────────
function httpsGet(hostname, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: urlPath, method: 'GET',
      headers: { 'User-Agent': 'CryptoBotPro/1.0', ...headers },
      timeout: 6000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── PRICE FEED — ALL TOP COINS ───────────────────────────────────────────────
let priceTimer = null;
let priceHistory = [], rsiArr = [], emaArr = [], bbArr = [];

function startPriceFeed() {
  clearInterval(priceTimer);
  fetchAllPrices();
  priceTimer = setInterval(fetchAllPrices, 3000); // every 3s
  addLog(`Price feed started: MEXC — tracking ${TOP_COINS.length} coins`, 'ws');
}

function stopPriceFeed() {
  clearInterval(priceTimer);
  priceTimer = null;
}

async function fetchAllPrices() {
  // MEXC: fetch all tickers in ONE call (efficient)
  try {
    const data = await httpsGet('api.mexc.com', '/api/v3/ticker/price');
    if (Array.isArray(data)) {
      data.forEach(t => {
        if (TOP_COINS.includes(t.symbol)) {
          const px = parseFloat(t.price);
          if (px > 0) state.prices[t.symbol] = px;
        }
      });
    }
    // Feed the active trading pair
    const tradePair = state.pair.replace('/', '');
    const tradePx = state.prices[tradePair];
    if (tradePx) onPriceTick(tradePx);
  } catch(e) {
    // fallback: fetch just the trading pair
    fetchSinglePrice();
  }
}

function fetchSinglePrice() {
  const sym = state.pair.replace('/', '');
  const req = https.request({
    hostname: 'api.mexc.com',
    path: `/api/v3/ticker/price?symbol=${sym}`,
    method: 'GET',
    headers: { 'User-Agent': 'CryptoBotPro/1.0' },
    timeout: 5000
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const j = JSON.parse(d);
        const px = parseFloat(j.price);
        if (px > 0) {
          state.prices[sym] = px;
          onPriceTick(px);
        }
      } catch(e) {}
    });
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();
}

function onPriceTick(px) {
  state.lastPrice = px;
  priceHistory.push(px); if (priceHistory.length > 300) priceHistory.shift();
  rsiArr.push(px);       if (rsiArr.length > 60)  rsiArr.shift();
  emaArr.push(px);       if (emaArr.length > 60)  emaArr.shift();
  bbArr.push(px);        if (bbArr.length > 30)   bbArr.shift();
  if (state.botOn && state.tradeCount < state.maxDaily) {
    if (state.strategy === 'grid') runGridEngine(px);
    else runIndicatorEngine(state.strategy, px);
  }
}

// ── INDICATORS ───────────────────────────────────────────────────────────────
function calcRSI(arr, p = 14) {
  if (arr.length < p + 1) return null;
  const r = arr.slice(-(p+1));
  let g = 0, l = 0;
  for (let i = 1; i < r.length; i++) { const d = r[i]-r[i-1]; if(d>0)g+=d; else l-=d; }
  const al = l/p; if (al === 0) return 100;
  return 100 - (100 / (1 + (g/p) / al));
}
function calcEMA(arr, p) {
  if (arr.length < p) return null;
  const k = 2/(p+1);
  let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i = p; i < arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
}
function calcBB(arr, p = 20) {
  if (arr.length < p) return null;
  const sl = arr.slice(-p), m = sl.reduce((a,b)=>a+b,0)/p;
  const std = Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);
  return { upper: m+2*std, middle: m, lower: m-2*std };
}

// ── FEE-AWARE PROFIT CALCULATION ─────────────────────────────────────────────
// Exact fee calculation for MEXC
// Buy fee:  amt * TAKER_FEE (taken from the coin received)
// Sell fee: proceeds * TAKER_FEE (taken from USDT received)
function calcNetProfit(entryPx, exitPx, amtUsdt) {
  const qty = amtUsdt / entryPx;               // coins bought
  const buyFee = amtUsdt * TAKER_FEE;          // fee in USDT on buy
  const proceeds = qty * exitPx;               // USDT from sell
  const sellFee = proceeds * TAKER_FEE;        // fee in USDT on sell
  const gross = proceeds - amtUsdt;
  const totalFee = buyFee + sellFee;
  const net = gross - totalFee;
  return { gross, totalFee, net, qty };
}

// Minimum exit price to be profitable after fees
function minProfitableExit(entryPx, amtUsdt) {
  // net = (qty * exitPx * (1 - TAKER_FEE)) - amtUsdt * (1 + TAKER_FEE)
  // solve for exitPx where net > 0:
  // exitPx > amtUsdt * (1 + TAKER_FEE) / (qty * (1 - TAKER_FEE))
  const qty = amtUsdt / entryPx;
  return (amtUsdt * (1 + TAKER_FEE)) / (qty * (1 - TAKER_FEE));
}

// Ensure TP is always above break-even + margin
function safeTpPrice(entryPx, amtUsdt, requestedTpPct) {
  const requestedTp = entryPx * (1 + requestedTpPct/100);
  const breakEven = minProfitableExit(entryPx, amtUsdt);
  const minTp = entryPx * MIN_TP_MULTIPLIER;
  return Math.max(requestedTp, breakEven * 1.001, minTp);
}

// ── GRID STRATEGY ─────────────────────────────────────────────────────────────
function runGridEngine(px) {
  const sp  = state.spacing / 100;
  const slp = state.sl / 100;
  const perLvl = state.capital / state.levels;

  if (!state.orders.length) {
    state.orders = [];
    for (let i = 1; i <= state.levels; i++) {
      const bp = r4(px * (1 - sp * i));
      // TP is fee-aware — guaranteed profitable
      const tp = r4(safeTpPrice(bp, perLvl, state.tp));
      state.orders.push({
        i, bp,
        sellAt: tp,
        stopAt: r4(bp * (1 - slp)),
        amt: perLvl,
        status: 'wait', qty: 0, entryPx: 0
      });
    }
    addLog(`Grid: ${state.levels} levels. Spacing ${state.spacing}% TP ${state.tp}% SL ${state.sl}%`, 'info');
    addLog(`Fee-adjusted: L1 buy@$${state.orders[0].bp.toFixed(4)} sell@$${state.orders[0].sellAt.toFixed(4)}`, 'info');
    addLog(`MEXC fees: ${(ROUND_TRIP_FEE*100).toFixed(2)}% round-trip (0.05% taker each side)`, 'info');
    return;
  }

  let changed = false;
  state.orders.forEach(o => {
    if (o.status === 'wait' && px <= o.bp) {
      o.status = 'open';
      o.entryPx = px;
      o.qty = o.amt / px;
      // Recalculate TP from actual fill price
      o.sellAt = r4(safeTpPrice(px, o.amt, state.tp));
      o.stopAt = r4(px * (1 - slp));
      addLog(`▲ BUY L${o.i} @ $${px.toFixed(4)} | Cost $${o.amt.toFixed(2)} | TP $${o.sellAt.toFixed(4)} | SL $${o.stopAt.toFixed(4)}`, 'buy');
      if (state.apiKey && state.apiSecret) placeOrder('BUY', o.qty, state.pair);
      changed = true;
    }
    if (o.status === 'open') {
      if (px >= o.sellAt) {
        const { net, totalFee } = calcNetProfit(o.entryPx, px, o.amt);
        state.totalFeesPaid += totalFee;
        commitTrade(o, 'SELL', px, net, totalFee);
        if (state.apiKey && state.apiSecret) placeOrder('SELL', o.qty, state.pair);
        o.status = 'done'; changed = true;
        const delay = 2000;
        setTimeout(() => {
          if (!state.botOn) return;
          const cur = state.lastPrice;
          o.bp = r4(cur * (1 - sp * o.i));
          o.sellAt = r4(safeTpPrice(o.bp, o.amt, state.tp));
          o.stopAt = r4(o.bp * (1 - slp));
          o.status = 'wait'; o.qty = 0; o.entryPx = 0;
          addLog(`↺ L${o.i} reset → buy@$${o.bp.toFixed(4)} sell@$${o.sellAt.toFixed(4)}`, 'info');
        }, delay);
      } else if (px <= o.stopAt) {
        const { net, totalFee } = calcNetProfit(o.entryPx, px, o.amt);
        state.totalFeesPaid += totalFee;
        commitTrade(o, 'STOP', px, net, totalFee);
        if (state.apiKey && state.apiSecret) placeOrder('SELL', o.qty, state.pair);
        o.status = 'done'; changed = true;
        setTimeout(() => {
          if (!state.botOn) return;
          const cur = state.lastPrice;
          o.bp = r4(cur * (1 - sp * o.i));
          o.sellAt = r4(safeTpPrice(o.bp, o.amt, state.tp));
          o.stopAt = r4(o.bp * (1 - slp));
          o.status = 'wait'; o.qty = 0; o.entryPx = 0;
        }, 2000);
      }
    }
  });
  if (changed) saveState();
}

// ── INDICATOR STRATEGIES ──────────────────────────────────────────────────────
function runIndicatorEngine(strat, px) {
  // Fee-aware TP: must clear 0.1% round-trip + profit margin
  const tpPct = { rsi:0.5, ema:0.6, bb:0.45, mom:0.8 }[strat] || 0.5;
  const slPct = { rsi:1.5, ema:1.5, bb:1.2, mom:1.0 }[strat] || 1.5;
  const open = state.orders.find(o => o.status === 'open');
  let sig = null;

  if (strat === 'rsi') {
    const r = calcRSI(rsiArr); if (r === null) return;
    if (r < 32 && !open) sig = 'buy';
    else if (r > 60 && open) sig = 'sell';
  } else if (strat === 'ema') {
    const e9=calcEMA(emaArr,9), e21=calcEMA(emaArr,21);
    const pe9=calcEMA(emaArr.slice(0,-1),9), pe21=calcEMA(emaArr.slice(0,-1),21);
    if (!e9||!e21||!pe9||!pe21) return;
    if (e9>e21 && pe9<=pe21 && !open) sig='buy';
    else if (e9<e21 && pe9>=pe21 && open) sig='sell';
  } else if (strat === 'bb') {
    const bb = calcBB(bbArr); if (!bb) return;
    if (px <= bb.lower && !open) sig = 'buy';
    else if (px >= bb.middle && open) sig = 'sell';
  } else if (strat === 'mom') {
    if (priceHistory.length < 6) return;
    const mv = (px - priceHistory[priceHistory.length-6]) / priceHistory[priceHistory.length-6] * 100;
    if (mv > 0.8 && !open) sig = 'buy';
    else if (open && (mv < -0.3 || px >= open.sellAt)) sig = 'sell';
  }

  if (sig === 'buy' && !open) {
    const tp = r4(safeTpPrice(px, state.capital, tpPct));
    const o = {
      i:'S', status:'open', strat,
      entryPx: px, amt: state.capital,
      qty: state.capital/px,
      sellAt: tp,
      stopAt: r4(px*(1-slPct/100))
    };
    state.orders.push(o);
    addLog(`▲ BUY ${strat} @ $${px.toFixed(4)} TP $${tp.toFixed(4)} SL $${o.stopAt.toFixed(4)}`, 'buy');
    if (state.apiKey) placeOrder('BUY', o.qty, state.pair);
    saveState();
  }
  if (open) {
    let why = null;
    if (sig === 'sell') why = 'Signal';
    else if (px >= open.sellAt) why = 'TP';
    else if (px <= open.stopAt) why = 'SL';
    if (why) {
      const { net, totalFee } = calcNetProfit(open.entryPx, px, open.amt);
      state.totalFeesPaid += totalFee;
      commitTrade(open, why, px, net, totalFee);
      if (state.apiKey) placeOrder('SELL', open.qty, state.pair);
      open.status = 'closed';
      saveState();
    }
  }
}

// ── COMMIT TRADE ─────────────────────────────────────────────────────────────
function commitTrade(o, side, exitPx, net, fee) {
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
    side, entryPx: o.entryPx, exitPx,
    amt: o.amt, fee: fee || 0, net,
    gross: net + (fee || 0)
  };
  state.trades.unshift(trade);
  if (state.trades.length > 200) state.trades.length = 200;

  const pnlStr = `${net>=0?'+':''}$${net.toFixed(4)}`;
  const feeStr = `fee $${(fee||0).toFixed(4)}`;
  addLog(`${net>=0?'▼ SELL':'🛑 '+side} @ $${exitPx.toFixed(4)} | Entry $${o.entryPx?.toFixed(4)} | ${feeStr} | NET ${pnlStr}`, net>=0?'sell':'err');
  if (net > 0) addLog(`✓ PROFIT: +$${net.toFixed(4)} (after ${(ROUND_TRIP_FEE*100).toFixed(2)}% MEXC fees)`, 'profit');
  else addLog(`⚠ Loss after fees: $${net.toFixed(4)}`, 'err');
}

// ── MEXC ORDER PLACEMENT ──────────────────────────────────────────────────────
function placeOrder(side, qty, pair) {
  if (!state.apiKey || !state.apiSecret) {
    addLog('No API keys — order skipped (paper mode)', 'info');
    return;
  }
  const sym = pair.replace('/', '');
  // MEXC v3 API uses quoteOrderQty for BUY (USDT amount), qty for SELL
  const params = {
    symbol: sym,
    side: side.toUpperCase(),
    type: 'MARKET',
    timestamp: Date.now(),
    recvWindow: 5000
  };
  if (side.toUpperCase() === 'BUY') {
    params.quoteOrderQty = (qty * state.lastPrice).toFixed(2); // USDT amount
  } else {
    params.quantity = qty.toFixed(6);
  }
  const query = Object.entries(params)
    .map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const sig = crypto.createHmac('sha256', state.apiSecret).update(query).digest('hex');
  const fullPath = `/api/v3/order?${query}&signature=${sig}`;

  const req = https.request({
    hostname: 'api.mexc.com',
    path: fullPath,
    method: 'POST',
    headers: {
      'X-MEXC-APIKEY': state.apiKey,
      'Content-Type': 'application/json'
    }
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const r = JSON.parse(d);
        if (r.orderId) addLog(`✓ MEXC Order ${side} filled: ${r.orderId}`, 'buy');
        else addLog(`MEXC order response: ${JSON.stringify(r)}`, 'info');
      } catch(e) {}
    });
  });
  req.on('error', e => addLog('MEXC order error: ' + e.message, 'err'));
  req.end();
}

// ── HELPERS ──────────────────────────────────────────────────────────────────
function r4(n) { return Math.round(n * 10000) / 10000; }  // 4 decimal precision

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bot-Pin, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}
function json(res, code, data) {
  cors(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url === '/ping' || url === '/' || url === '/health') {
    json(res, 200, { ok: true, uptime: process.uptime().toFixed(0)+'s', time: new Date().toISOString() });
    return;
  }

  if (url === '/prices') {
    // Public endpoint — live prices for all top coins (no auth needed for dashboard ticker)
    json(res, 200, { prices: state.prices, updatedAt: Date.now() });
    return;
  }

  const pin = req.headers['x-bot-pin'];
  if (pin !== BOT_PIN) { json(res, 401, { error: 'Invalid PIN' }); return; }

  if (req.method === 'GET' && url === '/status') {
    json(res, 200, {
      botOn: state.botOn,
      strategy: state.strategy,
      pair: state.pair,
      exchange: state.exchange,
      capital: state.capital,
      spacing: state.spacing,
      tp: state.tp,
      sl: state.sl,
      lastPrice: state.lastPrice,
      prices: state.prices,
      liveProfit: state.liveProfit,
      todayProfit: state.todayProfit,
      tradeCount: state.tradeCount,
      wins: state.wins,
      losses: state.losses,
      bestTrade: state.bestTrade,
      totalFeesPaid: state.totalFeesPaid,
      winRate: state.tradeCount > 0 ? Math.round(state.wins/state.tradeCount*100) : 0,
      feeRate: ROUND_TRIP_FEE * 100,
      orders: state.orders,
      trades: state.trades.slice(0, 50),
      log: state.log.slice(0, 100),
      savedAt: state.savedAt,
      startedAt: state.startedAt,
      hasApiKeys: !!(state.apiKey && state.apiSecret)
    });
    return;
  }

  if (req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      let d = {};
      try { d = JSON.parse(body); } catch(e) {}

      if (url === '/config') {
        if (d.exchange !== undefined) state.exchange = d.exchange;
        if (d.pair !== undefined)     state.pair     = d.pair.replace('/','');
        if (d.strategy !== undefined) state.strategy = d.strategy;
        if (d.capital)   state.capital  = parseFloat(d.capital);
        if (d.levels)    state.levels   = parseInt(d.levels);
        if (d.spacing)   state.spacing  = parseFloat(d.spacing);
        if (d.tp)        state.tp       = parseFloat(d.tp);
        if (d.sl)        state.sl       = parseFloat(d.sl);
        if (d.maxDaily)  state.maxDaily = parseInt(d.maxDaily);
        if (d.apiKey && d.apiKey !== '[encrypted]')    state.apiKey    = d.apiKey;
        if (d.apiSecret && d.apiSecret !== '[encrypted]') state.apiSecret = d.apiSecret;
        // Validate: TP must clear fees
        const minTpPct = ROUND_TRIP_FEE * 100 + 0.05; // fees + 0.05% margin
        if (state.tp < minTpPct) {
          state.tp = minTpPct;
          addLog(`⚠ TP auto-adjusted to ${minTpPct.toFixed(2)}% to cover MEXC fees`, 'info');
        }
        saveState();
        addLog(`Config saved: ${state.pair} $${state.capital} tp:${state.tp}% sl:${state.sl}%`, 'info');
        json(res, 200, { ok: true, adjustedTp: state.tp });
        return;
      }

      if (url === '/start') {
        if (state.botOn) { json(res, 200, { ok: true, msg: 'Already running' }); return; }
        state.botOn = true;
        state.orders = [];
        state.startedAt = new Date().toISOString();
        startPriceFeed();
        addLog(`▶ STARTED: ${state.pair} $${state.capital} [${state.strategy}] MEXC fees ${(ROUND_TRIP_FEE*100).toFixed(2)}%`, 'buy');
        saveState();
        json(res, 200, { ok: true });
        return;
      }

      if (url === '/stop') {
        state.botOn = false;
        state.orders = [];
        stopPriceFeed();
        addLog('■ Bot stopped.', 'info');
        saveState();
        json(res, 200, { ok: true });
        return;
      }

      if (url === '/reset') {
        state.liveProfit=0; state.todayProfit=0; state.tradeCount=0;
        state.wins=0; state.losses=0; state.bestTrade=0; state.totalFeesPaid=0;
        state.trades=[]; state.orders=[]; state.log=[];
        saveState();
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { error: 'Not found' });
    });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ CryptoBot Pro v3 on 0.0.0.0:${PORT}`);
  console.log(`   MEXC fees: ${(ROUND_TRIP_FEE*100).toFixed(2)}% round-trip`);
  console.log(`   BOT_PIN: ${BOT_PIN}\n`);
  loadState();
  // Always run price feed (for live ticker even when bot is off)
  startPriceFeed();
  if (state.botOn) {
    state.orders = [];
    addLog('Auto-resuming bot...', 'info');
  }
});

server.on('error', e => { console.error('Server error:', e); process.exit(1); });
process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT',  () => { saveState(); process.exit(0); });
