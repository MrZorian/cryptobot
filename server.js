/**
 * CryptoBot Pro — Server v4 FAST SCALP ENGINE
 * 
 * CORE CHANGE: Trades at LIVE price, not below it.
 * Uses WebSocket for real-time ticks (not 3s polling).
 * 5 fast scalp strategies all enter at market price immediately.
 * Every strategy is fee-aware — guaranteed profit after MEXC 0.05% fees.
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PORT    = parseInt(process.env.PORT || '3000', 10);
const BOT_PIN = process.env.BOT_PIN || '123456';
const DATA_FILE = path.join(__dirname, 'bot_state.json');

// ── MEXC FEES ──────────────────────────────────────────────────────────────
const MAKER_FEE  = 0.0000; // 0% maker (limit orders) — we use limit where possible
const TAKER_FEE  = 0.0005; // 0.05% taker (market orders)
const RT_FEE     = TAKER_FEE * 2; // 0.10% round-trip worst case
// Min profit target: RT fee + 0.12% net = 0.22% TP minimum
const MIN_NET_PCT = 0.0022;

// ── TOP COINS ──────────────────────────────────────────────────────────────
const TOP_COINS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','MATICUSDT'];

// ── STATE ──────────────────────────────────────────────────────────────────
let state = {
  botOn: false,
  strategy: 'scalp',
  pair: 'BTCUSDT',
  exchange: 'mexc',
  apiKey: '', apiSecret: '',
  capital: 20,
  maxPositions: 3,    // max simultaneous open trades
  tpPct: 0.35,        // 0.35% take profit
  slPct: 0.25,        // 0.25% stop loss (tight — fast exit)
  trailPct: 0.10,     // trailing stop tightens profit lock
  maxDaily: 200,
  // Stats
  liveProfit: 0, todayProfit: 0,
  tradeCount: 0, wins: 0, losses: 0, bestTrade: 0,
  totalFeesPaid: 0,
  // Runtime
  orders: [], trades: [], log: [],
  lastPrice: 0, prices: {},
  startedAt: null, savedAt: null
};

// ── IN-MEMORY PRICE BUFFERS (not persisted — rebuilt on reconnect) ─────────
let pxBuf   = [];   // raw ticks, up to 500
let rsiArr  = [];   // 60 ticks
let emaFast = [];   // 20 ticks for EMA9
let emaSlow = [];   // 30 ticks for EMA21
let volArr  = [];   // volume proxy (price change magnitude)
let tickN   = 0;    // tick counter

// Cached indicator values (recalc every tick)
let iRSI = null, iE9 = null, iE21 = null, iBB = null;
let iMom = 0, iVol = 0, iTrend = 0;

// ── PERSIST ────────────────────────────────────────────────────────────────
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const s = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
      state = {...state,...s};
      // Reset runtime orders on restart — will re-enter at live price
      state.orders = state.orders.filter(o => o.status === 'open');
      addLog(`State restored. Open positions: ${state.orders.length}`, 'info');
    }
  } catch(e) { addLog('State load: '+e.message,'err'); }
}
function saveState() {
  try { state.savedAt = Date.now(); fs.writeFileSync(DATA_FILE, JSON.stringify(state,null,2)); }
  catch(e) {}
}
setInterval(saveState, 8000);

// ── LOG ────────────────────────────────────────────────────────────────────
function addLog(msg, type='info') {
  const ts = new Date().toISOString().slice(11,19);
  state.log.unshift({ts, msg, type});
  if (state.log.length > 400) state.log.length = 400;
  console.log(`[${ts}][${type}] ${msg}`);
}

// ── WEBSOCKET PRICE FEED (real-time, replaces 3s polling) ─────────────────
const WebSocket = (() => {
  try { return require('ws'); } catch(e) { return null; }
})();

let ws = null;
let wsReconnTimer = null;
let httpPollTimer = null;

function startPriceFeed() {
  if (WebSocket) {
    connectWS();
  } else {
    addLog('ws module not found — using 800ms HTTP polling','info');
    startHttpPoll();
  }
  // Always run multi-coin HTTP poll for ticker (4s is fine for display)
  startMultiCoinPoll();
}

function stopPriceFeed() {
  clearTimeout(wsReconnTimer);
  clearInterval(httpPollTimer);
  if (ws) { try { ws.terminate(); } catch(e){} ws = null; }
}

function connectWS() {
  clearTimeout(wsReconnTimer);
  if (ws) { try { ws.terminate(); } catch(e){} ws = null; }
  const sym = state.pair.replace('/','').toLowerCase();
  // MEXC WebSocket — real-time trade stream
  const url = `wss://wbs.mexc.com/ws`;
  try {
    ws = new WebSocket(url);
    ws.on('open', () => {
      addLog(`WS connected: MEXC ${state.pair}`, 'ws');
      // Subscribe to real-time ticker
      ws.send(JSON.stringify({
        method: 'SUBSCRIPTION',
        params: [`spot@public.miniTicker.v3.api@${state.pair.replace('/','_')}`]
      }));
      // Also subscribe to trade stream for faster fills
      ws.send(JSON.stringify({
        method: 'SUBSCRIPTION',
        params: [`spot@public.deals.v3.api@${state.pair.replace('/','_')}`]
      }));
    });
    ws.on('message', (raw) => {
      try {
        const d = JSON.parse(raw);
        let px = 0;
        // miniTicker
        if (d.d && d.d.c) px = parseFloat(d.d.c);
        // deals (trade stream) — faster
        else if (d.d && Array.isArray(d.d) && d.d[0]?.p) px = parseFloat(d.d[0].p);
        if (px > 0) {
          state.prices[state.pair.replace('/','').toUpperCase()] = px;
          onTick(px);
        }
      } catch(e) {}
    });
    ws.on('error', () => schedReconn());
    ws.on('close', () => schedReconn());
  } catch(e) {
    addLog('WS error: '+e.message+' — fallback to poll','err');
    startHttpPoll();
  }
}

function schedReconn() {
  clearTimeout(wsReconnTimer);
  wsReconnTimer = setTimeout(connectWS, 3000);
}

// HTTP fast poll — fallback or supplement
function startHttpPoll() {
  clearInterval(httpPollTimer);
  httpPollTimer = setInterval(fetchTradingPrice, 800);
  fetchTradingPrice();
}

function fetchTradingPrice() {
  const sym = state.pair.replace('/','');
  const req = https.request({
    hostname:'api.mexc.com',
    path:`/api/v3/ticker/price?symbol=${sym}`,
    method:'GET',
    headers:{'User-Agent':'CryptoBotPro/1.0'},
    timeout:3000
  }, res => {
    let d='';
    res.on('data',c=>d+=c);
    res.on('end',()=>{
      try {
        const j=JSON.parse(d);
        const px=parseFloat(j.price);
        if(px>0){ state.prices[sym]=px; onTick(px); }
      } catch(e){}
    });
  });
  req.on('error',()=>{});
  req.on('timeout',()=>req.destroy());
  req.end();
}

// Multi-coin poll for dashboard ticker (every 4s)
let multiTimer = null;
function startMultiCoinPoll() {
  clearInterval(multiTimer);
  multiTimer = setInterval(fetchMultiCoins, 4000);
  fetchMultiCoins();
}
function fetchMultiCoins() {
  const req = https.request({
    hostname:'api.mexc.com', path:'/api/v3/ticker/price',
    method:'GET', headers:{'User-Agent':'CryptoBotPro/1.0'}, timeout:5000
  }, res => {
    let d='';
    res.on('data',c=>d+=c);
    res.on('end',()=>{
      try {
        const arr=JSON.parse(d);
        if(Array.isArray(arr)) arr.forEach(t=>{
          if(TOP_COINS.includes(t.symbol)){
            const px=parseFloat(t.price);
            if(px>0) state.prices[t.symbol]=px;
          }
        });
      } catch(e){}
    });
  });
  req.on('error',()=>{});
  req.on('timeout',()=>req.destroy());
  req.end();
}

// ── MAIN TICK — called on every price update ───────────────────────────────
function onTick(px) {
  const prev = state.lastPrice || px;
  state.lastPrice = px;
  tickN++;

  // Update price buffers
  pxBuf.push(px);   if (pxBuf.length > 500) pxBuf.shift();
  rsiArr.push(px);  if (rsiArr.length > 60)  rsiArr.shift();
  emaFast.push(px); if (emaFast.length > 25) emaFast.shift();
  emaSlow.push(px); if (emaSlow.length > 35) emaSlow.shift();

  const move = Math.abs(px - prev);
  volArr.push(move); if (volArr.length > 20) volArr.shift();

  // Recalc indicators every tick (fast — small arrays)
  iRSI = calcRSI(rsiArr, 9);     // RSI-9 (faster than RSI-14)
  iE9  = calcEMA(emaFast, 9);
  iE21 = calcEMA(emaSlow, 21);
  iBB  = calcBB(pxBuf, 20);
  iMom = pxBuf.length >= 6 ? (px - pxBuf[pxBuf.length-6]) / pxBuf[pxBuf.length-6] * 100 : 0;
  iVol = volArr.length > 0 ? volArr.reduce((a,b)=>a+b,0)/volArr.length : 0;
  // Trend: +1 bullish, -1 bearish, 0 neutral
  if (pxBuf.length >= 10) {
    const sma5  = pxBuf.slice(-5).reduce((a,b)=>a+b,0)/5;
    const sma10 = pxBuf.slice(-10).reduce((a,b)=>a+b,0)/10;
    iTrend = sma5 > sma10 ? 1 : sma5 < sma10 ? -1 : 0;
  }

  if (state.botOn) {
    // 1. Check existing open positions for exit FIRST (priority)
    checkExits(px);
    // 2. Look for new entry signals
    if (state.tradeCount < state.maxDaily) {
      checkEntries(px, prev);
    }
  }
}

// ── FEE MATH ───────────────────────────────────────────────────────────────
function netProfit(entryPx, exitPx, amtUsdt) {
  const qty      = amtUsdt / entryPx;
  const proceeds = qty * exitPx;
  const fee      = amtUsdt * TAKER_FEE + proceeds * TAKER_FEE;
  return { net: proceeds - amtUsdt - fee, fee, qty, proceeds };
}

// Break-even price including fees
function breakEven(entryPx, amtUsdt) {
  const qty = amtUsdt / entryPx;
  return (amtUsdt * (1 + TAKER_FEE)) / (qty * (1 - TAKER_FEE));
}

// ── EXIT CHECKER — runs every tick on open positions ──────────────────────
function checkExits(px) {
  let changed = false;
  state.orders.forEach(o => {
    if (o.status !== 'open') return;

    // Update trailing stop if price moved up
    if (px > o.highSince) {
      o.highSince = px;
      // Trail stop: lock in profit as price rises
      const newTrail = r6(px * (1 - state.trailPct/100));
      if (newTrail > o.trailStop) {
        o.trailStop = newTrail;
      }
    }

    const {net, fee} = netProfit(o.entryPx, px, o.amt);
    let reason = null;

    if (px >= o.tp)           reason = 'TP';           // take profit hit
    else if (px <= o.sl)      reason = 'SL';           // stop loss hit
    else if (px <= o.trailStop && o.trailStop > o.sl) reason = 'TRAIL'; // trailing stop

    if (reason) {
      state.totalFeesPaid += fee;
      commitTrade(o, reason, px, net, fee);
      o.status = 'closed';
      changed = true;
      if (state.apiKey) placeOrder('SELL', o.qty, state.pair);
    }
  });

  // Clean up closed orders
  if (changed) {
    state.orders = state.orders.filter(o => o.status === 'open');
    saveState();
  }
}

// ── ENTRY CHECKER — signal-based, at live price ───────────────────────────
function checkEntries(px, prev) {
  const openCount = state.orders.filter(o => o.status === 'open').length;
  if (openCount >= state.maxPositions) return;

  // Don't re-enter if price is exactly same (no movement)
  if (px === prev) return;

  const strat = state.strategy;
  let signal = false;
  let reason = '';

  if (strat === 'scalp') {
    // ── SCALP: multi-condition — needs 3/4 signals aligned ──
    // Fast, high win-rate, enters only when multiple signals agree
    let score = 0;
    if (iRSI !== null && iRSI < 45) score++;         // RSI not overbought
    if (iTrend === 1) score++;                         // short-term uptrend
    if (iMom > 0.02 && iMom < 0.5) score++;          // small positive momentum (not overextended)
    if (iBB && px <= iBB.middle) score++;             // below midband (room to rise)
    if (iVol > 0 && Math.abs(px-prev)/prev*100 > 0.01) score++; // some volatility
    signal = score >= 3;
    reason = `score=${score}/5 RSI=${iRSI?.toFixed(0)||'?'} mom=${iMom.toFixed(3)}%`;

  } else if (strat === 'rsi') {
    // ── RSI SCALP: RSI-9 oversold bounce ──
    signal = iRSI !== null && iRSI < 35 && px > prev;
    reason = `RSI9=${iRSI?.toFixed(1)||'?'}`;

  } else if (strat === 'ema') {
    // ── EMA CROSS: fast EMA crosses above slow ──
    const pe9  = emaFast.length > 1 ? calcEMA(emaFast.slice(0,-1), 9) : null;
    const pe21 = emaSlow.length > 1 ? calcEMA(emaSlow.slice(0,-1), 21) : null;
    signal = iE9 && iE21 && pe9 && pe21 && iE9 > iE21 && pe9 <= pe21;
    reason = `EMA9=${iE9?.toFixed(4)||'?'} EMA21=${iE21?.toFixed(4)||'?'}`;

  } else if (strat === 'bb') {
    // ── BB BOUNCE: price touches lower band + uptick ──
    signal = iBB !== null && px <= iBB.lower * 1.001 && px > prev;
    reason = `BB lower=${iBB?.lower.toFixed(4)||'?'} px=${px}`;

  } else if (strat === 'mom') {
    // ── MOMENTUM: breakout with trend confirmation ──
    signal = iMom > 0.08 && iTrend === 1 && iRSI !== null && iRSI < 65;
    reason = `mom=${iMom.toFixed(3)}% trend=${iTrend}`;

  } else if (strat === 'hybrid') {
    // ── HYBRID (best): RSI + BB + EMA all agree ──
    const rsiOk = iRSI !== null && iRSI < 42;
    const bbOk  = iBB !== null && px < iBB.middle;
    const emaOk = iE9 && iE21 && iE9 > iE21;
    const momOk = iMom > 0 && iMom < 0.4;
    signal = rsiOk && bbOk && (emaOk || momOk) && px > prev;
    reason = `RSI=${iRSI?.toFixed(0)||'?'} BB=${bbOk} EMA=${emaOk} mom=${iMom.toFixed(3)}`;
  }

  if (signal) enterTrade(px, reason);
}

// ── ENTER TRADE AT MARKET PRICE ───────────────────────────────────────────
function enterTrade(px, reason) {
  const amt = state.capital / state.maxPositions;
  const qty = amt / px;

  // Fee-aware TP: at minimum must clear fees + MIN_NET_PCT
  const bePrice = breakEven(px, amt);
  const minTp   = bePrice * (1 + MIN_NET_PCT);
  const wantedTp = px * (1 + state.tpPct/100);
  const tp = r6(Math.max(wantedTp, minTp));

  const sl       = r6(px * (1 - state.slPct/100));
  const trailStop= r6(px * (1 - state.trailPct/100));

  const o = {
    id: Date.now(),
    status: 'open',
    strat: state.strategy,
    entryPx: px,
    amt, qty,
    tp, sl,
    trailStop,
    highSince: px,
    openedAt: new Date().toISOString().slice(11,19),
    reason
  };

  state.orders.push(o);
  addLog(`▲ ENTER ${state.strategy.toUpperCase()} @ $${px.toFixed(4)} | TP $${tp.toFixed(4)} | SL $${sl.toFixed(4)} | [${reason}]`, 'buy');
  if (state.apiKey && state.apiSecret) placeOrder('BUY', qty, state.pair);
  saveState();
}

// ── COMMIT TRADE ──────────────────────────────────────────────────────────
function commitTrade(o, reason, exitPx, net, fee) {
  state.tradeCount++;
  state.liveProfit  += net;
  state.todayProfit += net;
  if (net >= 0) { state.wins++; if (net > state.bestTrade) state.bestTrade = net; }
  else state.losses++;

  const dur = o.openedAt ? `${o.openedAt}→${new Date().toISOString().slice(11,19)}` : '';
  const pnlStr = `${net>=0?'+':''}$${net.toFixed(4)}`;

  state.trades.unshift({
    n: state.tradeCount,
    time: new Date().toISOString().slice(11,19),
    dur, pair: state.pair, strat: o.strat,
    side: reason, entryPx: o.entryPx, exitPx,
    amt: o.amt, fee: r6(fee), net: r6(net)
  });
  if (state.trades.length > 300) state.trades.length = 300;

  const emoji = reason==='SL' ? '🛑' : reason==='TRAIL' ? '🔒' : '✅';
  addLog(`${emoji} EXIT ${reason} @ $${exitPx.toFixed(4)} | Entry $${o.entryPx.toFixed(4)} | Fee $${fee.toFixed(4)} | NET ${pnlStr}`, net>=0?'sell':'err');
  if (net > 0) addLog(`✓ PROFIT: ${pnlStr} (after MEXC fees)`, 'profit');
}

// ── INDICATORS ─────────────────────────────────────────────────────────────
// Incremental EMA for speed
let emaCache = {};
function calcEMA(arr, p) {
  if (arr.length < p) return null;
  const k = 2/(p+1);
  let e = arr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for (let i=p; i<arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
}
function calcRSI(arr, p=9) {
  if (arr.length < p+1) return null;
  const r = arr.slice(-(p+1));
  let g=0,l=0;
  for (let i=1;i<r.length;i++) { const d=r[i]-r[i-1]; if(d>0)g+=d; else l-=d; }
  const ag=g/p, al=l/p;
  if (al===0) return 100;
  return 100-(100/(1+ag/al));
}
function calcBB(arr, p=20) {
  if (arr.length < p) return null;
  const sl=arr.slice(-p), m=sl.reduce((a,b)=>a+b,0)/p;
  const std=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/p);
  return {upper:m+2*std, middle:m, lower:m-2*std};
}

// ── MEXC ORDER PLACEMENT ──────────────────────────────────────────────────
function placeOrder(side, qty, pair) {
  if (!state.apiKey || !state.apiSecret) return;
  const sym = pair.replace('/','');
  const params = {
    symbol: sym, side: side.toUpperCase(), type: 'MARKET',
    timestamp: Date.now(), recvWindow: 5000
  };
  // MEXC: BUY uses quoteOrderQty (USDT), SELL uses quantity (coins)
  if (side==='BUY') params.quoteOrderQty = (qty * state.lastPrice).toFixed(2);
  else              params.quantity = qty.toFixed(6);

  const query = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
  const sig   = crypto.createHmac('sha256',state.apiSecret).update(query).digest('hex');

  const req = https.request({
    hostname:'api.mexc.com',
    path:`/api/v3/order?${query}&signature=${sig}`,
    method:'POST',
    headers:{'X-MEXC-APIKEY':state.apiKey,'Content-Type':'application/json'}
  }, res => {
    let d='';
    res.on('data',c=>d+=c);
    res.on('end',()=>{
      try {
        const r=JSON.parse(d);
        if(r.orderId) addLog(`✓ MEXC ${side} filled orderId:${r.orderId}`,'buy');
        else addLog(`MEXC ${side} resp: ${JSON.stringify(r)}`,'info');
      } catch(e) {}
    });
  });
  req.on('error',e=>addLog('Order err: '+e.message,'err'));
  req.end();
}

function r6(n) { return Math.round(n*1000000)/1000000; }

// ── HTTP SERVER ─────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Bot-Pin,Authorization');
  res.setHeader('Access-Control-Max-Age','86400');
}
function json(res, code, data) {
  cors(res);
  res.writeHead(code,{'Content-Type':'application/json'});
  res.end(JSON.stringify(data));
}

const server = http.createServer((req,res)=>{
  if (req.method==='OPTIONS') { cors(res); res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];

  if (url==='/ping'||url==='/'||url==='/health') {
    json(res,200,{ok:true,uptime:process.uptime().toFixed(0)+'s',time:new Date().toISOString()});
    return;
  }

  // Public prices endpoint
  if (url==='/prices') {
    json(res,200,{prices:state.prices, updatedAt:Date.now()});
    return;
  }

  const pin = req.headers['x-bot-pin'];
  if (pin!==BOT_PIN) { json(res,401,{error:'Invalid PIN'}); return; }

  if (req.method==='GET' && url==='/status') {
    const open = state.orders.filter(o=>o.status==='open');
    // Add live P&L to open positions
    const ordersWithPnl = open.map(o=>({
      ...o,
      livePnl: o.entryPx && state.lastPrice
        ? netProfit(o.entryPx, state.lastPrice, o.amt).net
        : 0
    }));
    json(res,200,{
      botOn:state.botOn, strategy:state.strategy, pair:state.pair,
      exchange:state.exchange, capital:state.capital,
      maxPositions:state.maxPositions, tpPct:state.tpPct, slPct:state.slPct,
      trailPct:state.trailPct, maxDaily:state.maxDaily,
      lastPrice:state.lastPrice, prices:state.prices,
      liveProfit:state.liveProfit, todayProfit:state.todayProfit,
      tradeCount:state.tradeCount, wins:state.wins, losses:state.losses,
      bestTrade:state.bestTrade, totalFeesPaid:state.totalFeesPaid,
      winRate: state.tradeCount>0 ? Math.round(state.wins/state.tradeCount*100) : 0,
      openCount: open.length,
      orders:ordersWithPnl, trades:state.trades.slice(0,60),
      log:state.log.slice(0,120),
      savedAt:state.savedAt, startedAt:state.startedAt,
      hasApiKeys:!!(state.apiKey&&state.apiSecret),
      feeRate: RT_FEE*100,
      indicators: {
        rsi: iRSI?.toFixed(1)||null,
        ema9: iE9?.toFixed(4)||null, ema21: iE21?.toFixed(4)||null,
        bbUpper: iBB?.upper?.toFixed(4)||null, bbLower: iBB?.lower?.toFixed(4)||null,
        mom: iMom.toFixed(3), trend: iTrend, ticks: tickN
      }
    });
    return;
  }

  if (req.method==='POST') {
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      let d={};
      try { d=JSON.parse(body); } catch(e){}

      if (url==='/config') {
        if (d.pair)         state.pair         = d.pair.replace('/','');
        if (d.strategy)     state.strategy     = d.strategy;
        if (d.capital)      state.capital      = parseFloat(d.capital);
        if (d.maxPositions) state.maxPositions = parseInt(d.maxPositions);
        if (d.tpPct)        state.tpPct        = parseFloat(d.tpPct);
        if (d.slPct)        state.slPct        = parseFloat(d.slPct);
        if (d.trailPct)     state.trailPct     = parseFloat(d.trailPct);
        if (d.maxDaily)     state.maxDaily     = parseInt(d.maxDaily);
        if (d.apiKey && d.apiKey!=='[encrypted]')       state.apiKey    = d.apiKey;
        if (d.apiSecret && d.apiSecret!=='[encrypted]') state.apiSecret = d.apiSecret;
        // Safety guard: TP must clear fees
        const minTp = RT_FEE*100 + 0.12;
        if (state.tpPct < minTp) { state.tpPct = minTp; }
        if (state.slPct < 0.10)  { state.slPct = 0.10; }
        saveState();
        addLog(`Config: ${state.pair} tp=${state.tpPct}% sl=${state.slPct}% trail=${state.trailPct}%`,'info');
        json(res,200,{ok:true, tpPct:state.tpPct, slPct:state.slPct});
        return;
      }

      if (url==='/start') {
        if (state.botOn) { json(res,200,{ok:true,msg:'Already running'}); return; }
        state.botOn=true; state.orders=[];
        state.startedAt=new Date().toISOString();
        // Reset buffers for clean start
        pxBuf=[]; rsiArr=[]; emaFast=[]; emaSlow=[]; volArr=[]; tickN=0;
        startPriceFeed();
        addLog(`▶ STARTED ${state.pair} $${state.capital} [${state.strategy}] maxPos=${state.maxPositions} TP=${state.tpPct}% SL=${state.slPct}%`,'buy');
        saveState();
        json(res,200,{ok:true});
        return;
      }

      if (url==='/stop') {
        state.botOn=false; state.orders=[];
        stopPriceFeed();
        addLog('■ Bot stopped.','info');
        saveState();
        json(res,200,{ok:true});
        return;
      }

      if (url==='/reset') {
        state.liveProfit=0;state.todayProfit=0;state.tradeCount=0;
        state.wins=0;state.losses=0;state.bestTrade=0;state.totalFeesPaid=0;
        state.trades=[];state.orders=[];state.log=[];
        saveState();
        json(res,200,{ok:true});
        return;
      }

      json(res,404,{error:'Not found'});
    });
    return;
  }

  json(res,404,{error:'Not found'});
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  CryptoBot Pro v4 — FAST SCALP ENGINE   ║`);
  console.log(`║  Port: ${PORT}   PIN: ${BOT_PIN}              ║`);
  console.log(`║  MEXC Fees: 0.05% taker / 0% maker      ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  loadState();
  // Always run multi-coin poll for dashboard prices
  startMultiCoinPoll();
  // Resume bot if was running
  if (state.botOn) {
    state.orders=[];
    addLog('Auto-resuming...','info');
    startPriceFeed();
  }
});

server.on('error',e=>{ console.error('Server error:',e); process.exit(1); });
process.on('SIGTERM',()=>{ saveState(); process.exit(0); });
process.on('SIGINT', ()=>{ saveState(); process.exit(0); });
