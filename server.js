/**
 * CryptoBot Pro — Node.js 24/7 Trading Server
 * Fixed: PORT binding, CORS preflight, Railway compatibility
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ── PORT — Railway injects this automatically, MUST use process.env.PORT ──
const PORT = parseInt(process.env.PORT || '3000', 10);
const BOT_PIN = process.env.BOT_PIN || '123456';
const DATA_FILE = path.join(__dirname, 'bot_state.json');

console.log(`Starting CryptoBot Pro...`);
console.log(`PORT: ${PORT}`);
console.log(`BOT_PIN: ${BOT_PIN}`);

// ── STATE ──────────────────────────────────────────────────────────────────
let state = {
  botOn: false,
  strategy: 'grid',
  pair: 'BTC/USDT',
  exchange: 'binance',
  apiKey: '',
  apiSecret: '',
  passphrase: '',
  capital: 20,
  levels: 5,
  spacing: 0.5,
  tp: 0.8,
  sl: 2.0,
  maxDaily: 100,
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

// ── PERSIST ────────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const s = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      state = { ...state, ...s };
      addLog('State loaded from disk.', 'info');
    }
  } catch(e) { addLog('Load state error: ' + e.message, 'err'); }
}

function saveState() {
  try {
    state.savedAt = Date.now();
    fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2));
  } catch(e) { /* silent */ }
}

setInterval(saveState, 10000);

// ── LOG ────────────────────────────────────────────────────────────────────
function addLog(msg, type = 'info') {
  const ts = new Date().toISOString().slice(11, 19);
  state.log.unshift({ ts, msg, type });
  if (state.log.length > 300) state.log.length = 300;
  console.log(`[${ts}] [${type}] ${msg}`);
}

// ── PRICE FEED ─────────────────────────────────────────────────────────────
let pollTimer = null;
let priceHistory = [], rsiArr = [], emaArr = [], bbArr = [];

function startPriceFeed() {
  clearInterval(pollTimer);
  addLog(`Price feed: ${state.exchange.toUpperCase()} ${state.pair}`, 'ws');
  fetchPrice();
  pollTimer = setInterval(fetchPrice, 3000);
}

function stopPriceFeed() {
  clearInterval(pollTimer);
  pollTimer = null;
}

function fetchPrice() {
  const sym = state.pair.replace('/', '');
  const ex = state.exchange;
  let host, urlPath;

  if (ex === 'binance' || ex === 'binance_us') {
    host = ex === 'binance_us' ? 'api.binance.us' : 'api.binance.com';
    urlPath = `/api/v3/ticker/price?symbol=${sym}`;
  } else if (ex === 'bybit') {
    host = 'api.bybit.com';
    urlPath = `/v5/market/tickers?category=spot&symbol=${sym}`;
  } else if (ex === 'okx') {
    host = 'www.okx.com';
    urlPath = `/api/v5/market/ticker?instId=${state.pair.replace('/', '-')}`;
  } else if (ex === 'mexc') {
    host = 'api.mexc.com';
    urlPath = `/api/v3/ticker/price?symbol=${sym}`;
  } else {
    host = 'api.binance.com';
    urlPath = `/api/v3/ticker/price?symbol=${sym}`;
  }

  const options = {
    hostname: host,
    path: urlPath,
    method: 'GET',
    headers: { 'User-Agent': 'CryptoBotPro/1.0' },
    timeout: 5000
  };

  const req = https.request(options, res => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const d = JSON.parse(data);
        let px = 0;
        if (ex === 'binance' || ex === 'binance_us' || ex === 'mexc') px = parseFloat(d.price);
        else if (ex === 'bybit') px = parseFloat(d.result?.list?.[0]?.lastPrice || 0);
        else if (ex === 'okx') px = parseFloat(d.data?.[0]?.last || 0);
        if (px > 0 && !isNaN(px)) onPriceTick(px);
      } catch(e) { addLog('Price parse error: ' + e.message, 'err'); }
    });
  });
  req.on('error', e => addLog('Price fetch error: ' + e.message, 'err'));
  req.on('timeout', () => { req.destroy(); });
  req.end();
}

function onPriceTick(px) {
  state.lastPrice = px;
  priceHistory.push(px); if (priceHistory.length > 200) priceHistory.shift();
  rsiArr.push(px);       if (rsiArr.length > 60)        rsiArr.shift();
  emaArr.push(px);       if (emaArr.length > 60)        emaArr.shift();
  bbArr.push(px);        if (bbArr.length > 30)         bbArr.shift();
  if (state.botOn && state.tradeCount < state.maxDaily) {
    if (state.strategy === 'grid') runGridEngine(px);
    else runIndicatorEngine(state.strategy, px);
  }
}

// ── INDICATORS ─────────────────────────────────────────────────────────────
function rsi(arr, p = 14) {
  if (arr.length < p + 1) return null;
  const r = arr.slice(-(p + 1));
  let g = 0, l = 0;
  for (let i = 1; i < r.length; i++) { const d = r[i]-r[i-1]; if(d>0)g+=d; else l-=d; }
  const al = l/p; if(al===0) return 100;
  return 100 - (100 / (1 + (g/p)/al));
}
function ema(arr, p) {
  if (arr.length < p) return null;
  const k = 2/(p+1);
  let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p;i<arr.length;i++) e=arr[i]*k+e*(1-k);
  return e;
}
function boll(arr, p = 20) {
  if (arr.length < p) return null;
  const sl = arr.slice(-p), m = sl.reduce((a,b)=>a+b,0)/p;
  const std = Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);
  return { upper: m+2*std, middle: m, lower: m-2*std };
}

// ── GRID STRATEGY ──────────────────────────────────────────────────────────
function runGridEngine(px) {
  const sp = state.spacing/100, tp = state.tp/100, slp = state.sl/100;
  const perLvl = state.capital / state.levels;

  if (!state.orders.length) {
    state.orders = [];
    for (let i = 1; i <= state.levels; i++) {
      const bp = r2(px * (1 - sp * i));
      state.orders.push({ i, bp, sellAt: r2(bp*(1+tp)), stopAt: r2(bp*(1-slp)), amt: perLvl, status: 'wait', qty: 0, entryPx: 0 });
    }
    addLog(`Grid: ${state.levels} levels. L1 buy@$${state.orders[0].bp.toFixed(2)} L${state.levels} buy@$${state.orders[state.levels-1].bp.toFixed(2)}`, 'info');
    return;
  }

  let changed = false;
  state.orders.forEach(o => {
    if (o.status === 'wait' && px <= o.bp) {
      o.status = 'open'; o.qty = o.amt / px; o.entryPx = px;
      addLog(`▲ BUY L${o.i} @ $${px.toFixed(2)} qty:${o.qty.toFixed(6)} cost:$${o.amt.toFixed(2)}`, 'buy');
      if (state.apiKey && state.apiSecret) placeExchangeOrder('BUY', o.qty, state.pair);
      changed = true;
    }
    if (o.status === 'open') {
      if (px >= o.sellAt) {
        const net = (px - o.entryPx) * o.qty - o.amt * 0.002;
        commitTrade(o, 'SELL', px, net);
        if (state.apiKey && state.apiSecret) placeExchangeOrder('SELL', o.qty, state.pair);
        o.status = 'done'; changed = true;
        setTimeout(() => { if (!state.botOn) return; o.bp=r2(state.lastPrice*(1-sp*o.i)); o.sellAt=r2(o.bp*(1+tp)); o.stopAt=r2(o.bp*(1-slp)); o.status='wait'; o.qty=0; o.entryPx=0; addLog(`↺ L${o.i} reset → buy@$${o.bp.toFixed(2)}`,'info'); }, 3000);
      } else if (px <= o.stopAt) {
        const net = (px - o.entryPx) * o.qty - o.amt * 0.002;
        commitTrade(o, 'STOP', px, net);
        if (state.apiKey && state.apiSecret) placeExchangeOrder('SELL', o.qty, state.pair);
        o.status = 'done'; changed = true;
        setTimeout(() => { if (!state.botOn) return; o.bp=r2(state.lastPrice*(1-sp*o.i)); o.sellAt=r2(o.bp*(1+tp)); o.stopAt=r2(o.bp*(1-slp)); o.status='wait'; o.qty=0; o.entryPx=0; }, 3000);
      }
    }
  });
  if (changed) saveState();
}

// ── INDICATOR STRATEGIES ────────────────────────────────────────────────────
function runIndicatorEngine(strat, px) {
  const tpP = { rsi:0.008, ema:0.012, bb:0.008, mom:0.015 }[strat] || 0.008;
  const slP = { rsi:0.015, ema:0.015, bb:0.015, mom:0.01 }[strat] || 0.015;
  const open = state.orders.find(o => o.status === 'open');
  let sig = null;

  if (strat === 'rsi') {
    const r = rsi(rsiArr); if (r===null) return;
    if (r < 30 && !open) sig = 'buy'; else if (r > 55 && open) sig = 'sell';
  } else if (strat === 'ema') {
    const e9=ema(emaArr,9), e21=ema(emaArr,21), pe9=ema(emaArr.slice(0,-1),9), pe21=ema(emaArr.slice(0,-1),21);
    if (!e9||!e21||!pe9||!pe21) return;
    if (e9>e21 && pe9<=pe21 && !open) sig='buy'; else if (e9<e21 && open) sig='sell';
  } else if (strat === 'bb') {
    const bb = boll(bbArr); if (!bb) return;
    if (px<=bb.lower && !open) sig='buy'; else if (px>=bb.middle && open) sig='sell';
  } else if (strat === 'mom') {
    if (priceHistory.length < 5) return;
    const mv = (px - priceHistory[priceHistory.length-5]) / priceHistory[priceHistory.length-5] * 100;
    if (mv > 1 && !open) sig='buy'; else if (open && mv < -0.5) sig='sell';
  }

  if (sig === 'buy' && !open) {
    const o = { i:'S', status:'open', strat, entryPx:px, amt:state.capital, qty:state.capital/px, sellAt:r2(px*(1+tpP)), stopAt:r2(px*(1-slP)) };
    state.orders.push(o);
    addLog(`▲ BUY ${strat} @ $${px.toFixed(2)} TP:$${o.sellAt.toFixed(2)} SL:$${o.stopAt.toFixed(2)}`, 'buy');
    if (state.apiKey) placeExchangeOrder('BUY', o.qty, state.pair);
    saveState();
  }
  if (open) {
    const why = sig==='sell' ? 'Signal' : px>=open.sellAt ? 'TP' : px<=open.stopAt ? 'SL' : null;
    if (why) {
      const net = (px - open.entryPx) * open.qty - open.amt * 0.002;
      commitTrade(open, why, px, net);
      if (state.apiKey) placeExchangeOrder('SELL', open.qty, state.pair);
      open.status = 'closed';
      saveState();
    }
  }
}

function commitTrade(o, side, px, net) {
  state.tradeCount++; state.liveProfit += net; state.todayProfit += net;
  if (net >= 0) { state.wins++; if (net > state.bestTrade) state.bestTrade = net; } else state.losses++;
  state.trades.unshift({ n:state.tradeCount, time:new Date().toISOString().slice(11,19), pair:state.pair, strat:o.strat||'grid', side, entryPx:o.entryPx, exitPx:px, amt:o.amt, net });
  if (state.trades.length > 200) state.trades.length = 200;
  addLog(`${net>=0?'▼ SELL':'🛑 '+side} @ $${px.toFixed(2)} Entry:$${o.entryPx?.toFixed(2)} NET:${net>=0?'+':''}$${net.toFixed(4)}`, net>=0?'sell':'err');
  if (net > 0) addLog(`PROFIT: +$${net.toFixed(4)} ✓`, 'profit');
}

// ── PLACE REAL ORDER (Binance) ──────────────────────────────────────────────
function placeExchangeOrder(side, qty, pair) {
  if (!state.apiKey || !state.apiSecret) return;
  const sym = pair.replace('/', '');
  const params = { symbol:sym, side:side.toUpperCase(), type:'MARKET', quantity:qty.toFixed(6), timestamp:Date.now(), recvWindow:5000 };
  const query = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
  const sig = crypto.createHmac('sha256', state.apiSecret).update(query).digest('hex');
  const host = state.exchange==='binance_us' ? 'api.binance.us' : 'api.binance.com';
  const req = https.request({ hostname:host, path:`/api/v3/order?${query}&signature=${sig}`, method:'POST', headers:{'X-MBX-APIKEY':state.apiKey} }, res => {
    let d=''; res.on('data',c=>d+=c); res.on('end',()=>{try{const r=JSON.parse(d);addLog(`Exchange order: ${JSON.stringify(r)}`,'info');}catch(e){}});
  });
  req.on('error', e => addLog('Exchange order error: '+e.message,'err'));
  req.end();
}

function r2(n) { return Math.round(n * 100) / 100; }

// ── HTTP SERVER ─────────────────────────────────────────────────────────────
// CRITICAL: Must set ALL CORS headers before any response, including errors
function setCORSHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bot-Pin, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJSON(res, code, data) {
  setCORSHeaders(res);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  // MUST handle OPTIONS preflight FIRST before anything else
  if (req.method === 'OPTIONS') {
    setCORSHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // /ping — no auth, used for connectivity test
  if (req.method === 'GET' && url === '/ping') {
    sendJSON(res, 200, { ok: true, uptime: process.uptime().toFixed(0) + 's', time: new Date().toISOString() });
    return;
  }

  // /health — Railway uses this to check if server is alive
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    sendJSON(res, 200, { ok: true, status: 'CryptoBot Pro running', botOn: state.botOn });
    return;
  }

  // All other routes need PIN
  const pin = req.headers['x-bot-pin'];
  if (pin !== BOT_PIN) {
    sendJSON(res, 401, { error: 'Invalid PIN' });
    return;
  }

  // GET /status
  if (req.method === 'GET' && url === '/status') {
    sendJSON(res, 200, {
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
      winRate: state.tradeCount > 0 ? Math.round(state.wins/state.tradeCount*100) : 0,
      orders: state.orders,
      trades: state.trades.slice(0, 50),
      log: state.log.slice(0, 100),
      savedAt: state.savedAt,
      startedAt: state.startedAt,
      hasApiKeys: !!(state.apiKey && state.apiSecret)
    });
    return;
  }

  // POST routes — parse body first
  if (req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      let data = {};
      try { data = JSON.parse(body); } catch(e) {}

      if (url === '/config') {
        const fields = ['exchange','pair','strategy','capital','levels','spacing','tp','sl','maxDaily','apiKey','apiSecret','passphrase'];
        fields.forEach(f => { if (data[f] !== undefined && data[f] !== '') { const n=parseFloat(data[f]); state[f] = isNaN(n)||typeof data[f]==='string'&&data[f].length>10 ? data[f] : n; }});
        if (data.capital) state.capital = parseFloat(data.capital);
        if (data.levels)  state.levels  = parseInt(data.levels);
        if (data.maxDaily) state.maxDaily = parseInt(data.maxDaily);
        saveState();
        addLog('Config updated.', 'info');
        sendJSON(res, 200, { ok: true });
        return;
      }

      if (url === '/start') {
        if (state.botOn) { sendJSON(res, 200, { ok: true, msg: 'Already running' }); return; }
        state.botOn = true;
        state.orders = [];
        state.startedAt = new Date().toISOString();
        startPriceFeed();
        addLog(`▶ Bot started: ${state.pair} $${state.capital} [${state.strategy}]`, 'buy');
        saveState();
        sendJSON(res, 200, { ok: true, msg: 'Bot started' });
        return;
      }

      if (url === '/stop') {
        state.botOn = false;
        state.orders = [];
        stopPriceFeed();
        addLog('■ Bot stopped.', 'info');
        saveState();
        sendJSON(res, 200, { ok: true, msg: 'Bot stopped' });
        return;
      }

      if (url === '/reset') {
        state.liveProfit=0; state.todayProfit=0; state.tradeCount=0;
        state.wins=0; state.losses=0; state.bestTrade=0;
        state.trades=[]; state.orders=[]; state.log=[];
        saveState();
        sendJSON(res, 200, { ok: true });
        return;
      }

      sendJSON(res, 404, { error: 'Not found' });
    });
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

// ── BIND TO PORT ────────────────────────────────────────────────────────────
// CRITICAL: Must listen on 0.0.0.0 (all interfaces), NOT localhost
// Railway routes traffic to whatever port process.env.PORT says
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ CryptoBot Pro server listening on 0.0.0.0:${PORT}`);
  console.log(`   Ping URL: http://0.0.0.0:${PORT}/ping`);
  console.log(`   BOT_PIN: ${BOT_PIN}\n`);
  loadState();
  // Auto-resume if bot was running before restart
  if (state.botOn) {
    state.orders = [];
    addLog('Auto-resuming bot from saved state...', 'info');
    startPriceFeed();
  }
});

server.on('error', err => {
  console.error('Server error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => { saveState(); process.exit(0); });
process.on('SIGINT',  () => { saveState(); process.exit(0); });
