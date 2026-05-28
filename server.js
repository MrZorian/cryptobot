'use strict';
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');

const PORT    = parseInt(process.env.PORT || '3000');
const BOT_PIN = process.env.BOT_PIN || '123456';

// ── ENV VARS ──────────────────────────────────────────────────────────────────
const ENV_KEY     = (process.env.MEXC_KEY     || '').trim().replace(/\s/g,'');
const ENV_SECRET  = (process.env.MEXC_SECRET  || '').trim().replace(/\s/g,'');
const ENV_PAIR    = process.env.BOT_PAIR    || 'BTCUSDT';
const ENV_MODE    = process.env.BOT_MODE    || 'paper';
const ENV_RUNNING = process.env.BOT_RUNNING === 'true';

console.log('=== CryptoBot Pro v7 ===');
console.log('Port:', PORT, '| Running:', ENV_RUNNING, '| Mode:', ENV_MODE);

// ── STATE ─────────────────────────────────────────────────────────────────────
const TAKER      = 0.0005;
const RT_FEE     = TAKER * 2;
const FUT_TAKER  = 0.0002;
const FUT_RT_FEE = FUT_TAKER * 2;

let S = {
  botOn: ENV_RUNNING, mode: ENV_MODE, strategy: 'auto',
  pair: ENV_PAIR, capital: 20, maxPos: 1,
  tpPct: 0.50, slPct: 0.35,
  maxDaily: 200, cooldown: 10000, warmup: 5,
  apiKey: ENV_KEY, apiSecret: ENV_SECRET,
  liveProfit: 0, todayP: 0, liveT: 0, liveW: 0, liveL: 0, bestT: 0, feesT: 0,
  papProfit: 0, papT: 0, papW: 0, papL: 0, papBest: 0, papFees: 0,
  liveOrders: [], papOrders: [], liveTrades: [], papTrades: [],
  log: [], prices: {}, lastPx: 0,
  startedAt: null, savedAt: null, lastEntry: 0, lastLiveEntry: 0,
  mexcBalance: null,
  // Futures
  futuresOn: false, futMode: 'paper', futPair: 'BTC_USDT',
  futCapital: 20, futMaxPos: 1, futLeverage: 3,
  futTpPct: 0.45, futSlPct: 0.20,
  futProfit: 0, futT: 0, futW: 0, futL: 0, futBest: 0, futFees: 0,
  futPapProfit: 0, futPapT: 0, futPapW: 0, futPapL: 0,
  futOrders: [], futPapOrders: [], futTrades: [], futPapTrades: [],
  futLastPx: 0, futLastEntry: 0, futTicks: 0,
  // AI Brain
  aiKey: '', aiMode: 'hybrid', aiInterval: 30, aiMinConf: 65,
  aiDecision: null, aiFutDecision: null,
  aiLastCall: 0, aiFutLastCall: 0,
  aiCallCount: 0, aiTokensUsed: 0, aiCost: 0,
};

const STATE_FILE = './bot_state.json';
const KEYS_FILE  = './bot_keys.enc';

function save() {
  try {
    S.savedAt = new Date().toISOString();
    const d = JSON.stringify(S);
    fs.writeFileSync(STATE_FILE, d);
  } catch(e) {}
}

function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    Object.assign(S, d);
    if (ENV_KEY)    S.apiKey    = ENV_KEY;
    if (ENV_SECRET) S.apiSecret = ENV_SECRET;
    if (ENV_MODE)   S.mode      = ENV_MODE;
    if (ENV_PAIR)   S.pair      = ENV_PAIR;
    log('State loaded from file', 'info');
  } catch(e) { log('State load err: ' + e.message, 'err'); }
}

function log(msg, type) {
  const entry = { ts: new Date().toISOString().slice(11,19), msg, type: type||'info' };
  S.log.unshift(entry);
  if (S.log.length > 200) S.log.length = 200;
  console.log('[' + entry.ts + '][' + (type||'info') + '] ' + msg);
}

// ── INDICATORS ────────────────────────────────────────────────────────────────
function calcRSI(arr, n) {
  const len = Math.min(n+1, arr.length);
  if (len < 2) return 50;
  const sl = arr.slice(-len);
  let g = 0, l = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i-1];
    if (d > 0) g += d; else l -= d;
  }
  const ag = g / (len-1), al = l / (len-1);
  if (al === 0) return 100;
  return 100 - (100 / (1 + ag/al));
}

function calcEMA(arr, n) {
  if (!arr.length) return 0;
  if (arr.length < n) return arr[arr.length-1];
  const k = 2 / (n+1);
  let e = arr.slice(0,n).reduce((a,b)=>a+b,0) / n;
  for (let i = n; i < arr.length; i++) e = arr[i]*k + e*(1-k);
  return e;
}

function calcBB(arr, n) {
  n = Math.min(n, arr.length);
  if (n < 5) return null;
  const sl = arr.slice(-n);
  const m  = sl.reduce((a,b)=>a+b,0) / n;
  const sd = Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/n);
  return { upper: m+2*sd, middle: m, lower: m-2*sd };
}

// ── PRICE FEED ────────────────────────────────────────────────────────────────
let PX = [], ticks = 0, feedTimer = null;

function startFeed() {
  clearInterval(feedTimer);
  feedTimer = setInterval(fetchPrice, 1500);
  fetchPrice();
  log('Spot feed started: ' + S.pair, 'ws');
}

function stopFeed() {
  clearInterval(feedTimer);
  feedTimer = null;
}

// Coins to show on ticker bar + active trading pair
const TICKER_COINS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','MATICUSDT'];
let lastTickerFetch = 0;

function fetchPrice() {
  const req = https.request({
    hostname: 'api.mexc.com',
    path: '/api/v3/ticker/price?symbol=' + S.pair,
    method: 'GET', timeout: 5000
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const r = JSON.parse(d);
        const px = parseFloat(r.price || 0);
        if (px > 0) {
          S.lastPx = px;
          S.prices[S.pair] = px;
          onTick(px);
        }
      } catch(e) {}
    });
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
  req.end();

  // Fetch all ticker prices every 5 seconds for the dashboard ticker bar
  const now = Date.now();
  if (now - lastTickerFetch < 5000) return;
  lastTickerFetch = now;
  const coins = [...new Set([...TICKER_COINS, S.pair])].join(',');
  const tickReq = https.request({
    hostname: 'api.mexc.com',
    path: '/api/v3/ticker/price?symbols=["' + [...new Set([...TICKER_COINS, S.pair])].join('","') + '"]',
    method: 'GET', timeout: 5000
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const arr = JSON.parse(d);
        if (Array.isArray(arr)) {
          arr.forEach(t => {
            const p = parseFloat(t.price||0);
            if (p > 0) S.prices[t.symbol] = p;
          });
        }
      } catch(e) {
        // Fallback: fetch individually if batch fails
        TICKER_COINS.forEach(sym => {
          if (sym === S.pair) return; // already fetched above
          const r2 = https.request({
            hostname:'api.mexc.com', path:'/api/v3/ticker/price?symbol='+sym,
            method:'GET', timeout:4000
          }, res2 => {
            let d2=''; res2.on('data',c=>d2+=c);
            res2.on('end',()=>{
              try{const j=JSON.parse(d2);if(j.price)S.prices[j.symbol]=parseFloat(j.price);}catch(e){}
            });
          });
          r2.on('error',()=>{}); r2.on('timeout',()=>r2.destroy()); r2.end();
        });
      }
    });
  });
  tickReq.on('error', () => {});
  tickReq.on('timeout', () => tickReq.destroy());
  tickReq.end();
}

// ── SPOT SIGNALS ──────────────────────────────────────────────────────────────
function getSignal(px) {
  if (PX.length < S.warmup) return { signal: false, reason: 'warmup ' + PX.length + '/' + S.warmup };
  const raw  = PX;
  const n    = raw.length;
  const r14  = calcRSI(raw, 14);
  const e9   = calcEMA(raw, Math.min(9,n));
  const e21  = calcEMA(raw, Math.min(21,n));
  const bb   = calcBB(raw, Math.min(20,n));
  const hi10 = Math.max(...raw.slice(-Math.min(10,n)));
  const ch1  = n > 1 ? (px - raw[n-2]) / raw[n-2] * 100 : 0;
  const dip  = (px - hi10) / hi10 * 100;

  let score = 0, reasons = [];
  if (r14 < 48 && ch1 >= 0)                  { score++; reasons.push('rsi=' + r14.toFixed(0)); }
  if (dip <= -0.04 && dip >= -0.6 && ch1 >= 0){ score++; reasons.push('dip=' + dip.toFixed(3)); }
  if (bb && px <= bb.lower * 1.005 && ch1 >= 0){ score++; reasons.push('bb'); }
  if (e9 > e21 && ch1 >= 0)                  { score++; reasons.push('ema'); }
  const strong = dip <= -0.12 && ch1 > 0;

  return {
    signal: score >= 2 || strong,
    reason: 'score=' + score + '/4 [' + reasons.join(',') + '] strong=' + strong
  };
}

// ── SPOT TRADE MATH ───────────────────────────────────────────────────────────
function feeMath(entryPx, exitPx, amt) {
  const qty    = (amt / entryPx) * (1 - TAKER);
  const gross  = qty * exitPx;
  const sellFee = gross * TAKER;
  const net    = gross - sellFee - amt;
  const fee    = amt * TAKER + sellFee;
  return { net, fee, gross };
}

function minTpPx(entryPx, amt) {
  const qty = (amt / entryPx) * (1 - TAKER);
  return (amt / (qty * (1 - TAKER))) * (1 + 0.0008);
}

// ── SPOT ENTRY ────────────────────────────────────────────────────────────────
function enter(px, reason, isPaper) {
  const amt  = S.capital / S.maxPos;
  // AI suggested TP/SL override — AI acts as agent deciding per-trade params
  const aiD    = S.aiDecision;
  const useTP  = (aiD && aiD.tp_suggest > 0.22) ? aiD.tp_suggest : S.tpPct;
  const useSL  = (aiD && aiD.sl_suggest > 0.10) ? aiD.sl_suggest : S.slPct;
  const safeTp = Math.max(px * (1 + useTP/100), minTpPx(px, amt));
  const tp   = parseFloat(safeTp.toFixed(4));
  const sl   = parseFloat((px * (1 - useSL/100)).toFixed(4));
  const o = {
    id: Date.now() + (isPaper ? 1 : 0),
    status: 'open', isPaper, strat: S.strategy,
    entryPx: px, amt, qty: amt/px, tp, sl,
    peakPx: px, peakNet: 0,
    openAt: new Date().toISOString().slice(11,19), reason
  };
  const aiTag = aiD ? ' [AI conf='+aiD.confidence+'% TP='+useTP+'% SL='+useSL+'%]' : '';
  if (isPaper) {
    S.papOrders.push(o);
    log('PAPER BUY @ $'+px.toFixed(2)+' TP=$'+tp.toFixed(2)+' SL=$'+sl.toFixed(2)+aiTag, 'buy');
  } else {
    S.liveOrders.push(o);
    log('LIVE BUY @ $'+px.toFixed(2)+' TP=$'+tp.toFixed(2)+' SL=$'+sl.toFixed(2)+aiTag, 'buy');
    placeOrder('BUY', o.qty, S.pair);
  }
}

// ── SPOT EXIT ─────────────────────────────────────────────────────────────────
function exitCheck(px, isPaper) {
  const orders = isPaper ? S.papOrders : S.liveOrders;
  let changed  = false;
  orders.forEach(o => {
    if (o.status !== 'open') return;
    if (px > o.peakPx) o.peakPx = px;
    const curNet = feeMath(o.entryPx, px, o.amt).net;
    if (curNet > o.peakNet) o.peakNet = curNet;

    let why = null, exitAt = px;
    if (px >= o.tp)      { why = 'TP'; exitAt = o.tp; }
    else if (px <= o.sl) { why = 'SL'; exitAt = o.sl; }
    else if (o.peakNet > o.amt * 0.001 && curNet > 0 && (o.peakNet - curNet) / o.peakNet >= 0.60) {
      why = 'PROTECT'; exitAt = px;
    }
    if (!why) return;

    const { net, fee, gross } = feeMath(o.entryPx, exitAt, o.amt);
    o.status = 'closed'; changed = true;
    const tr = {
      n: isPaper ? ++S.papT : ++S.liveT,
      time: new Date().toISOString().slice(11,19),
      pair: S.pair, strat: o.strat, isPaper,
      side: why, entryPx: o.entryPx, exitPx: exitAt,
      amt: o.amt, fee: +fee.toFixed(6), gross: +gross.toFixed(6), net: +net.toFixed(6)
    };
    if (isPaper) {
      S.papProfit += net; S.papFees += fee;
      if (net >= 0) { S.papW++; if (net > S.papBest) S.papBest = net; } else S.papL++;
      S.papTrades.unshift(tr); if (S.papTrades.length > 200) S.papTrades.length = 200;
      log('PAPER ' + why + ' @ $' + exitAt.toFixed(2) + ' NET=' + (net>=0?'+':'') + '$' + net.toFixed(4), net>=0?'profit':'err');
    } else {
      S.liveProfit += net; S.todayP += net; S.feesT += fee;
      if (net >= 0) { S.liveW++; if (net > S.bestT) S.bestT = net; } else S.liveL++;
      S.liveTrades.unshift(tr); if (S.liveTrades.length > 200) S.liveTrades.length = 200;
      log('LIVE ' + why + ' @ $' + exitAt.toFixed(2) + ' NET=' + (net>=0?'+':'') + '$' + net.toFixed(4), net>=0?'sell':'err');
      placeOrder('SELL', o.qty, S.pair);
    }
    save();
  });
  if (changed) {
    if (isPaper) S.papOrders = S.papOrders.filter(o=>o.status==='open');
    else         S.liveOrders = S.liveOrders.filter(o=>o.status==='open');
  }
}

// ── MAIN SPOT TICK ────────────────────────────────────────────────────────────
async function onTick(px) {
  PX.push(px); if (PX.length > 300) PX.shift();
  ticks++;
  if (!S.botOn) return;
  exitCheck(px, true);
  exitCheck(px, false);
  if (ticks < S.warmup) return;
  const now = Date.now();
  if (now - S.lastEntry < S.cooldown) return;
  if (S.liveT >= S.maxDaily && S.papT >= S.maxDaily) return;
  const sig = getSignal(px);
  if (ticks % 20 === 0) log('[T' + ticks + '] $' + px.toFixed(2) + ' sig=' + sig.signal + ' ' + sig.reason, 'info');
  if (!sig.signal) return;

  // AI check
  if (S.aiKey && S.aiMode !== 'off') await callAI(px, false);
  const aiOk = checkAI(false);
  if (!aiOk.ok) {
    if (aiOk.reason) log('AI blocked: ' + aiOk.reason, 'info');
    return;
  }

  const papOpen = S.papOrders.filter(o=>o.status==='open').length;
  if (papOpen < S.maxPos) enter(px, sig.reason, true);
  if (S.mode === 'live' && S.apiKey && S.apiSecret) {
    const liveCD = (now - S.lastLiveEntry) >= S.cooldown;
    const liveOpen = S.liveOrders.filter(o=>o.status==='open').length;
    if (liveCD && liveOpen < S.maxPos && S.liveT < S.maxDaily) {
      if (S.capital / S.maxPos >= 5) { enter(px, sig.reason, false); S.lastLiveEntry = now; }
    }
  }
  S.lastEntry = now;
}

// ── FUTURES PRICE FEED ────────────────────────────────────────────────────────
let futPX = [], futTicks = 0, futTimer = null;

function startFuturesFeed() {
  clearInterval(futTimer);
  futTimer = setInterval(fetchFutPrice, 1500);
  fetchFutPrice();
  log('Futures feed started: ' + S.futPair, 'ws');
}

function stopFuturesFeed() {
  clearInterval(futTimer);
  futTimer = null;
}

function fetchFutPrice() {
  const req = https.request({
    hostname: 'contract.mexc.com',
    path: '/api/v1/contract/ticker?symbol=' + S.futPair,
    method: 'GET', timeout: 5000
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const r = JSON.parse(d);
        const px = parseFloat(r.data?.lastPrice || r.data?.last || 0);
        if (px > 0) { S.futLastPx = px; onFutTick(px); }
        else if (S.lastPx > 0) onFutTick(S.lastPx);
      } catch(e) { if (S.lastPx > 0) onFutTick(S.lastPx); }
    });
  });
  req.on('error', () => { if (S.lastPx > 0) onFutTick(S.lastPx); });
  req.on('timeout', () => { req.destroy(); if (S.lastPx > 0) onFutTick(S.lastPx); });
  req.end();
}

// ── FUTURES FEE MATH ──────────────────────────────────────────────────────────
function futFee(entryPx, exitPx, margin, lev, isLong) {
  const notional  = margin * lev;
  const contracts = notional / entryPx;
  // LONG profit: price up = positive. SHORT profit: price down = positive
  const rawPnl = (exitPx - entryPx) * contracts;
  const pnl    = isLong === false ? -rawPnl : rawPnl;
  const fee    = notional * FUT_TAKER * 2;
  return { net: pnl - fee, fee, pnl, notional, contracts };
}

function futBE(entryPx, margin, lev, isLong) {
  const notional  = margin * lev;
  const contracts = notional / entryPx;
  const fee       = notional * FUT_RT_FEE;
  return isLong === false
    ? entryPx - fee / contracts  // SHORT: BE is below entry
    : entryPx + fee / contracts; // LONG: BE is above entry
}

// ── FUTURES SIGNAL ────────────────────────────────────────────────────────────
function getFutSig(px) {
  const raw = futPX.length >= 5 ? futPX : (S.lastPx > 0 ? [S.lastPx] : []);
  if (raw.length < 3) return { signal: false, reason: 'warmup' };
  const n   = raw.length;
  const r14 = calcRSI(raw, Math.min(14, n-1));
  const e9  = calcEMA(raw, Math.min(9, n));
  const e21 = calcEMA(raw, Math.min(21, n));
  const bb  = calcBB(raw, Math.min(20, n));
  const hi  = Math.max(...raw.slice(-Math.min(10,n)));
  const ch1 = n > 1 ? (px - raw[n-2]) / raw[n-2] * 100 : 0;
  const dip = (px - hi) / hi * 100;
  let score = 0, reasons = [];
  if (r14 < 48 && ch1 >= 0)                   { score++; reasons.push('rsi=' + r14.toFixed(0)); }
  if (dip <= -0.05 && dip >= -0.6 && ch1 >= 0){ score++; reasons.push('dip=' + dip.toFixed(3)); }
  if (bb && px <= bb.lower * 1.005 && ch1 >= 0){ score++; reasons.push('bb'); }
  if (e9 > e21 && ch1 >= 0)                   { score++; reasons.push('ema'); }
  return { signal: score >= 2, reason: 'score=' + score + '/4 [' + reasons.join(',') + ']' };
}

// ── FUTURES ENTRY — supports LONG and SHORT ───────────────────────────────────
function futEnter(px, reason, isPaper, direction) {
  // RECOVERY MODE: reduce position size after 3+ consecutive losses
  var lossStreak = 0;
  var trades = isPaper ? (S.futPapTrades||[]) : S.futTrades;
  for (var li=0; li<trades.length; li++) { if(trades[li].net<0) lossStreak++; else break; }
  var sizeMultiplier = lossStreak >= 3 ? 0.5 : lossStreak >= 2 ? 0.75 : 1.0;
  if (lossStreak >= 2) log('RECOVERY x'+sizeMultiplier+' size ('+lossStreak+' losses)', 'info');
  direction = direction || 'BUY'; // 'BUY'=long, 'SHORT'=short
  const isLong   = direction !== 'SHORT';
  const margin   = (S.futCapital / S.futMaxPos) * sizeMultiplier;
  const lev      = S.futLeverage;
  const notional = margin * lev;
  const bePx     = parseFloat(futBE(px, margin, lev, isLong).toFixed(4));

  // AI suggested TP/SL — used directly
  const futAiD   = S.aiFutDecision;
  const useTP    = (futAiD && futAiD.tp_suggest > 0.12) ? futAiD.tp_suggest : S.futTpPct;
  const useSL    = (futAiD && futAiD.sl_suggest > 0.08) ? futAiD.sl_suggest : S.futSlPct;

  let tp, sl;
  if (isLong) {
    // LONG: profit when price goes UP
    const wantTp = px * (1 + useTP / 100);
    tp = parseFloat(Math.max(wantTp, bePx * 1.001).toFixed(4));
    sl = parseFloat(Math.max(px * (1 - useSL/100), px - (tp-px)*0.55).toFixed(4));
  } else {
    // SHORT: profit when price goes DOWN
    const wantTp = px * (1 - useTP / 100);
    tp = parseFloat(Math.min(wantTp, bePx * 0.999).toFixed(4));
    sl = parseFloat(Math.min(px * (1 + useSL/100), px + (px-tp)*0.55).toFixed(4));
  }

  const expNet = futFee(px, tp, margin, lev, isLong).net;
  const aiTag  = futAiD ? ' [AI conf='+(futAiD.confidence||'?')+'% TP='+useTP+'% SL='+useSL+'%]' : '';

  const o = {
    id: Date.now() + (isPaper?1:0),
    status:'open', isPaper, isFutures:true,
    direction: isLong ? 'LONG' : 'SHORT',
    entryPx:px, margin, leverage:lev, notional, tp, sl, bePx,
    beStopMoved:false, peakPx:px, peakNet:0,
    openAt:new Date().toISOString().slice(11,19), reason
  };

  const tag = (isPaper?'FUT-PAPER':'FUT-LIVE') + ' ' + o.direction;
  log(tag+' @ $'+px.toFixed(2)+' margin=$'+margin.toFixed(2)+' '+lev+'x'
    +' TP=$'+tp.toFixed(2)+' SL=$'+sl.toFixed(2)+' exp=+$'+expNet.toFixed(4)+aiTag, 'buy');

  if (isPaper) {
    S.futPapOrders.push(o);
  } else {
    S.futOrders.push(o);
    // side: 1=open long, 3=open short
    futPlaceOrder(isLong ? 'open_long' : 'open_short', margin, lev, px);
  }
}

// ── FUTURES EXIT ──────────────────────────────────────────────────────────────
function futExitCheck(px, isPaper) {
  const orders = isPaper ? S.futPapOrders : S.futOrders;
  let changed = false;
  orders.forEach(o => {
    if (o.status !== 'open') return;
    if (px > o.peakPx) o.peakPx = px;
    const curNet = futFee(o.entryPx, px, o.margin, o.leverage).net;
    if (curNet > o.peakNet) o.peakNet = curNet;

    // BE-stop: once price 40% toward TP, move SL to break-even
    if (!o.beStopMoved) {
      const pct = (o.tp - o.entryPx) > 0 ? (o.peakPx - o.entryPx) / (o.tp - o.entryPx) : 0;
      if (pct >= 0.40 && o.bePx > o.sl) {
        o.sl = o.bePx; o.beStopMoved = true;
        log('FUT BE-STOP: SL -> $' + o.bePx.toFixed(2), 'info');
      }
    }
    // Profit lock: at 80% toward TP, lock 70% of profit
    if (o.beStopMoved) {
      const pct = (o.tp - o.entryPx) > 0 ? (o.peakPx - o.entryPx) / (o.tp - o.entryPx) : 0;
      if (pct >= 0.80) {
        const lock = o.entryPx + (o.tp - o.entryPx) * 0.70;
        if (lock > o.sl) o.sl = parseFloat(lock.toFixed(4));
      }
    }

    let why = null, exitAt = px;
    if (px >= o.tp)      { why = 'TP';      exitAt = o.tp; }
    else if (px <= o.sl) { why = o.beStopMoved ? 'BE-STOP' : 'SL'; exitAt = o.sl; }
    else if (o.peakNet > o.margin * 0.001 && curNet > 0 && (o.peakNet - curNet) / o.peakNet >= 0.60) {
      why = 'PROTECT'; exitAt = px;
    }
    if (!why) return;

    const { net, fee, pnl } = futFee(o.entryPx, exitAt, o.margin, o.leverage);
    o.status = 'closed'; changed = true;
    const movePct = ((exitAt - o.entryPx) / o.entryPx * 100).toFixed(3);
    const tr = {
      n: isPaper ? ++S.futPapT : ++S.futT, time: new Date().toISOString().slice(11,19),
      pair: S.futPair, direction:'LONG', isPaper, side:why,
      entryPx:o.entryPx, exitPx:exitAt, margin:o.margin, leverage:o.leverage,
      notional:o.notional, move:movePct+'%', leveragedMove:(parseFloat(movePct)*o.leverage).toFixed(3)+'%',
      fee:+fee.toFixed(6), pnl:+pnl.toFixed(6), net:+net.toFixed(6)
    };
    if (isPaper) {
      S.futPapProfit += net; S.futFees += fee;
      if (net >= 0) S.futPapW++; else S.futPapL++;
      S.futPapTrades.unshift(tr); if (S.futPapTrades.length > 200) S.futPapTrades.length = 200;
      log('FUT-PAPER ' + why + ' ' + movePct + '% NET=' + (net>=0?'+':'') + '$' + net.toFixed(4), net>=0?'profit':'err');
    } else {
      S.futProfit += net; S.futFees += fee;
      if (net >= 0) { S.futW++; if (net > S.futBest) S.futBest = net; } else S.futL++;
      S.futTrades.unshift(tr); if (S.futTrades.length > 200) S.futTrades.length = 200;
      log('FUT-LIVE ' + why + ' ' + movePct + '% NET=' + (net>=0?'+':'') + '$' + net.toFixed(4), net>=0?'sell':'err');
      if (net > 0) log('FUT PROFIT +$' + net.toFixed(4), 'profit');
      futPlaceOrder(o.direction === 'SHORT' ? 'close_short' : 'close_long', o.margin, o.leverage, exitAt);
    }
    save();
  });
  if (changed) {
    if (isPaper) S.futPapOrders = S.futPapOrders.filter(o=>o.status==='open');
    else         S.futOrders    = S.futOrders.filter(o=>o.status==='open');
  }
}

// ── FUTURES TICK — FULL AI AUTONOMOUS CONTROL ────────────────────────────────
// AI is the ONLY decision maker for futures.
// Every N seconds: AI analyzes market → returns BUY/SHORT/HOLD + TP/SL.
// Bot executes immediately. No indicator gating.
async function onFutTick(px) {
  S.futLastPx = px;
  futPX.push(px); if (futPX.length > 300) futPX.shift();
  futTicks++; S.futTicks = futTicks;
  if (!S.futuresOn) return;

  // Always check exits first on every tick
  futExitCheck(px, true);
  futExitCheck(px, false);

  if (futTicks < 5) return;

  const now = Date.now();
  if (now - S.futLastEntry < S.futCooldown) return;

  const papOpen  = S.futPapOrders.filter(o=>o.status==='open').length;
  const liveOpen = S.futOrders.filter(o=>o.status==='open').length;
  const maxPos   = S.futMaxPos || 1;

  // Check if we have room for a new position
  if (papOpen >= maxPos && liveOpen >= maxPos) return;

  // ── AI IS THE SOLE DECISION MAKER ──────────────────────────────────────────
  if (!S.aiKey) {
    // No AI key: fallback to indicators only
    const sig = getFutSig(px);
    if (!sig.signal) return;
    if (papOpen < maxPos) futEnter(px, sig.reason, true);
    if (S.futMode === 'live' && S.apiKey && S.apiSecret && liveOpen < maxPos)
      futEnter(px, sig.reason, false);
    S.futLastEntry = now;
    return;
  }

  // Call AI — run every interval
  const decision = await callAI(px, true);
  const dec      = decision || S.aiFutDecision;
  const decAge   = now - S.aiFutLastCall;

  // ── FALLBACK: indicator-based entry when AI is silent or no trades yet ────
  const minSinceEntry = (now - S.futLastEntry) / 60000;
  const noTradesYet   = S.futT === 0 && S.futPapT === 0;
  const aiSilent      = !dec || decAge > S.aiInterval * 3000;

  if (aiSilent || noTradesYet && minSinceEntry > 5) {
    const sig = getFutSig(px);
    if (sig.signal) {
      log('FUT INDICATOR entry (AI silent ' + Math.round(decAge/1000) + 's): ' + sig.reason, 'info');
      if (papOpen < maxPos) futEnter(px, 'IND:'+sig.reason, true, 'BUY');
      if (S.futMode==='live' && S.apiKey && S.apiSecret && liveOpen < maxPos)
        futEnter(px, 'IND:'+sig.reason, false, 'BUY');
      S.futLastEntry = now;
    } else if (futTicks % 40 === 0) {
      log('FUT: waiting for signal... RSI='+calcRSI((isFutures?futPX:PX.map(function(p){return p.px||p;})).filter(function(v){return v>0;}),14).toFixed(1), 'info');
    }
    return;
  }

  const action  = (dec.action || 'HOLD').toUpperCase();
  const conf    = dec.confidence || 0;
  const minConf = S.aiMinConf > 0 ? Math.min(S.aiMinConf, 65) : 58; // professional: 58% min

  // Log every 20 ticks
  if (futTicks % 20 === 0) {
    log('[FUT T'+futTicks+'] $'+px.toFixed(2)+' AI='+action+' conf='+conf+'% | '+dec.reason, 'info');
  }

  // AI HOLD with high confidence — skip
  if (action === 'HOLD' && conf >= 70) return;

  // AI confidence below minimum — try indicator fallback
  if (action === 'HOLD' || conf < minConf) {
    const sig = getFutSig(px);
    if (sig.signal && (minSinceEntry > 3 || noTradesYet)) {
      log('FUT indicator override (AI HOLD conf='+conf+'%): '+sig.reason, 'info');
      if (papOpen < maxPos) futEnter(px, 'IND:'+sig.reason, true, 'BUY');
      if (S.futMode==='live' && S.apiKey && S.apiSecret && liveOpen < maxPos)
        futEnter(px, 'IND:'+sig.reason, false, 'BUY');
      S.futLastEntry = now;
    }
    return;
  }


  // ── EXECUTE AI DECISION ──────────────────────────────────────────────────
  // BUY = open LONG position
  // SHORT = open SHORT position (sell to profit from price falling)
  const direction = action; // 'BUY' or 'SHORT'
  const reason = action + ' conf=' + conf + '% ' + dec.reason;

  if (papOpen < maxPos)  futEnter(px, reason, true,  direction);
  if (S.futMode === 'live' && S.apiKey && S.apiSecret && liveOpen < maxPos) {
    if (S.futCapital / maxPos >= 5) futEnter(px, reason, false, direction);
  }
  S.futLastEntry = now;
}

// ── MEXC SPOT ORDER ───────────────────────────────────────────────────────────
function mexcRequest(method, path, params, key, secret, cb) {
  const p = Object.assign({}, params, { timestamp: Date.now().toString(), recvWindow: '5000' });
  const qs  = Object.entries(p).map(([k,v]) => k + '=' + v).join('&');
  const sig = crypto.createHmac('sha256', secret).update(qs).digest('hex');
  const fullPath = path + '?' + qs + '&signature=' + sig;
  const opts = { hostname:'api.mexc.com', path:fullPath, method,
    headers:{'X-MEXC-APIKEY':key,'Accept':'application/json','User-Agent':'CryptoBotPro/7'}, timeout:8000 };
  const req = https.request(opts, res => {
    let d = ''; res.on('data', c => d+=c);
    res.on('end', () => { try { cb(null, JSON.parse(d)); } catch(e) { cb(e); } });
  });
  req.on('error', cb); req.on('timeout', () => { req.destroy(); cb(new Error('timeout')); });
  req.end();
}

function placeOrder(side, qty, pair) {
  if (!S.apiKey || !S.apiSecret) { log('No API keys for order', 'err'); return; }
  const sym  = pair.replace('/','');
  const amt  = (S.capital / S.maxPos).toFixed(2);
  const params = { symbol:sym, side:side.toUpperCase(), type:'MARKET' };
  if (side === 'BUY') params.quoteOrderQty = amt;
  else params.quantity = qty.toFixed(6);
  mexcRequest('POST', '/api/v3/order', params, S.apiKey, S.apiSecret, (err, r) => {
    if (err) { log('Order err: ' + err.message, 'err'); return; }
    if (r.orderId) log('ORDER FILLED! id=' + r.orderId + ' ' + side, 'profit');
    else { log('ORDER FAILED code=' + r.code + ' ' + r.msg, 'err'); }
  });
}

// ── MEXC FUTURES ORDER ────────────────────────────────────────────────────────
function futPlaceOrder(action, margin, lev, px) {
  if (!S.apiKey || !S.apiSecret) return;
  const ts   = Date.now().toString();
  const notional  = margin * lev;
  const contracts = Math.max(1, Math.floor(notional / (0.0001 * px)));
  const side = action === 'open_long' ? 1 : 2;
  const body = JSON.stringify({ symbol:S.futPair, price:0, vol:contracts, side, type:5, openType:1, leverage:lev });
  const sig  = crypto.createHmac('sha256', S.apiSecret).update(S.apiKey + ts + body).digest('hex');
  const req  = https.request({
    hostname:'contract.mexc.com', path:'/api/v1/private/order/submit', method:'POST',
    headers:{'ApiKey':S.apiKey,'Request-Time':ts,'Signature':sig,'Content-Type':'application/json','Accept':'application/json'},
    timeout:8000
  }, res => {
    let d=''; res.on('data',c=>d+=c);
    res.on('end',()=>{
      try{const r=JSON.parse(d);if(r.success)log('FUT ORDER OK! id='+r.data,'profit');else log('FUT ORDER FAIL code='+r.code+' '+r.message,'err');}catch(e){}
    });
  });
  req.on('error', e => log('Fut order err: '+e.message,'err'));
  req.on('timeout', ()=>{req.destroy();log('Fut order timeout','err');});
  req.write(body); req.end();
}

// ── AI BRAIN ──────────────────────────────────────────────────────────────────
async function callAI(px, isFutures) {
  if (!S.aiKey) return;
  const now = Date.now();
  const last = isFutures ? S.aiFutLastCall : S.aiLastCall;
  if (now - last < S.aiInterval * 1000) return;
  if (isFutures) S.aiFutLastCall = now; else S.aiLastCall = now;
  S.aiCallCount++;

  const raw  = (isFutures ? futPX : PX.map(function(p){return p.px||p;})).filter(function(v){return v>0;});
  const n    = raw.length;
  const r14  = n>2  ? calcRSI(raw, Math.min(14,n-1)) : 50;
  const r9   = n>2  ? calcRSI(raw, Math.min(9,n-1))  : 50;
  const e9   = n>0  ? calcEMA(raw, Math.min(9,n))    : px;
  const e21  = n>0  ? calcEMA(raw, Math.min(21,n))   : px;
  const bb   = n>=10? calcBB(raw, Math.min(20,n))    : null;
  const hi10 = n>0  ? Math.max.apply(null,raw.slice(-Math.min(10,n))) : px;
  const lo10 = n>0  ? Math.min.apply(null,raw.slice(-Math.min(10,n))) : px;
  const dip  = ((px-hi10)/hi10*100).toFixed(3);
  const ch1  = n>1  ? ((px-raw[n-2])/raw[n-2]*100).toFixed(4) : '0';
  const ch5  = n>5  ? ((px-raw[n-6])/raw[n-6]*100).toFixed(4) : '0';
  const vol  = hi10>0 ? ((hi10-lo10)/lo10*100).toFixed(4) : '0';
  const trend= e9>e21*1.0002?'UPTREND':e9<e21*0.9998?'DOWNTREND':'SIDEWAYS';
  const bbPos= bb?(px<=bb.lower*1.002?'AT_SUPPORT':px>=bb.upper*0.998?'AT_RESISTANCE':px<bb.middle?'LOWER_HALF':'UPPER_HALF'):'UNKNOWN';
  const recentPx = raw.slice(-8).map(function(v){return v.toFixed(0);}).join(',');

  const allTrades = (isFutures ? S.futTrades : S.liveTrades).slice(0,10);
  const papTrades = (isFutures ? S.futPapTrades||[] : S.papTrades).slice(0,5);
  const tradeStr  = allTrades.map(function(t){return t.side+(t.net>=0?'+':'')+parseFloat(t.net).toFixed(3);}).join(' ')||'none';
  const papStr    = papTrades.map(function(t){return t.side+(t.net>=0?'+':'')+parseFloat(t.net).toFixed(3);}).join(' ')||'none';
  const recentLoss = allTrades.slice(0,3).filter(function(t){return t.net<0;}).length;
  const last5net   = allTrades.slice(0,5).reduce(function(s,t){return s+t.net;},0);

  const profit = isFutures ? S.futProfit  : S.liveProfit;
  const totalT = isFutures ? S.futT       : S.liveT;
  const wins   = isFutures ? S.futW       : S.liveW;
  const wr     = totalT>0 ? Math.round(wins/totalT*100) : 0;
  const cap    = isFutures ? S.futCapital : S.capital;
  const maxPos = isFutures ? S.futMaxPos  : S.maxPos;
  const lev    = isFutures ? S.futLeverage : 1;
  const feeRT  = isFutures ? 0.04 : 0.10;
  const posSize = cap / maxPos;
  const notional = posSize * lev;

  var openPos = (isFutures
    ? S.futOrders.concat(S.futPapOrders)
    : S.liveOrders.concat(S.papOrders)).filter(function(o){return o.status==='open';});

  // ══════════════════════════════════════════════════════════════════════
  // PROFESSIONAL TRADING PROMPT — Senior Trader Framework
  // Strategy: Scalp pullbacks in trend direction. Target 60%+ win rate.
  // Math: TP=0.30% SL=0.16% after 0.04% fee = net +0.26% / -0.20% = 1.3:1 R:R
  //       At 60% win rate: 0.6×0.26 - 0.4×0.20 = +0.076% per trade
  //       50 trades/day on $60 notional = $2.28/day on $20 margin = 11.4%/day
  // ══════════════════════════════════════════════════════════════════════

  // Detect RSI direction (rising or falling)
  var rsiRising = false, rsiFalling = false;
  if (n > 5) {
    var r14prev = calcRSI(raw.slice(0,-3), Math.min(14,n-4));
    rsiRising  = r14 > r14prev + 0.5;
    rsiFalling = r14 < r14prev - 0.5;
  }

  // Detect BB width (volatility) - wide = active market, narrow = dead
  var bbWidth = bb ? ((bb.upper - bb.lower) / bb.middle * 100).toFixed(3) : '0';
  var marketActive = parseFloat(bbWidth) > 0.08; // min 0.08% range to trade

  // Detect if price is near round number ($77000, $78000 etc) - key S/R
  var roundNum = Math.round(px / 100) * 100;
  var nearRound = Math.abs(px - roundNum) / px < 0.001; // within 0.1% of round

  // EMA50 for trend direction (use available data)
  var e50 = n>=50 ? calcEMA(raw, 50) : e21;
  var bigTrend = px > e50 ? 'BULLISH' : 'BEARISH';

  // Momentum: count consecutive up/down ticks
  var upTicks = 0, downTicks = 0;
  for (var ti = n-1; ti >= Math.max(0,n-5); ti--) {
    if (raw[ti] > raw[ti-1]) upTicks++;
    else if (raw[ti] < raw[ti-1]) downTicks++;
    else break;
  }

  // Loss streak for position sizing
  var lossStreak  = 0;
  for (var li=0; li<allTrades.length; li++) {
    if (allTrades[li].net < 0) lossStreak++;
    else break;
  }

  // Mode: RECOVERY (after losses) or NORMAL or AGGRESSIVE (after wins)
  var mode = lossStreak >= 3 ? 'RECOVERY' : last5net > 0 && wr >= 60 ? 'NORMAL' : 'NORMAL';

  var p = '';
  p += 'ROLE: You are a professional crypto scalp trader with 10 years experience.\n';
  p += 'GOAL: Consistent small profits that compound. Protect capital above all.\n\n';

  // ── ACCOUNT STATE ──
  p += 'ACCOUNT:\n';
  p += '  Balance P&L: $'+profit.toFixed(4)+' | Mode: '+mode+'\n';
  p += '  Win rate: '+wr+'% over '+totalT+' trades (target: 60%+)\n';
  p += '  Loss streak: '+lossStreak+' | Last 5 net: $'+last5net.toFixed(4)+'\n';
  p += '  Position: $'+posSize.toFixed(2)+' margin';
  if (isFutures) p += ' x'+lev+'x = $'+notional.toFixed(2)+' notional';
  p += ' | Fee: '+feeRT+'% RT\n';
  p += '  Recent: '+tradeStr+'\n\n';

  // ── MARKET ANALYSIS ──
  p += 'MARKET ANALYSIS ('+( isFutures?S.futPair+' PERP '+lev+'x':S.pair+' SPOT')+'):\n';
  p += '  Price: $'+px.toFixed(2)+'\n';
  p += '  BIG TREND (EMA50): '+bigTrend+' | Short trend: '+trend+'\n';
  p += '  RSI-14: '+r14.toFixed(1)+(rsiRising?' RISING':rsiFalling?' FALLING':' FLAT')+'\n';
  p += '  RSI-9: '+r9.toFixed(1)+' | EMA9: $'+e9.toFixed(2)+' vs EMA21: $'+e21.toFixed(2)+'\n';
  if (bb) {
    p += '  Bollinger: L=$'+bb.lower.toFixed(2)+' M=$'+bb.middle.toFixed(2)+' U=$'+bb.upper.toFixed(2)+'\n';
    p += '  BB Width: '+bbWidth+'% ('+( marketActive?'ACTIVE market':'DEAD market - avoid')+') | Position: '+bbPos+'\n';
  }
  p += '  Momentum: ch1='+ch1+'% ch5='+ch5+'% | UpTicks='+upTicks+' DownTicks='+downTicks+'\n';
  p += '  Dip from high: '+dip+'% | Volatility: '+vol+'%\n';
  p += '  Round number $'+roundNum+': '+(nearRound?'YES - key S/R level':'no')+'\n';
  p += '  Prices: '+recentPx+'\n\n';

  // ── OPEN POSITIONS ──
  if (openPos.length > 0) {
    p += 'OPEN POSITIONS:\n';
    openPos.forEach(function(o,i) {
      var isLng = o.direction !== 'SHORT';
      var curNet = isFutures ? futFee(o.entryPx,px,o.margin||posSize,o.leverage||lev,isLng).net : feeMath(o.entryPx,px,o.amt||posSize).net;
      var mv = ((px-o.entryPx)/o.entryPx*100).toFixed(3);
      var pctToTP = o.tp !== o.sl ? ((px-o.entryPx)/(o.tp-o.entryPx)*100).toFixed(0) : '?';
      p += '  ['+i+'] '+(o.direction||'LONG')+' @$'+o.entryPx.toFixed(2)+
           ' TP=$'+o.tp.toFixed(2)+' SL=$'+o.sl.toFixed(2)+
           ' | P&L='+(curNet>=0?'+':'')+'$'+curNet.toFixed(4)+' ('+mv+'%, '+pctToTP+'% to TP)'+
           (o.isPaper?' [paper]':' [LIVE]')+'\n';
    });
    p += '\n';
  }

  // ── PROFESSIONAL STRATEGY ──
  p += 'STRATEGY (Pullback Scalping in Trend Direction):\n\n';
  if (isFutures) {
    p += 'LONG SETUP (buy the dip in uptrend):\n';
    p += '  Required: RSI14 < 52 AND RSI RISING/FLAT AND dip < -0.03%\n';
    p += '  Confirm:  ch1 > 0 (price turning up) AND (AT_SUPPORT OR LOWER_HALF OR bigTrend=BULLISH)\n';
    p += '  Strong:   RSI14 < 45 = high priority. At BB lower = excellent entry.\n';
    p += '  Avoid:    RSI14 > 58, price at BB upper, momentum falling (upTicks=0)\n\n';
    p += 'SHORT SETUP (fade the rally in downtrend):\n';
    p += '  Required: RSI14 > 52 AND RSI FALLING/FLAT AND dip > -0.02% (near high)\n';
    p += '  Confirm:  ch1 < 0 (price turning down) AND (AT_RESISTANCE OR UPPER_HALF OR bigTrend=BEARISH)\n';
    p += '  Strong:   RSI14 > 60 = high priority. At BB upper = excellent entry.\n';
    p += '  Avoid:    RSI14 < 45, price at BB lower, momentum rising (downTicks=0)\n\n';
    p += 'DEAD MARKET RULE: If BB width < 0.06% = HOLD (no volatility = fees eat profits)\n\n';
  } else {
    p += 'BUY: RSI14<50 + RSI rising + dip<-0.03% + ch1>0 + (AT_SUPPORT or LOWER_HALF)\n';
    p += 'HOLD: RSI>60 or falling or no momentum\n\n';
  }

  p += 'TP/SL PROFESSIONAL SIZING:\n';
  p += '  Scalp (normal):  TP=0.28% SL=0.15% = R:R 1.9x — need 35% winrate\n';
  p += '  Standard:        TP=0.35% SL=0.18% = R:R 1.9x — need 35% winrate\n';
  p += '  Momentum (fast): TP=0.20% SL=0.12% = R:R 1.7x — quick in/out\n';
  p += '  Fee='+feeRT+'% RT. Min TP='+(feeRT+0.10).toFixed(2)+'% to profit after fees.\n\n';

  p += 'POSITION MANAGEMENT:\n';
  if (lossStreak >= 3) {
    p += '  RECOVERY MODE: '+lossStreak+' straight losses. Use tight SL=0.12%, small TP=0.20%. Rebuild slowly.\n';
  } else if (wr >= 65 && totalT >= 10) {
    p += '  WINNING: '+wr+'% win rate. Stay consistent. Do not widen SL.\n';
  }
  p += '  CLOSE position early if: momentum fully reversed AND position losing AND no sign of recovery.\n';
  p += '  HOLD position if: slight drawdown but trend intact (normal pullback within SL).\n\n';

  p += 'FREQUENCY TARGET: 20-50 trades/day for consistent compounding.\n';
  p += 'Do not be too selective. If 3+ signals align = ENTER. Consistency beats perfection.\n\n';

  p += 'JSON RESPONSE (no text outside JSON):\n';
  p += '{"action":"BUY","confidence":75,"reason":"RSI 44 rising, dip -0.08% bouncing, at BB support","risk":"low","tp_suggest":0.30,"sl_suggest":0.16,"close_positions":[]}\n';
  p += 'action: BUY | SHORT | HOLD\n';
  p += 'confidence: 55-100. Enter at 58+. Strong signal = 75+.\n';
  p += 'tp_suggest: your exact TP % recommendation\n';
  p += 'sl_suggest: your exact SL % recommendation (max 0.25)\n';
  p += 'close_positions: position indexes to close [0,1] or []\n';
  p += 'reason: max 10 words describing the setup\n';

  return new Promise(resolve => {
    const body = JSON.stringify({
      model:'deepseek-chat',
      messages:[{role:'system',content:'Expert crypto trader. JSON only, no other text.'},
                {role:'user',content:p}],
      max_tokens:120, temperature:0.1, stream:false
    });
    const req = https.request({
      hostname:'api.deepseek.com', path:'/v1/chat/completions', method:'POST',
      headers:{'Authorization':'Bearer '+S.aiKey,'Content-Type':'application/json',
               'Content-Length':Buffer.byteLength(body)},
      timeout:12000
    }, res => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try {
          const resp = JSON.parse(d);
          if (resp.error) { log('AI err: '+resp.error.message,'err'); resolve(null); return; }
          const raw2 = resp.choices?.[0]?.message?.content||'';
          const tokens = resp.usage?.total_tokens||0;
          S.aiTokensUsed += tokens;
          S.aiCost = parseFloat((S.aiTokensUsed/1000000*0.28).toFixed(6));
          const m = raw2.match(/\{[\s\S]*\}/);
          if (!m) { resolve(null); return; }
          const dec = JSON.parse(m[0]);
          dec.ts = new Date().toISOString().slice(11,19);
          dec.price = px; dec.tokens = tokens;
          if (isFutures) S.aiFutDecision = dec; else S.aiDecision = dec;

          // AI EXIT: close positions AI flagged
          if (Array.isArray(dec.close_positions) && dec.close_positions.length > 0) {
            var livePos  = (isFutures ? S.futOrders    : S.liveOrders).filter(function(o){return o.status==='open';});
            var paperPos = (isFutures ? S.futPapOrders : S.papOrders).filter(function(o){return o.status==='open';});
            var allPos   = livePos.concat(paperPos);
            dec.close_positions.forEach(function(idx) {
              var o = allPos[idx];
              if (!o || o.status !== 'open') return;
              var isLng  = o.direction !== 'SHORT';
              var exitPx = px;
              var result = isFutures
                ? futFee(o.entryPx, exitPx, o.margin, o.leverage, isLng)
                : feeMath(o.entryPx, exitPx, o.amt);
              var net = result.net, fee2 = result.fee;
              o.status = 'closed';
              var movePct = ((exitPx-o.entryPx)/o.entryPx*100).toFixed(3);
              log('AI-CLOSE pos['+idx+'] '+(o.direction||'LONG')+' @ $'+exitPx.toFixed(2)+
                  ' NET='+(net>=0?'+':'')+'$'+net.toFixed(4)+' | '+dec.reason, net>=0?'profit':'err');
              if (isFutures) {
                var trF = {n:o.isPaper?++S.futPapT:++S.futT, time:dec.ts, pair:S.futPair,
                  direction:o.direction||'LONG', isPaper:o.isPaper, side:'AI-CLOSE',
                  entryPx:o.entryPx, exitPx:exitPx, margin:o.margin, leverage:o.leverage,
                  notional:o.notional, move:movePct+'%', leveragedMove:(parseFloat(movePct)*o.leverage).toFixed(3)+'%',
                  fee:+fee2.toFixed(6), pnl:+(result.pnl||net+fee2).toFixed(6), net:+net.toFixed(6)};
                if (o.isPaper) {
                  S.futPapProfit+=net; S.futFees+=fee2; if(net>=0)S.futPapW++;else S.futPapL++;
                  S.futPapTrades.unshift(trF);
                } else {
                  S.futProfit+=net; S.futFees+=fee2; if(net>=0){S.futW++;if(net>S.futBest)S.futBest=net;}else S.futL++;
                  S.futTrades.unshift(trF);
                  futPlaceOrder(isLng?'close_long':'close_short', o.margin, o.leverage, exitPx);
                }
              } else {
                var trS = {n:o.isPaper?++S.papT:++S.liveT, time:dec.ts, pair:S.pair,
                  strat:o.strat, isPaper:o.isPaper, side:'AI-CLOSE',
                  entryPx:o.entryPx, exitPx:exitPx, amt:o.amt,
                  fee:+fee2.toFixed(6), gross:+(result.gross||Math.abs(net+fee2)).toFixed(6), net:+net.toFixed(6)};
                if (o.isPaper) {
                  S.papProfit+=net; S.papFees+=fee2; if(net>=0){S.papW++;if(net>S.papBest)S.papBest=net;}else S.papL++;
                  S.papTrades.unshift(trS);
                } else {
                  S.liveProfit+=net; S.todayP+=net; S.feesT+=fee2; if(net>=0){S.liveW++;if(net>S.bestT)S.bestT=net;}else S.liveL++;
                  S.liveTrades.unshift(trS);
                  placeOrder('SELL', o.qty, S.pair);
                }
              }
            });
            S.futOrders    = S.futOrders.filter(function(o){return o.status==='open';});
            S.futPapOrders = S.futPapOrders.filter(function(o){return o.status==='open';});
            S.liveOrders   = S.liveOrders.filter(function(o){return o.status==='open';});
            S.papOrders    = S.papOrders.filter(function(o){return o.status==='open';});
            save();
          }

          var emoji = dec.action==='BUY'?'AI-BUY':dec.action==='SHORT'?'AI-SHORT':'AI-HOLD';
          log(emoji+' conf='+dec.confidence+'% '+dec.reason+' risk='+dec.risk, dec.action!=='HOLD'&&dec.confidence>=(S.aiMinConf||65)?'buy':'info');
          resolve(dec);
        } catch(e) { log('AI parse err: '+e.message,'err'); resolve(null); }
      });
    });
    req.on('error', e=>{log('AI net err: '+e.message,'err');resolve(null);});
    req.on('timeout',()=>{req.destroy();log('AI timeout','err');resolve(null);});
    req.write(body); req.end();
  });
}

function checkAI(isFutures) {
  if (S.aiMode === 'off') return { ok:true, action:'BUY' };
  const dec = isFutures ? S.aiFutDecision : S.aiDecision;
  const min = S.aiMinConf || 65;
  if (!dec) return S.aiMode === 'ai-only' ? {ok:false,reason:'no-ai-decision'} : {ok:true,action:'BUY'};
  const age = Date.now() - (isFutures ? S.aiFutLastCall : S.aiLastCall);
  if (age > S.aiInterval * 2500) return S.aiMode === 'ai-only' ? {ok:false,reason:'stale'} : {ok:true,action:'BUY'};
  if (dec.action === 'HOLD') return { ok:false, reason:'AI HOLD conf='+dec.confidence+'%: '+dec.reason };
  if (dec.confidence < min) return { ok:false, reason:'AI conf '+dec.confidence+'% < min '+min+'%' };
  return { ok:true, action:dec.action, decision:dec };
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
function setH(res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Bot-Pin');
}
function send(res, code, data) {
  setH(res); res.writeHead(code,{'Content-Type':'application/json'});
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') { setH(res); res.writeHead(204); res.end(); return; }
  const url = req.url.split('?')[0];

  // Public
  if (url === '/ping' || url === '/health' || url === '/') {
    send(res,200,{ok:true,uptime:process.uptime().toFixed(0)+'s'}); return;
  }
  if (url === '/prices') { send(res,200,{prices:S.prices,ticks}); return; }
  if (url === '/debug') {
    send(res,200,{
      mode:S.mode, botOn:S.botOn, pair:S.pair, hasApiKey:!!S.apiKey, hasSecret:!!S.apiSecret,
      keyLen:S.apiKey.length, secLen:S.apiSecret.length,
      keyPreview:S.apiKey?S.apiKey.slice(0,6)+'....'+S.apiKey.slice(-4):'none',
      envKeySet:!!process.env.MEXC_KEY, envKeyLen:(process.env.MEXC_KEY||'').length,
      ticks, futTicks:S.futTicks, futuresOn:S.futuresOn,
      aiEnabled:!!S.aiKey, aiMode:S.aiMode, uptime:process.uptime().toFixed(0)+'s'
    }); return;
  }

  // PIN check
  if (req.headers['x-bot-pin'] !== BOT_PIN) { send(res,401,{error:'Invalid PIN'}); return; }

  // GET /status
  if (req.method === 'GET' && url === '/status') {
    const addPnl = o => Object.assign({},o,{livePnl:feeMath(o.entryPx,S.lastPx,o.amt).net,peakNet:o.peakNet||0});
    const addFPnl= o => Object.assign({},o,{livePnl:futFee(o.entryPx,S.futLastPx||S.lastPx,o.margin,o.leverage).net,peakNet:o.peakNet||0,beStopMoved:o.beStopMoved||false,bePx:o.bePx||0});
    send(res,200,{
      botOn:S.botOn, mode:S.mode, strategy:S.strategy, pair:S.pair,
      capital:S.capital, maxPos:S.maxPos, tpPct:S.tpPct, slPct:S.slPct,
      cooldown:S.cooldown, lastPx:S.lastPx, prices:S.prices, ticks,
      warmup:S.warmup, warmedUp:ticks>=S.warmup, feeRt:RT_FEE*100,
      liveProfit:S.liveProfit, todayP:S.todayP, liveT:S.liveT,
      liveW:S.liveW, liveL:S.liveL, bestT:S.bestT, feesT:S.feesT,
      liveWR:S.liveT>0?Math.round(S.liveW/S.liveT*100):0,
      papProfit:S.papProfit, papT:S.papT, papW:S.papW, papL:S.papL,
      papBest:S.papBest, papFees:S.papFees,
      papWR:S.papT>0?Math.round(S.papW/S.papT*100):0,
      liveOrders:S.liveOrders.filter(o=>o.status==='open').map(addPnl),
      papOrders:S.papOrders.filter(o=>o.status==='open').map(addPnl),
      liveTrades:S.liveTrades.slice(0,60), papTrades:S.papTrades.slice(0,60),
      hasApiKeys:!!(S.apiKey&&S.apiSecret), mexcBalance:S.mexcBalance,
      startedAt:S.startedAt, savedAt:S.savedAt,
      futuresOn:S.futuresOn, futMode:S.futMode, futPair:S.futPair,
      futCapital:S.futCapital, futMaxPos:S.futMaxPos, futLeverage:S.futLeverage,
      futTpPct:S.futTpPct, futSlPct:S.futSlPct, futLastPx:S.futLastPx,
      futFeeRt:FUT_RT_FEE*100, futTicks:S.futTicks,
      futProfit:S.futProfit, futT:S.futT, futW:S.futW, futL:S.futL,
      futBest:S.futBest, futFees:S.futFees,
      futWR:S.futT>0?Math.round(S.futW/S.futT*100):0,
      futPapProfit:S.futPapProfit, futPapT:S.futPapT,
      futPapW:S.futPapW, futPapL:S.futPapL,
      futPapWR:S.futPapT>0?Math.round(S.futPapW/S.futPapT*100):0,
      futOrders:S.futOrders.filter(o=>o.status==='open').map(addFPnl),
      futPapOrders:S.futPapOrders.filter(o=>o.status==='open').map(addFPnl),
      futTrades:S.futTrades.slice(0,50), futPapTrades:S.futPapTrades.slice(0,50),
      aiEnabled:!!(S.aiKey), aiMode:S.aiMode, aiInterval:S.aiInterval,
      aiMinConf:S.aiMinConf, aiDecision:S.aiDecision, aiFutDecision:S.aiFutDecision,
      aiCallCount:S.aiCallCount, aiTokensUsed:S.aiTokensUsed, aiCost:S.aiCost,
      log:S.log.slice(0,150)
    }); return;
  }

  // GET /balance
  if (url === '/balance') {
    if (!S.apiKey||!S.apiSecret){send(res,400,{error:'No API keys'});return;}
    mexcRequest('GET','/api/v3/account',{},S.apiKey,S.apiSecret,(err,r)=>{
      if(err){send(res,500,{error:err.message});return;}
      if(r.balances){
        const u=r.balances.find(b=>b.asset==='USDT');
        const coinName=S.pair.replace('USDT','');
        const coin=r.balances.find(b=>b.asset===coinName);
        const free=parseFloat(u?.free||0).toFixed(4);
        S.mexcBalance=free;
        log('Wallet USDT=$'+free+' free','profit');
        send(res,200,{ok:true,usdt:{free:u?.free||'0',locked:u?.locked||'0'},coin:{asset:coinName,free:coin?.free||'0',locked:coin?.locked||'0'}});
      } else {
        log('Balance err: code='+r.code+' '+r.msg,'err');
        send(res,200,{ok:false,error:r.msg,code:r.code});
      }
    }); return;
  }

  // GET /futuresbalance
  if (url === '/futuresbalance') {
    if (!S.apiKey||!S.apiSecret){send(res,400,{error:'No API keys'});return;}
    const ts=Date.now().toString();
    const sig=crypto.createHmac('sha256',S.apiSecret).update(S.apiKey+ts).digest('hex');
    https.request({hostname:'contract.mexc.com',path:'/api/v1/private/account/assets',method:'GET',
      headers:{'ApiKey':S.apiKey,'Request-Time':ts,'Signature':sig,'Accept':'application/json'},timeout:8000},r=>{
      let d='';r.on('data',c=>d+=c);r.on('end',()=>{
        try{const j=JSON.parse(d);if(j.success){const u=Array.isArray(j.data)?j.data.find(a=>a.currency==='USDT'):j.data;send(res,200,{ok:true,availableBalance:u?.availableBalance||'0',equity:u?.equity||'0'});}else send(res,200,{ok:false,error:j.message||'unknown'});}catch(e){send(res,500,{error:e.message});}
      });
    }).on('error',e=>send(res,500,{error:e.message})).end(); return;
  }

  // GET /testconnection
  if (url === '/testconnection') {
    if (!S.apiKey||!S.apiSecret){send(res,400,{error:'No API keys saved'});return;}
    mexcRequest('GET','/api/v3/account',{},S.apiKey,S.apiSecret,(err,r)=>{
      if(err){log('Test err: '+err.message,'err');send(res,500,{error:err.message});return;}
      if(r.balances){const u=r.balances.find(b=>b.asset==='USDT');const bal=parseFloat(u?.free||0).toFixed(4);S.mexcBalance=bal;log('MEXC VERIFIED! USDT=$'+bal,'profit');send(res,200,{ok:true,balance:bal});}
      else{log('Test failed code='+r.code+' '+r.msg,'err');send(res,200,{ok:false,error:r.msg,code:r.code});}
    }); return;
  }

  // POST endpoints
  if (req.method !== 'POST') { send(res,404,{error:'Not found'}); return; }
  let body=''; req.on('data',c=>body+=c);
  req.on('end', async ()=>{
    let d={}; try{d=JSON.parse(body);}catch(e){}

    if (url==='/savekeys') {
      if(!d.apiKey||!d.apiSecret){send(res,400,{error:'apiKey and apiSecret required'});return;}
      const k=d.apiKey.trim().replace(/\s/g,''), s=d.apiSecret.trim().replace(/\s/g,'');
      if(k.length<10){send(res,400,{error:'Key too short — copy full key from MEXC'});return;}
      S.apiKey=k; S.apiSecret=s; save();
      log('Keys saved: '+k.slice(0,6)+'...'+k.slice(-4)+' (len='+k.length+')','info');
      mexcRequest('GET','/api/v3/account',{},k,s,(err,r)=>{
        if(r?.balances){const u=r.balances.find(b=>b.asset==='USDT');const bal=parseFloat(u?.free||0).toFixed(4);S.mexcBalance=bal;log('KEYS VERIFIED! USDT=$'+bal,'profit');}
        else if(r?.code) log('Key test fail code='+r.code+' '+r.msg,'err');
      });
      send(res,200,{ok:true,keyLength:k.length,secLength:s.length}); return;
    }

    if (url==='/config') {
      if(d.pair)     S.pair     = d.pair.replace('/','');
      if(d.strategy) S.strategy = d.strategy;
      if(d.mode)     S.mode     = d.mode;
      if(d.capital)  S.capital  = parseFloat(d.capital)||20;
      if(d.maxPos)   S.maxPos   = parseInt(d.maxPos)||1;
      if(d.tpPct)    S.tpPct    = Math.max(parseFloat(d.tpPct), RT_FEE*100+0.12);
      if(d.slPct)    S.slPct    = Math.max(parseFloat(d.slPct), 0.10);
      if(d.cooldown) S.cooldown = parseInt(d.cooldown)*1000||10000;
      if(d.apiKey&&d.apiKey.length>10&&d.apiSecret){S.apiKey=d.apiKey.trim();S.apiSecret=d.apiSecret.trim();}
      save();
      log('Config: '+S.pair+' mode='+S.mode+' tp='+S.tpPct+'% sl='+S.slPct+'%','info');
      send(res,200,{ok:true,tpPct:S.tpPct,slPct:S.slPct,mode:S.mode,hasKeys:!!(S.apiKey&&S.apiSecret)}); return;
    }

    if (url==='/start') {
      S.botOn=true; S.liveOrders=[]; S.papOrders=[]; S.lastEntry=0;
      S.startedAt=new Date().toISOString(); PX=[]; ticks=0;
      startFeed();
      log('Bot STARTED pair='+S.pair+' mode='+S.mode+' keys='+(!!S.apiKey),'buy');
      save(); send(res,200,{ok:true}); return;
    }

    if (url==='/stop') {
      S.botOn=false; S.liveOrders=[]; S.papOrders=[];
      stopFeed(); log('Bot stopped','info'); save(); send(res,200,{ok:true}); return;
    }

    if (url==='/setlive') {
      if(!S.apiKey||!S.apiSecret){send(res,400,{error:'No API keys — save keys first'});return;}
      S.mode='live'; S.lastLiveEntry=0; save();
      log('LIVE MODE ON: '+S.pair+' tp='+S.tpPct+'% sl='+S.slPct+'%','buy');
      send(res,200,{ok:true,mode:'live',pair:S.pair,capital:S.capital}); return;
    }

    if (url==='/setpaper') {
      S.mode='paper'; save(); log('Paper mode','info');
      send(res,200,{ok:true,mode:'paper'}); return;
    }

    if (url==='/reset') {
      const k=S.apiKey,s=S.apiSecret;
      Object.assign(S,{liveProfit:0,todayP:0,liveT:0,liveW:0,liveL:0,bestT:0,feesT:0,
        papProfit:0,papT:0,papW:0,papL:0,papBest:0,papFees:0,
        liveTrades:[],papTrades:[],liveOrders:[],papOrders:[],log:[]});
      S.apiKey=k; S.apiSecret=s; save(); send(res,200,{ok:true}); return;
    }

    if (url==='/resetpaper') {
      Object.assign(S,{papProfit:0,papT:0,papW:0,papL:0,papBest:0,papFees:0,papTrades:[],papOrders:[]});
      save(); send(res,200,{ok:true}); return;
    }

    if (url==='/startfutures') {
      S.futuresOn=true; S.futOrders=[]; S.futPapOrders=[]; S.futLastEntry=0;
      futPX=[]; futTicks=0;
      startFuturesFeed();
      const m=S.futCapital/S.futMaxPos;
      log('FUTURES STARTED: '+S.futPair+' '+S.futLeverage+'x margin=$'+m.toFixed(2)+' tp='+S.futTpPct+'% sl='+S.futSlPct+'% mode='+S.futMode,'buy');
      save(); send(res,200,{ok:true}); return;
    }

    if (url==='/stopfutures') {
      S.futuresOn=false; S.futOrders=[]; S.futPapOrders=[];
      stopFuturesFeed(); log('Futures stopped','info'); save(); send(res,200,{ok:true}); return;
    }

    if (url==='/configfutures') {
      if(d.futPair)     S.futPair     = d.futPair;
      if(d.futCapital)  S.futCapital  = parseFloat(d.futCapital)||20;
      if(d.futMaxPos)   S.futMaxPos   = parseInt(d.futMaxPos)||1;
      if(d.futLeverage) S.futLeverage = Math.min(parseInt(d.futLeverage)||3,10);
      if(d.futTpPct)    S.futTpPct    = Math.max(parseFloat(d.futTpPct), FUT_RT_FEE*100+0.08);
      if(d.futSlPct)    S.futSlPct    = Math.max(parseFloat(d.futSlPct), 0.10);
      if(d.futMode)     S.futMode     = d.futMode;
      if(d.futCooldown) S.futCooldown = parseInt(d.futCooldown)*1000||8000;
      if(d.futMaxDaily) S.futMaxDaily = parseInt(d.futMaxDaily)||300;
      save();
      const m=S.futCapital/S.futMaxPos;
      log('Futures config: '+S.futPair+' '+S.futLeverage+'x tp='+S.futTpPct+'% sl='+S.futSlPct+'%','info');
      send(res,200,{ok:true,futTpPct:S.futTpPct,posMargin:m,notional:m*S.futLeverage}); return;
    }

    if (url==='/resetfutures') {
      Object.assign(S,{futProfit:0,futT:0,futW:0,futL:0,futBest:0,futFees:0,
        futPapProfit:0,futPapT:0,futPapW:0,futPapL:0,
        futTrades:[],futPapTrades:[],futOrders:[],futPapOrders:[]});
      save(); send(res,200,{ok:true}); return;
    }

    if (url==='/setaikey') {
      if(!d.aiKey){send(res,400,{error:'aiKey required'});return;}
      S.aiKey=d.aiKey.trim();
      if(d.aiMode)     S.aiMode     = d.aiMode;
      if(d.aiInterval) S.aiInterval = parseInt(d.aiInterval)||30;
      if(d.aiMinConf)  S.aiMinConf  = parseInt(d.aiMinConf)||65;
      S.aiLastCall=0; S.aiFutLastCall=0; S.aiDecision=null; S.aiFutDecision=null;
      save();
      log('AI AGENT ACTIVATED mode='+S.aiMode+' interval='+S.aiInterval+'s minConf='+S.aiMinConf+'%','buy');
      send(res,200,{ok:true,mode:S.aiMode,interval:S.aiInterval,minConf:S.aiMinConf}); return;
    }

    if (url==='/aidecision') {
      if(!S.aiKey){send(res,400,{error:'No AI key'});return;}
      const px=d.isFutures?(S.futLastPx||S.lastPx):S.lastPx;
      const dec=await callAI(px,!!d.isFutures);
      send(res,200,{ok:true,decision:dec||S.aiDecision,futDecision:S.aiFutDecision}); return;
    }

    if (url==='/closetrade') {
      const orders = d.isPaper ? S.papOrders : S.liveOrders;
      const o = orders.find(o => String(o.id) === String(d.id) && o.status === 'open');
      if (!o) {
        log('Close failed: id='+d.id+' isPaper='+d.isPaper+' open orders: '+orders.filter(o=>o.status==='open').map(o=>o.id).join(','), 'err');
        send(res,404,{error:'Position not found. ID='+d.id}); return;
      }
      const px=S.lastPx;
      const{net,fee,gross}=feeMath(o.entryPx,px,o.amt);
      o.status='closed';
      const tr={n:d.isPaper?++S.papT:++S.liveT,time:new Date().toISOString().slice(11,19),pair:S.pair,strat:o.strat,isPaper:d.isPaper,side:'MANUAL',entryPx:o.entryPx,exitPx:px,amt:o.amt,fee:+fee.toFixed(6),gross:+gross.toFixed(6),net:+net.toFixed(6)};
      if(d.isPaper){S.papProfit+=net;S.papFees+=fee;if(net>=0){S.papW++;if(net>S.papBest)S.papBest=net;}else S.papL++;S.papTrades.unshift(tr);S.papOrders=S.papOrders.filter(o=>o.status==='open');}
      else{S.liveProfit+=net;S.todayP+=net;S.feesT+=fee;if(net>=0){S.liveW++;if(net>S.bestT)S.bestT=net;}else S.liveL++;S.liveTrades.unshift(tr);S.liveOrders=S.liveOrders.filter(o=>o.status==='open');placeOrder('SELL',o.qty,S.pair);}
      log('MANUAL CLOSE spot @ $'+px.toFixed(2)+' NET='+(net>=0?'+':'')+'$'+net.toFixed(4),'info');
      save(); send(res,200,{ok:true,net,fee,exitPx:px}); return;
    }

    if (url==='/closefuttrade') {
      const orders = d.isPaper ? S.futPapOrders : S.futOrders;
      const o = orders.find(o => o.id == d.id && o.status === 'open');
      if (!o) { send(res,404,{error:'Futures position not found. May already be closed.'}); return; }
      const px      = S.futLastPx || S.lastPx;
      const isLng   = o.direction !== 'SHORT';
      const {net,fee,pnl} = futFee(o.entryPx, px, o.margin, o.leverage, isLng);
      o.status = 'closed';
      const movePct = ((px - o.entryPx) / o.entryPx * 100).toFixed(3);
      const levMove = (parseFloat(movePct) * o.leverage).toFixed(3);
      const tr = {
        n: d.isPaper ? ++S.futPapT : ++S.futT,
        time: new Date().toISOString().slice(11,19),
        pair: S.futPair, direction: o.direction||'LONG',
        isPaper: d.isPaper, side: 'MANUAL',
        entryPx: o.entryPx, exitPx: px,
        margin: o.margin, leverage: o.leverage, notional: o.notional,
        move: movePct+'%', leveragedMove: levMove+'%',
        fee: +fee.toFixed(6), pnl: +pnl.toFixed(6), net: +net.toFixed(6)
      };
      if (d.isPaper) {
        S.futPapProfit += net; S.futFees += fee;
        if (net >= 0) S.futPapW++; else S.futPapL++;
        S.futPapTrades.unshift(tr);
        S.futPapOrders = S.futPapOrders.filter(o => o.status === 'open');
      } else {
        S.futProfit += net; S.futFees += fee;
        if (net >= 0) { S.futW++; if (net > S.futBest) S.futBest = net; } else S.futL++;
        S.futTrades.unshift(tr);
        S.futOrders = S.futOrders.filter(o => o.status === 'open');
        // Close the correct direction on MEXC
        const closeAction = isLng ? 'close_long' : 'close_short';
        futPlaceOrder(closeAction, o.margin, o.leverage, px);
      }
      log('MANUAL CLOSE fut '+o.direction+' @ $'+px.toFixed(2)+' NET='+(net>=0?'+':'')+'$'+net.toFixed(4), net>=0?'profit':'info');
      save();
      send(res, 200, {ok:true, net, fee, exitPx:px, direction:o.direction});
      return;
    }

    send(res,404,{error:'Not found: '+url});
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server listening on 0.0.0.0:' + PORT);
  load();
  if (ENV_KEY) { S.apiKey=ENV_KEY; console.log('Key from env: len='+ENV_KEY.length); }
  if (ENV_SECRET) S.apiSecret=ENV_SECRET;
  if (S.botOn || ENV_RUNNING) {
    S.botOn=true; PX=[]; ticks=0;
    S.liveOrders=[]; S.papOrders=[];
    log('Auto-starting bot mode='+S.mode,'buy');
    startFeed();
  } else {
    log('Bot ready. Press Start.','info');
  }
});

server.on('error', e => { console.error(e); process.exit(1); });
process.on('SIGTERM', ()=>{ save(); process.exit(0); });
process.on('SIGINT',  ()=>{ save(); process.exit(0); });
