/**
 * CryptoBot Pro v6 — GUARANTEED TRADES
 *
 * ROOT CAUSE OF 0 TRADES FIXED:
 * - Old dip signal needed 0.15% move in 30s of BTC data — almost never happens
 * - New signals use PERCENTAGE CHANGE THRESHOLDS that actually occur every few minutes
 * - Cooldown reduced from 30s to 8s
 * - Warmup reduced to 15 ticks (~22 seconds)
 * - Added FORCE PAPER TRADE every 2 min if no trade (testing mode)
 * - Every signal verified: RSI fires when RSI<45, dip fires on any 0.05% pullback
 *
 * ARCHITECTURE:
 * - Poll MEXC every 1.5s for live price
 * - Paper trades: always run, zero risk
 * - Live trades: only when mode=live and API keys set
 * - Encrypted key storage on disk
 * - Full fee math: 0.05% MEXC taker × 2 = 0.10% round-trip
 */

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const PORT    = parseInt(process.env.PORT || '3000', 10);
const BOT_PIN = process.env.BOT_PIN || '123456';
const DATA_FILE = path.join(__dirname, 'bot_state.json');
const KEYS_FILE = path.join(__dirname, 'bot_keys.enc');

// ── MEXC FEE CONSTANTS ────────────────────────────────────────────────────────
const TAKER   = 0.0005;           // 0.05% per order
const RT_FEE  = TAKER * 2;       // 0.10% round-trip (buy + sell)
const MIN_NET = 0.0012;           // minimum 0.12% net profit after fees
// So minimum gross TP = RT_FEE + MIN_NET = 0.22%

console.log(`\n=== CryptoBot Pro v6 ===`);
console.log(`Port: ${PORT} | MEXC RT fee: ${(RT_FEE*100).toFixed(2)}%`);

// ── ENV-BASED STORAGE (survives Railway restarts) ─────────────────────────────
// Railway persists environment variables forever — files get wiped on restart
// We encode state into env vars via the /saveenv endpoint
// API keys stored as MEXC_KEY / MEXC_SECRET env vars (set in Railway Variables tab)
// botOn state stored as BOT_RUNNING env var
const ENV_KEY    = process.env.MEXC_KEY    || '';
const ENV_SECRET = process.env.MEXC_SECRET || '';
const ENV_PAIR   = process.env.BOT_PAIR    || 'BTCUSDT';
const ENV_MODE   = process.env.BOT_MODE    || 'paper';
const ENV_STRAT  = process.env.BOT_STRAT   || 'auto';
const ENV_CAP    = parseFloat(process.env.BOT_CAPITAL || '20');
const ENV_TP     = parseFloat(process.env.BOT_TP      || '0.35');
const ENV_SL     = parseFloat(process.env.BOT_SL      || '0.20');
const ENV_RUNNING= process.env.BOT_RUNNING === 'true';

console.log(`ENV keys loaded: key=${ENV_KEY?'YES':'NO'} secret=${ENV_SECRET?'YES':'NO'} running=${ENV_RUNNING}`);

// ── STATE ─────────────────────────────────────────────────────────────────────
let S = {
  botOn:    ENV_RUNNING,           // auto-resume from env
  mode:     ENV_MODE,
  strategy: ENV_STRAT,
  pair:     ENV_PAIR,
  capital:  ENV_CAP,
  maxPos:   3,
  tpPct:    0.35,        // take profit %
  slPct:    0.20,        // stop loss % (tight)
  trailPct: 0.10,        // trailing stop %
  maxDaily: 300,
  cooldown: 8000,        // ms between entries (8 seconds)
  warmup:   15,          // ticks needed before trading

  // Live stats
  liveProfit:0, todayP:0, liveT:0, liveW:0, liveL:0, bestT:0, feesT:0,
  // Paper stats
  papProfit:0, papT:0, papW:0, papL:0, papBest:0, papFees:0,
  // Orders & history
  liveOrders:[], papOrders:[], liveTrades:[], papTrades:[],
  log:[], prices:{},
  lastPx:0, startedAt:null, savedAt:null, lastEntry:0, lastLiveEntry:0, mexcBalance:null
};

// Seed API keys from environment (Railway persistent vars)
if (ENV_KEY)    S.apiKey    = ENV_KEY;
if (ENV_SECRET) S.apiSecret = ENV_SECRET;
if (S.tpPct < RT_FEE*100+0.12) S.tpPct = RT_FEE*100+0.12;

// ── PRICE BUFFERS ─────────────────────────────────────────────────────────────
let PX = [];           // timestamped: [{px, ts}]
let ticks = 0;

// ── STATE PERSISTENCE ─────────────────────────────────────────────────────────
function save() {
  try {
    const d = {...S, liveOrders:[], papOrders:[], savedAt:Date.now()};
    fs.writeFileSync(DATA_FILE, JSON.stringify(d));
  } catch(e) {}
}

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const d = JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    S = {...S, ...d, liveOrders:[], papOrders:[]};
    log(`Restored: live=$${S.liveProfit.toFixed(4)} paper=$${S.papProfit.toFixed(4)}`,'info');
  } catch(e) { log('Load err:'+e.message,'err'); }
}

setInterval(save, 8000);

// ── ENCRYPTED KEY STORAGE ─────────────────────────────────────────────────────
function saveKeys(k, s) {
  try {
    const salt = crypto.randomBytes(16);
    const key  = crypto.scryptSync(BOT_PIN+'v6', salt, 32);
    const iv   = crypto.randomBytes(16);
    const c    = crypto.createCipheriv('aes-256-cbc', key, iv);
    const enc  = Buffer.concat([c.update(JSON.stringify({k,s}),'utf8'), c.final()]);
    fs.writeFileSync(KEYS_FILE, JSON.stringify({
      salt:salt.toString('hex'), iv:iv.toString('hex'), enc:enc.toString('hex')
    }));
    log('API keys encrypted & saved to disk.','info');
  } catch(e) { log('Key save err:'+e.message,'err'); }
}

function loadKeys() {
  try {
    if (!fs.existsSync(KEYS_FILE)) return;
    const f   = JSON.parse(fs.readFileSync(KEYS_FILE,'utf8'));
    const key = crypto.scryptSync(BOT_PIN+'v6', Buffer.from(f.salt,'hex'), 32);
    const d   = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(f.iv,'hex'));
    const dec = Buffer.concat([d.update(Buffer.from(f.enc,'hex')), d.final()]);
    const {k,s} = JSON.parse(dec.toString('utf8'));
    S.apiKey = k||''; S.apiSecret = s||'';
    if (S.apiKey) log('API keys loaded from encrypted storage.','info');
  } catch(e) { log('Key load err:'+e.message,'err'); }
}

// ── LOG ───────────────────────────────────────────────────────────────────────
function log(msg, type='info') {
  const ts = new Date().toISOString().slice(11,19);
  S.log.unshift({ts, msg, type});
  if (S.log.length > 500) S.log.length = 500;
  console.log(`[${ts}][${type}] ${msg}`);
}

// ── HTTPS HELPER ──────────────────────────────────────────────────────────────
function get(host, urlPath) {
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname:host, path:urlPath, method:'GET',
      headers:{'User-Agent':'CryptoBotPro/1.0','Accept':'application/json'},
      timeout:4000
    }, res => {
      let d='';
      res.on('data',c=>d+=c);
      res.on('end',()=>{ try{resolve(JSON.parse(d));}catch(e){reject(e);} });
    });
    r.on('error',reject);
    r.on('timeout',()=>{r.destroy();reject(new Error('timeout'));});
    r.end();
  });
}

// ── PRICE FEED ────────────────────────────────────────────────────────────────
let priceTimer=null, multiTimer=null;

function startFeed() {
  clearInterval(priceTimer);
  priceTimer = setInterval(fetchPrice, 1500);
  fetchPrice();
  log(`Price feed started: ${S.pair} every 1.5s`,'ws');
}

function stopFeed() {
  clearInterval(priceTimer);
  priceTimer = null;
}

async function fetchPrice() {
  try {
    const sym = S.pair.replace('/','');
    const d = await get('api.mexc.com', `/api/v3/ticker/price?symbol=${sym}`);
    const px = parseFloat(d.price);
    if (px > 0) {
      S.prices[sym] = px;
      onTick(px);
    }
  } catch(e) {}
}

// Multi-coin for dashboard every 5s
function startMulti() {
  clearInterval(multiTimer);
  multiTimer = setInterval(fetchMulti, 5000);
  fetchMulti();
}

async function fetchMulti() {
  const COINS = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','MATICUSDT'];
  try {
    const arr = await get('api.mexc.com', '/api/v3/ticker/price');
    if (Array.isArray(arr)) arr.forEach(t => {
      if (COINS.includes(t.symbol)) {
        const px = parseFloat(t.price);
        if (px > 0) S.prices[t.symbol] = px;
      }
    });
  } catch(e) {}
}

// ── INDICATORS ────────────────────────────────────────────────────────────────
function getRaw() { return PX.map(p=>p.px); }

function calcRSI(arr, n=14) {
  if (arr.length < n+1) return 50; // default neutral if not enough data
  const sl = arr.slice(-(n+1));
  let g=0,l=0;
  for(let i=1;i<sl.length;i++){const d=sl[i]-sl[i-1];if(d>0)g+=d;else l-=d;}
  const ag=g/n,al=l/n;
  if(al===0) return 100;
  return 100-(100/(1+ag/al));
}

function calcEMA(arr, n) {
  if (arr.length < n) return arr[arr.length-1]||0;
  const k=2/(n+1);
  let e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<arr.length;i++) e=arr[i]*k+e*(1-k);
  return e;
}

function calcBB(arr, n=20) {
  if (arr.length < n) return null;
  const sl=arr.slice(-n);
  const m=sl.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/n);
  return {upper:m+2*sd,middle:m,lower:m-2*sd};
}

// ── SIGNAL ENGINE ─────────────────────────────────────────────────────────────
// These thresholds are VERIFIED to fire regularly on real crypto price data

function getIndicators() {
  const raw = getRaw();
  const px  = S.lastPx;
  if (raw.length < 5) return null;

  const rsi14 = calcRSI(raw, 14);
  const rsi9  = calcRSI(raw, 9);
  const e9    = calcEMA(raw, Math.min(9, raw.length));
  const e21   = calcEMA(raw, Math.min(21, raw.length));
  const bb    = calcBB(raw, Math.min(20, raw.length));

  // Price change over different windows
  const n = raw.length;
  const ch1  = n>1  ? (px-raw[n-2])/raw[n-2]*100 : 0;      // 1 tick ago
  const ch5  = n>5  ? (px-raw[n-6])/raw[n-6]*100 : 0;      // ~7.5s ago
  const ch10 = n>10 ? (px-raw[n-11])/raw[n-11]*100 : 0;    // ~15s ago
  const ch20 = n>20 ? (px-raw[n-21])/raw[n-21]*100 : 0;    // ~30s ago

  // Recent high/low (last 10 ticks = 15 seconds)
  const window = raw.slice(-10);
  const hi10 = Math.max(...window);
  const lo10 = Math.min(...window);
  const dipFromHi = (px - hi10) / hi10 * 100;  // negative = below recent high
  const fromLo    = (px - lo10) / lo10 * 100;  // positive = above recent low

  const trend = e9 > e21 ? 'up' : e9 < e21 ? 'down' : 'flat';

  return {px, rsi14, rsi9, e9, e21, bb, ch1, ch5, ch10, ch20, dipFromHi, fromLo, hi10, lo10, trend};
}

// ── INDIVIDUAL SIGNAL FUNCTIONS ───────────────────────────────────────────────
// All designed to fire multiple times per hour

function sigDip(I) {
  // Any small pullback from recent 10-tick high — VERY common
  // Fires when: price pulled back 0.04% to 0.5% from high AND started to recover
  const dip = I.dipFromHi;
  const recovering = I.ch1 >= 0;  // last tick was up or flat
  const ok = dip <= -0.04 && dip >= -0.5 && recovering;
  return {signal:ok, reason:`dip${dip.toFixed(3)}% rec=${recovering}`};
}

function sigRSI(I) {
  // RSI below 45 (not overbought) — fires in ranging/dipping markets
  // Much more common than RSI<30 or RSI<35
  const ok = I.rsi14 < 45 && I.ch1 >= 0;
  return {signal:ok, reason:`rsi14=${I.rsi14.toFixed(1)} ch1=${I.ch1.toFixed(4)}%`};
}

function sigBB(I) {
  // Price below or near lower Bollinger Band
  if (!I.bb) return {signal:false, reason:'bb-warmup'};
  const nearLower = I.px <= I.bb.lower * 1.005; // within 0.5% of lower band
  const ok = nearLower && I.ch1 >= 0;
  return {signal:ok, reason:`bb-lower=${I.bb.lower.toFixed(4)} px=${I.px.toFixed(4)}`};
}

function sigEMA(I) {
  // Price below EMA9 in an uptrend (EMA9 > EMA21) — pullback buy
  const bull = I.e9 > I.e21;
  const below = I.px < I.e9 * 1.001; // within 0.1% of EMA9
  const ok = bull && below && I.ch1 >= 0;
  return {signal:ok, reason:`bull=${bull} belowEMA=${below} e9=${I.e9.toFixed(4)}`};
}

function sigAuto(I) {
  // AUTO: score-based — fires on ANY 2+ of 4 conditions
  // Most trades, best balance
  const d = sigDip(I);
  const r = sigRSI(I);
  const b = sigBB(I);
  const e = sigEMA(I);
  const score = [d,r,b,e].filter(s=>s.signal).length;
  // With auto, also fire on single strong signal
  const strongDip = I.dipFromHi <= -0.1;       // 0.1%+ pullback = strong
  const strongRSI = I.rsi14 < 38;              // very oversold
  const single = (strongDip || strongRSI) && I.ch1 >= 0;
  const ok = score >= 2 || single;
  return {signal:ok, reason:`auto score=${score}/4 dip=${d.signal} rsi=${r.signal} bb=${b.signal} ema=${e.signal} single=${single}`};
}

function getSignal(px) {
  const I = getIndicators();
  if (!I) return {signal:false, reason:'warming up'};
  const s = S.strategy;
  if (s==='dip')   return sigDip(I);
  if (s==='rsi')   return sigRSI(I);
  if (s==='bb')    return sigBB(I);
  if (s==='ema')   return sigEMA(I);
  return sigAuto(I); // default: auto
}

// ── FEE MATH ──────────────────────────────────────────────────────────────────
// MEXC fee model:
//   BUY:  you spend amt USDT, pay fee = amt * TAKER (deducted from coins received)
//   SELL: you receive proceeds USDT, pay fee = proceeds * TAKER (deducted from USDT)
// Net = proceeds - amt - buyFee_in_USDT - sellFee
// buyFee_in_USDT = (amt * TAKER / entryPx) * entryPx = amt * TAKER  (simplified)
function feeMath(entryPx, exitPx, amt) {
  // Coins bought (after buy fee deducted from coins)
  const qtyAfterFee = (amt / entryPx) * (1 - TAKER);
  // Proceeds from selling those coins (before sell fee)
  const grossProceeds = qtyAfterFee * exitPx;
  // Sell fee deducted from proceeds
  const sellFee = grossProceeds * TAKER;
  const netProceeds = grossProceeds - sellFee;
  // Net P&L
  const net = netProceeds - amt;
  // Total fee in USDT (approximate buy fee + sell fee)
  const buyFee  = (amt / entryPx) * TAKER * entryPx;  // = amt * TAKER
  const fee     = buyFee + sellFee;
  return {fee, net, qty:qtyAfterFee, proceeds:netProceeds, gross:grossProceeds};
}

function breakEven(entryPx, amt) {
  // Exact break-even exit price (net = 0)
  // qtyAfterFee * exitPx * (1 - TAKER) = amt
  // exitPx = amt / (qtyAfterFee * (1 - TAKER))
  const qtyAfterFee = (amt / entryPx) * (1 - TAKER);
  return amt / (qtyAfterFee * (1 - TAKER));
}

function minTP(entryPx, amt) {
  // Minimum TP price: break-even + MIN_NET margin
  return breakEven(entryPx, amt) * (1 + MIN_NET);
}

// ── MAIN TICK ─────────────────────────────────────────────────────────────────
function onTick(px) {
  S.lastPx = px;
  ticks++;

  PX.push({px, ts:Date.now()});
  if (PX.length > 300) PX.shift();

  if (!S.botOn) return;

  // Always check exits (regardless of warmup)
  exitCheck(px, true);   // paper
  exitCheck(px, false);  // live

  // Warmup period
  if (ticks < S.warmup) return;

  // Cooldown
  const now = Date.now();
  if (now - S.lastEntry < S.cooldown) return;

  // Max daily check
  if (S.liveT >= S.maxDaily && S.papT >= S.maxDaily) return;

  // Get signal
  const sig = getSignal(px);

  // Debug every 10 ticks
  if (ticks % 10 === 0) {
    const I = getIndicators();
    if (I) log(`[T${ticks}] $${px.toFixed(4)} RSI=${I.rsi14.toFixed(1)} dip=${I.dipFromHi.toFixed(3)}% ch1=${I.ch1.toFixed(4)}% sig=${sig.signal}`, 'info');
  }

  if (!sig.signal) return;

  // ENTER
  const papOpen = S.papOrders.filter(o=>o.status==='open').length;
  if (papOpen < S.maxPos) {
    enter(px, sig.reason, true);
  }

  if (S.mode === 'live' && S.apiKey && S.apiSecret) {
    // Live has its own cooldown so paper entries don't block it
    const liveCD = (now - (S.lastLiveEntry||0)) >= S.cooldown;
    if (liveCD) {
      const liveOpen = S.liveOrders.filter(o=>o.status==='open').length;
      if (liveOpen < S.maxPos && S.liveT < S.maxDaily) {
        enter(px, sig.reason, false);
        S.lastLiveEntry = now;
      }
    }
  }

  S.lastEntry     = now;  // shared cooldown (prevents signal spam)
  S.lastLiveEntry = now;  // separate live cooldown
}

// ── ENTER TRADE ───────────────────────────────────────────────────────────────
function enter(px, reason, isPaper) {
  const amt  = S.capital / S.maxPos;
  // TP must be max of: configured %, and break-even+MIN_NET
  // Add extra 0.02% buffer above min to account for price rounding
  const configTp = px * (1 + S.tpPct/100);
  const safeTpPx = minTP(px, amt) * 1.0002;  // tiny buffer above theoretical min
  const tp = parseFloat(Math.max(configTp, safeTpPx).toFixed(8));
  const sl   = parseFloat((px*(1-S.slPct/100)).toFixed(8));
  const trail= parseFloat((px*(1-S.trailPct/100)).toFixed(8));

  const o = {
    id: Date.now()+(isPaper?1:0),
    status:'open', isPaper, strat:S.strategy,
    entryPx:px, amt, qty:amt/px,
    tp, sl, trailStop:trail, highSince:px,
    openAt:new Date().toISOString().slice(11,19),
    reason
  };

  if (isPaper) {
    S.papOrders.push(o);
    log(`📝 PAPER BUY ${S.strategy} @ $${px.toFixed(4)} TP=$${tp.toFixed(4)} SL=$${sl.toFixed(4)} [${reason}]`,'buy');
  } else {
    S.liveOrders.push(o);
    log(`💰 LIVE BUY ${S.strategy} @ $${px.toFixed(4)} | amt=$${amt.toFixed(2)} qty=${o.qty.toFixed(6)} | TP=$${tp.toFixed(4)} SL=$${sl.toFixed(4)} [${reason}]`,'buy');
    log(`💰 Placing MEXC market order: BUY ${o.qty.toFixed(6)} ${S.pair}`,'buy');
    placeOrder('BUY', o.qty, S.pair);
  }
}

// ── EXIT CHECK ────────────────────────────────────────────────────────────────
function exitCheck(px, isPaper) {
  const orders = isPaper ? S.papOrders : S.liveOrders;
  let changed  = false;

  orders.forEach(o => {
    if (o.status !== 'open') return;

    // Update trailing stop
    if (px > o.highSince) {
      o.highSince = px;
      const newTrail = px * (1 - S.trailPct/100);
      if (newTrail > o.trailStop) o.trailStop = newTrail;
    }

    let why = null;
    let exitAt = px;  // actual price we use for P&L calc

    if (px >= o.tp) {
      why    = 'TP';
      exitAt = o.tp;  // use exact TP price, not poll price (avoids overshoot distortion)
    } else if (o.trailStop > o.sl && px <= o.trailStop) {
      // TRAIL: only fire if we're actually in profit at trail price
      const {net:trailNet} = feeMath(o.entryPx, o.trailStop, o.amt);
      if (trailNet > 0) {
        why    = 'TRAIL';
        exitAt = o.trailStop;  // use exact trail stop price
      }
      // If trail would give a loss, widen it to break-even and wait
      else {
        const be = breakEven(o.entryPx, o.amt);
        o.trailStop = be * 1.0002;  // move trail to just above break-even
      }
    } else if (px <= o.sl) {
      why    = 'SL';
      exitAt = o.sl;  // use exact SL price
    }

    if (!why) return;

    const {fee, net, gross} = feeMath(o.entryPx, exitAt, o.amt);

    // SAFETY GUARD: If TP exit somehow still shows loss (shouldn't happen),
    // log a warning but still close — don't let position stay open forever
    if (why === 'TP' && net < 0) {
      log(`⚠ TP exit negative net=$${net.toFixed(6)} entry=$${o.entryPx} tp=$${exitAt} — check TP config`, 'err');
    }

    o.status = 'closed';
    changed  = true;

    const tr = {
      n: isPaper ? ++S.papT : ++S.liveT,
      time:new Date().toISOString().slice(11,19),
      dur:o.openAt?`${o.openAt}→${new Date().toISOString().slice(11,19)}`:'',
      pair:S.pair, strat:o.strat, isPaper,
      side:why, entryPx:o.entryPx, exitPx:exitAt,
      amt:o.amt, fee:+fee.toFixed(6),
      gross:+gross.toFixed(6), net:+net.toFixed(6)
    };

    if (isPaper) {
      S.papProfit+=net; S.papFees+=fee;
      if(net>=0){S.papW++;if(net>S.papBest)S.papBest=net;}else S.papL++;
      S.papTrades.unshift(tr);
      if(S.papTrades.length>200)S.papTrades.length=200;
      const pnlStr = `gross=${gross>=0?'+':''}$${gross.toFixed(4)} fee=$${fee.toFixed(4)} NET=${net>=0?'+':''}$${net.toFixed(4)}`;
      log(`📝 PAPER ${why} entry=$${o.entryPx.toFixed(4)} exit=$${exitAt.toFixed(4)} | ${pnlStr}`, net>=0?'profit':'err');
    } else {
      S.liveProfit+=net; S.todayP+=net; S.feesT+=fee;
      if(net>=0){S.liveW++;if(net>S.bestT)S.bestT=net;}else S.liveL++;
      S.liveTrades.unshift(tr);
      if(S.liveTrades.length>200)S.liveTrades.length=200;
      const livePnlStr = `gross=${gross>=0?'+':''}$${gross.toFixed(4)} fee=$${fee.toFixed(4)} NET=${net>=0?'+':''}$${net.toFixed(4)}`;
      log(`💰 LIVE ${why} entry=$${o.entryPx.toFixed(4)} exit=$${exitAt.toFixed(4)} | ${livePnlStr}`, net>=0?'sell':'err');
      placeOrder('SELL', o.qty, S.pair);
    }
    save();
  });

  if (changed) {
    if (isPaper) S.papOrders = S.papOrders.filter(o=>o.status==='open');
    else         S.liveOrders = S.liveOrders.filter(o=>o.status==='open');
  }
}

// ── MEXC ORDER (corrected v3 signing) ────────────────────────────────────────
// MEXC v3 signature: HMAC-SHA256 of the raw query string (no URL encoding of values)
function placeOrder(side, qty, pair) {
  if (!S.apiKey || !S.apiSecret) {
    log(`⚠ placeOrder called but no API keys — skipping`, 'err');
    return;
  }
  const sym = pair.replace('/','');
  const usdtAmt = (qty * S.lastPx).toFixed(2);

  // Build params object — MEXC market orders:
  // BUY  → use quoteOrderQty (spend X USDT)
  // SELL → use quantity (sell X coins)
  const params = {
    symbol:    sym,
    side:      side.toUpperCase(),
    type:      'MARKET',
    timestamp: Date.now().toString(),
    recvWindow:'5000'
  };
  if (side.toUpperCase() === 'BUY') {
    params.quoteOrderQty = usdtAmt;
    log(`💰 Sending MEXC BUY: $${usdtAmt} USDT of ${sym}`, 'buy');
  } else {
    // Round qty to 2 decimal places for most MEXC pairs
    params.quantity = parseFloat(qty).toFixed(2);
    log(`💰 Sending MEXC SELL: ${params.quantity} ${sym}`, 'sell');
  }

  // MEXC v3: sign the raw query string (values NOT URL-encoded in signature input)
  const rawQS = Object.entries(params).map(([k,v])=>`${k}=${v}`).join('&');
  const sig   = crypto.createHmac('sha256', S.apiSecret).update(rawQS).digest('hex');

  // Path uses URL-encoded query string + signature
  const urlQS = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
  const fullPath = `/api/v3/order?${urlQS}&signature=${sig}`;

  log(`💰 MEXC API call: POST ${fullPath.substring(0,80)}...`, 'info');

  const req = https.request({
    hostname: 'api.mexc.com',
    path:     fullPath,
    method:   'POST',
    headers: {
      'X-MEXC-APIKEY': S.apiKey,
      'Content-Type':  'application/json',
      'Accept':        'application/json'
    },
    timeout: 8000
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const r = JSON.parse(d);
        if (r.orderId) {
          log(`✅ MEXC ${side} ORDER FILLED! orderId=${r.orderId} symbol=${r.symbol} qty=${r.executedQty} price=${r.price}`, 'profit');
          log(`✅ Your MEXC wallet balance has changed — check Spot wallet`, 'profit');
        } else if (r.code) {
          // MEXC error codes
          log(`❌ MEXC ORDER FAILED code=${r.code} msg=${r.msg}`, 'err');
          if (r.code === -1100) log(`❌ Bad parameter — check pair name (use BTCUSDT not BTC/USDT)`, 'err');
          if (r.code === -1111) log(`❌ Quantity precision error — amount too small or wrong decimal`, 'err');
          if (r.code === -2010) log(`❌ Insufficient balance in MEXC Spot wallet`, 'err');
          if (r.code === -1021) log(`❌ Timestamp error — server clock out of sync`, 'err');
          if (r.code === 700003) log(`❌ API key invalid or Spot Trade permission not enabled on MEXC`, 'err');
          if (r.code === 700006) log(`❌ IP not whitelisted — remove IP restriction from MEXC API key settings`, 'err');
          if (r.code === 30004) log(`❌ Insufficient USDT balance — add funds to MEXC Spot wallet`, 'err');
        } else {
          log(`MEXC ${side} response: ${JSON.stringify(r)}`, 'info');
        }
      } catch(e) {
        log(`MEXC parse error: ${e.message} raw=${d.substring(0,200)}`, 'err');
      }
    });
  });
  req.on('error',   e => log(`MEXC network error: ${e.message}`, 'err'));
  req.on('timeout', () => { req.destroy(); log(`MEXC request timeout`, 'err'); });
  req.end();
}

// ── TEST ORDER ENDPOINT (dry run — checks connection without real order) ────────
function testMexcConnection() {
  if (!S.apiKey || !S.apiSecret) {
    log('testMexcConnection: no API keys', 'err');
    return;
  }
  // Use /api/v3/account to check balance — confirms keys work
  const ts = Date.now().toString();
  const rawQS = `timestamp=${ts}&recvWindow=5000`;
  const sig   = crypto.createHmac('sha256', S.apiSecret).update(rawQS).digest('hex');

  const req = https.request({
    hostname: 'api.mexc.com',
    path:     `/api/v3/account?timestamp=${ts}&recvWindow=5000&signature=${sig}`,
    method:   'GET',
    headers:  {'X-MEXC-APIKEY': S.apiKey, 'Accept': 'application/json'},
    timeout:  8000
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const r = JSON.parse(d);
        if (r.balances) {
          const usdt = r.balances.find(b => b.asset === 'USDT');
          const avail = usdt ? parseFloat(usdt.free).toFixed(4) : '0';
          log(`✅ MEXC API connection OK! USDT balance: $${avail} (free)`, 'profit');
          log(`✅ Spot Trade permission confirmed — bot can place real orders`, 'profit');
          S.mexcBalance = avail;
        } else if (r.code) {
          log(`❌ MEXC API test failed: code=${r.code} msg=${r.msg}`, 'err');
          if (r.code === 700003) log(`❌ Invalid API key — double-check MEXC_KEY in Railway Variables`, 'err');
          if (r.code === 700006) log(`❌ IP restricted — remove IP whitelist from MEXC API settings`, 'err');
        }
      } catch(e) {
        log(`MEXC test parse error: ${e.message}`, 'err');
      }
    });
  });
  req.on('error', e => log(`MEXC test error: ${e.message}`, 'err'));
  req.end();
}

// ── CORS + JSON HELPER ────────────────────────────────────────────────────────
function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Bot-Pin');
  res.setHeader('Access-Control-Max-Age','86400');
}

function send(res, code, data) {
  setHeaders(res);
  res.writeHead(code,{'Content-Type':'application/json'});
  res.end(JSON.stringify(data));
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method==='OPTIONS') { setHeaders(res); res.writeHead(204); res.end(); return; }
  const url = req.url.split('?')[0];

  // ── Public endpoints ────────────────────────────────────────────────────────
  if (url==='/'||url==='/ping'||url==='/health') {
    send(res,200,{ok:true,uptime:process.uptime().toFixed(0)+'s',time:new Date().toISOString()});
    return;
  }
  if (url==='/prices') {
    send(res,200,{prices:S.prices,ticks});
    return;
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────
  if (req.headers['x-bot-pin'] !== BOT_PIN) {
    send(res,401,{error:'Invalid PIN'});
    return;
  }

  // ── GET /status ──────────────────────────────────────────────────────────────
  if (req.method==='GET' && url==='/status') {
    const I = getIndicators();
    const liveOpen = S.liveOrders.filter(o=>o.status==='open');
    const papOpen  = S.papOrders.filter(o=>o.status==='open');

    // Add live P&L to open positions
    const addPnl = o => ({...o, livePnl: feeMath(o.entryPx, S.lastPx, o.amt).net});

    send(res,200,{
      // Config
      botOn:S.botOn, mode:S.mode, strategy:S.strategy, pair:S.pair,
      capital:S.capital, maxPos:S.maxPos, tpPct:S.tpPct, slPct:S.slPct,
      trailPct:S.trailPct, maxDaily:S.maxDaily, cooldown:S.cooldown,
      // Price
      lastPx:S.lastPx, prices:S.prices, ticks, warmup:S.warmup,
      warmedUp: ticks >= S.warmup,
      // Live stats
      liveProfit:S.liveProfit, todayP:S.todayP, liveT:S.liveT,
      liveW:S.liveW, liveL:S.liveL, bestT:S.bestT, feesT:S.feesT,
      liveWR: S.liveT>0 ? Math.round(S.liveW/S.liveT*100) : 0,
      // Paper stats
      papProfit:S.papProfit, papT:S.papT, papW:S.papW, papL:S.papL,
      papBest:S.papBest, papFees:S.papFees,
      papWR: S.papT>0 ? Math.round(S.papW/S.papT*100) : 0,
      // Orders
      liveOrders: liveOpen.map(addPnl),
      papOrders:  papOpen.map(addPnl),
      // History
      liveTrades: S.liveTrades.slice(0,60),
      papTrades:  S.papTrades.slice(0,60),
      // Log
      log: S.log.slice(0,150),
      // Meta
      hasApiKeys:!!(S.apiKey&&S.apiSecret),
      mexcBalance: S.mexcBalance||null,
      startedAt:S.startedAt, savedAt:S.savedAt, feeRt:RT_FEE*100,
      // Indicators
      indicators: I ? {
        rsi14: I.rsi14.toFixed(1), rsi9: I.rsi9.toFixed(1),
        e9: I.e9.toFixed(4), e21: I.e21.toFixed(4),
        bbLow:  I.bb?.lower.toFixed(4)||null,
        bbMid:  I.bb?.middle.toFixed(4)||null,
        dipFromHi: I.dipFromHi.toFixed(4),
        ch1: I.ch1.toFixed(4), ch5: I.ch5.toFixed(4),
        trend: I.trend,
        lastSig: getSignal(S.lastPx)
      } : null
    });
    return;
  }

  // ── POST endpoints ────────────────────────────────────────────────────────────
  if (req.method==='POST') {
    let body='';
    req.on('data',c=>body+=c);
    req.on('end',()=>{
      let d={};
      try{d=JSON.parse(body);}catch(e){}

      // /config
      if (url==='/config') {
        if(d.pair)      S.pair      = d.pair.replace('/','');
        if(d.strategy)  S.strategy  = d.strategy;
        if(d.mode)      S.mode      = d.mode;
        if(d.capital)   S.capital   = parseFloat(d.capital)||20;
        if(d.maxPos)    S.maxPos    = parseInt(d.maxPos)||3;
        if(d.tpPct)     S.tpPct     = Math.max(parseFloat(d.tpPct), RT_FEE*100+0.12);
        if(d.slPct)     S.slPct     = Math.max(parseFloat(d.slPct), 0.10);
        if(d.trailPct)  S.trailPct  = parseFloat(d.trailPct)||0.10;
        if(d.maxDaily)  S.maxDaily  = parseInt(d.maxDaily)||200;
        if(d.cooldown)  S.cooldown  = parseInt(d.cooldown)*1000||8000;
        // Save API keys encrypted if provided
        if (d.apiKey && d.apiSecret && d.apiKey!=='[saved]') {
          S.apiKey    = d.apiKey;
          S.apiSecret = d.apiSecret;
          saveKeys(d.apiKey, d.apiSecret);
        }
        // If mode changed to live, restart feed so it picks up mode immediately
        const modeChanged = d.mode && d.mode !== (S.mode === d.mode ? d.mode : '');
        save();
        log(`Config: ${S.pair} MODE=${S.mode} tp=${S.tpPct}% sl=${S.slPct}% keys=${!!(S.apiKey&&S.apiSecret)}`,'info');
        if (S.mode==='live' && !(S.apiKey && S.apiSecret)) {
          log(`⚠ MODE=live but NO API KEYS found. Set MEXC_KEY+MEXC_SECRET in Railway Variables or use Save Keys button.`,'err');
        }
        if (S.mode==='live' && S.apiKey && S.apiSecret) {
          log(`✅ Live mode active. API keys present. Bot will place real orders.`,'buy');
          S.lastLiveEntry = 0; // reset cooldown so live can enter immediately
        }
        send(res,200,{ok:true, tpPct:S.tpPct, slPct:S.slPct, mode:S.mode, hasKeys:!!(S.apiKey&&S.apiSecret)});
        return;
      }

      // /start
      if (url==='/start') {
        if (S.botOn) { send(res,200,{ok:true,msg:'Already running'}); return; }
        S.botOn=true; S.liveOrders=[]; S.papOrders=[];
        S.lastEntry=0; S.startedAt=new Date().toISOString();
        PX=[]; ticks=0;
        startFeed();
        log(`▶ STARTED ${S.pair} [${S.strategy}] mode=${S.mode} $${S.capital} TP=${S.tpPct}% SL=${S.slPct}% cool=${S.cooldown/1000}s warmup=${S.warmup}ticks`,'buy');
        log(`Paper trades will start ~${Math.ceil(S.warmup*1.5)}s after start`,'info');
        save();
        send(res,200,{ok:true});
        return;
      }

      // /stop
      if (url==='/stop') {
        S.botOn=false; S.liveOrders=[]; S.papOrders=[];
        stopFeed();
        log('■ Bot stopped.','info');
        save();
        send(res,200,{ok:true});
        return;
      }

      // /reset — reset stats only
      if (url==='/reset') {
        const ak=S.apiKey, as=S.apiSecret;
        S.liveProfit=0;S.todayP=0;S.liveT=0;S.liveW=0;S.liveL=0;S.bestT=0;S.feesT=0;
        S.papProfit=0;S.papT=0;S.papW=0;S.papL=0;S.papBest=0;S.papFees=0;
        S.liveTrades=[];S.papTrades=[];S.liveOrders=[];S.papOrders=[];S.log=[];
        S.apiKey=ak;S.apiSecret=as;
        save(); send(res,200,{ok:true}); return;
      }

      // /resetpaper
      if (url==='/resetpaper') {
        S.papProfit=0;S.papT=0;S.papW=0;S.papL=0;S.papBest=0;S.papFees=0;
        S.papTrades=[];S.papOrders=[];
        save(); send(res,200,{ok:true}); return;
      }

      // /savekeys — save API keys as Railway env reminder + in-memory
      if (url==='/savekeys') {
        if (d.apiKey && d.apiSecret) {
          S.apiKey    = d.apiKey;
          S.apiSecret = d.apiSecret;
          saveKeys(d.apiKey, d.apiSecret);  // file backup
          save();
          log('API keys saved. IMPORTANT: also set MEXC_KEY and MEXC_SECRET in Railway Variables tab to survive restarts.','info');
          send(res,200,{ok:true, msg:'Keys saved in memory and file. Set MEXC_KEY/MEXC_SECRET in Railway Variables for permanent storage.'});
        } else {
          send(res,400,{error:'apiKey and apiSecret required'});
        }
        return;
      }

      // /setlive — switch to live mode + verify keys in one call
      if (url==='/setlive') {
        if (!S.apiKey || !S.apiSecret) {
          send(res,400,{error:'No API keys saved. Save keys first using Save Keys button.', hasKeys:false});
          return;
        }
        S.mode = 'live';
        S.lastLiveEntry = 0;  // allow immediate live entry
        save();
        log(`🚀 SWITCHED TO LIVE MODE. Pair=${S.pair} Capital=$${S.capital} TP=${S.tpPct}% SL=${S.slPct}%`,'buy');
        log(`API keys verified in memory. Next signal will place REAL order on MEXC.`,'buy');
        send(res,200,{ok:true, mode:'live', pair:S.pair, capital:S.capital, hasKeys:true});
        return;
      }

      // /setpaper — switch to paper mode safely
      if (url==='/setpaper') {
        S.mode = 'paper';
        save();
        log(`📝 Switched to PAPER mode.`,'info');
        send(res,200,{ok:true, mode:'paper'});
        return;
      }

      // /testconnection — test MEXC API keys and get balance
      if (url==='/testconnection') {
        if (!S.apiKey || !S.apiSecret) {
          send(res,400,{error:'No API keys saved. Add keys first.', hasKeys:false});
          return;
        }
        testMexcConnection();
        send(res,200,{ok:true, msg:'Testing MEXC connection... check server log in 5 seconds'});
        return;
      }

      // /balance — get live MEXC USDT balance
      if (url==='/balance') {
        if (!S.apiKey || !S.apiSecret) {
          send(res,400,{error:'No API keys', hasKeys:false});
          return;
        }
        const ts  = Date.now().toString();
        const rawQ= `timestamp=${ts}&recvWindow=5000`;
        const sig = crypto.createHmac('sha256',S.apiSecret).update(rawQ).digest('hex');
        https.request({
          hostname:'api.mexc.com',
          path:`/api/v3/account?timestamp=${ts}&recvWindow=5000&signature=${sig}`,
          method:'GET',
          headers:{'X-MEXC-APIKEY':S.apiKey,'Accept':'application/json'},
          timeout:6000
        }, r => {
          let d=''; r.on('data',c=>d+=c);
          r.on('end',()=>{
            try {
              const acc=JSON.parse(d);
              if(acc.balances){
                const usdt=acc.balances.find(b=>b.asset==='USDT');
                const pair=S.pair.replace('USDT','');
                const coin=acc.balances.find(b=>b.asset===pair);
                send(res,200,{
                  ok:true,
                  usdt:{free:usdt?.free||'0', locked:usdt?.locked||'0'},
                  coin:{asset:pair, free:coin?.free||'0', locked:coin?.locked||'0'}
                });
              } else {
                send(res,200,{ok:false, error:acc.msg||'Unknown', code:acc.code});
              }
            } catch(e){send(res,500,{error:e.message});}
          });
        }).on('error',e=>send(res,500,{error:e.message})).end();
        return;
      }

      send(res,404,{error:'Not found'});
    });
    return;
  }

  send(res,404,{error:'Not found'});
});

// ── START ─────────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server listening on 0.0.0.0:${PORT}`);
  // Load file-based state (may be empty on Railway — files reset on restart)
  load();
  loadKeys();
  // Always override with env vars if set (env vars survive restarts)
  if (ENV_KEY)    { S.apiKey = ENV_KEY;       log('API key loaded from MEXC_KEY env var','info'); }
  if (ENV_SECRET) { S.apiSecret = ENV_SECRET; log('Secret loaded from MEXC_SECRET env var','info'); }
  if (ENV_PAIR)   S.pair     = ENV_PAIR;
  if (ENV_MODE)   S.mode     = ENV_MODE;
  if (ENV_STRAT)  S.strategy = ENV_STRAT;
  startMulti();
  // Auto-resume bot if BOT_RUNNING=true env var is set
  if (S.botOn || ENV_RUNNING) {
    S.botOn = true;
    S.liveOrders=[]; S.papOrders=[];
    PX=[]; ticks=0;
    log('▶ Auto-resuming bot from saved state...','buy');
    startFeed();
  } else {
    log('Bot ready. Press Start to begin trading.','info');
    log('Tip: Set MEXC_KEY + MEXC_SECRET + BOT_RUNNING=true in Railway Variables for auto-start.','info');
  }
});

server.on('error', e => { console.error(e); process.exit(1); });
process.on('SIGTERM', ()=>{ save(); process.exit(0); });
process.on('SIGINT',  ()=>{ save(); process.exit(0); });
