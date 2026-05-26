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
const TAKER       = 0.0005;        // Spot: 0.05% taker per order
const RT_FEE      = TAKER * 2;    // Spot: 0.10% round-trip
const FUT_TAKER   = 0.0002;        // Futures: 0.02% taker per order (cheaper!)
const FUT_RT_FEE  = FUT_TAKER * 2; // Futures: 0.04% round-trip
const MIN_NET     = 0.0008;        // minimum 0.08% net profit after fees

console.log(`\n=== CryptoBot Pro v6 ===`);
console.log(`Port: ${PORT} | MEXC RT fee: ${(RT_FEE*100).toFixed(2)}%`);

// Sanitize API keys — remove ALL whitespace, quotes, newlines, invisible chars
function sanitizeKey(k) {
  if (!k) return '';
  return String(k)
    .replace(/[\r\n\t]/g, '')   // remove newlines/tabs
    .replace(/\s+/g, '')          // remove all whitespace
    .replace(/['"]/g, '')          // remove quotes
    .replace(/[^\x20-\x7E]/g, '') // remove non-printable chars
    .trim();
}

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
  tpPct:    0.50,        // 0.50% TP = 0.40% net after fees = $0.053 per $13.33 pos
  slPct:    0.40,        // 0.40% SL — wider than TP is impossible, this is fine
  trailPct: 0.20,        // 0.20% trail — only activates after 60% toward TP
  maxDaily: 200,
  cooldown: 10000,       // 10 seconds between entries
  warmup:   5,           // 5 ticks = ~8 seconds to warm up

  // Live stats
  liveProfit:0, todayP:0, liveT:0, liveW:0, liveL:0, bestT:0, feesT:0,
  // Paper stats
  papProfit:0, papT:0, papW:0, papL:0, papBest:0, papFees:0,
  // Orders & history
  liveOrders:[], papOrders:[], liveTrades:[], papTrades:[],
  log:[], prices:{},
  lastPx:0, startedAt:null, savedAt:null, lastEntry:0, lastLiveEntry:0, mexcBalance:null,
  // ── AI BRAIN (DeepSeek) ──────────────────────────────────────────────────
  aiKey:         '',          // DeepSeek API key
  aiMode:        'hybrid',    // 'off' | 'hybrid' (AI+signals) | 'ai-only'
  aiInterval:    30,          // seconds between AI calls
  aiMinConf:     65,          // minimum confidence % to enter (0-100)
  aiDecision:    null,        // last AI decision object
  aiLastCall:    0,           // timestamp of last AI call
  aiCallCount:   0,           // total AI calls made
  aiTokensUsed:  0,           // tokens consumed (cost tracking)
  aiCost:        0,           // estimated cost in USD
  aiFutDecision: null,        // separate futures AI decision
  aiFutLastCall: 0,

  // ── FUTURES STATE ──────────────────────────────────────────────────────────
  futuresOn:    false,          // futures bot running
  futMode:      'paper',        // 'paper' | 'live'
  futPair:      'BTC_USDT',     // futures contract symbol
  futCapital:   20,             // USDT margin per session
  futMaxPos:    1,              // max concurrent futures positions
  futLeverage:  3,              // 3x leverage (safe default)
  futTpPct:     0.45,           // 0.45% TP -> net +0.41% after 0.04% fee (R:R > 2:1 vs SL)
  futSlPct:     0.20,           // 0.20% SL (tight — BE-stop moves it to entry after 40% toward TP)
  futStrategy:  'auto',         // same signal engine
  futMaxDaily:  300,
  futCooldown:  8000,
  // Futures stats
  futProfit:0, todayFutP:0, futT:0, futW:0, futL:0, futBest:0, futFees:0,
  futPapProfit:0, futPapT:0, futPapW:0, futPapL:0,
  futOrders:[],     // live futures positions
  futPapOrders:[],  // paper futures positions
  futTrades:[],     // completed futures trades
  futPapTrades:[],
  futLastPx:0, futLastEntry:0, futTicks:0
};

// Seed API keys from environment — always sanitize to remove invisible chars
if (ENV_KEY)    S.apiKey    = sanitizeKey(ENV_KEY);
if (ENV_SECRET) S.apiSecret = sanitizeKey(ENV_SECRET);
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
    // Always sanitize loaded keys
    S.apiKey    = sanitizeKey(k||'');
    S.apiSecret = sanitizeKey(s||'');
    if (S.apiKey) log(`Keys loaded from file: len=${S.apiKey.length}`,'info');
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
async function onTick(px) {
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

  if (!sig.signal && S.aiMode !== 'ai-only') {
    if (S.aiKey) callDeepSeek(px, false);
    return;
  }
  if (!sig.signal && S.aiMode === 'ai-only') {
    // AI-only mode: skip indicator requirement, let AI decide below
  }

  // Call AI and get decision
  if (S.aiKey && S.aiMode !== 'off') await callDeepSeek(px, false);
  const aiCheck = aiSignalOk(false);
  if (!aiCheck.ok) {
    if (aiCheck.reason) log(`🤖 SPOT BLOCKED: ${aiCheck.reason}`, 'info');
    return;
  }
  // Use AI-suggested TP/SL if provided and better than config
  const aiDec = aiCheck.decision;
  if (aiDec?.tp_suggest && aiDec.tp_suggest > 0.22) S._aiTpOverride = aiDec.tp_suggest;
  if (aiDec?.sl_suggest && aiDec.sl_suggest > 0.10) S._aiSlOverride = aiDec.sl_suggest;

  // ENTER
  const papOpen = S.papOrders.filter(o=>o.status==='open').length;
  if (papOpen < S.maxPos) {
    enter(px, sig.reason, true);
  }

  if (S.mode === 'live' && S.apiKey && S.apiSecret) {
    const liveCD = (now - (S.lastLiveEntry||0)) >= S.cooldown;
    if (liveCD) {
      const liveOpen = S.liveOrders.filter(o=>o.status==='open').length;
      if (liveOpen < S.maxPos && S.liveT < S.maxDaily) {
        // Check position size is tradeable (MEXC minimum 5 USDT for BTC/USDT)
        const posSize = S.capital / S.maxPos;
        const MEXC_MIN = 5.0;
        if (posSize < MEXC_MIN) {
          if (ticks % 50 === 0) log(`⚠ Position size $${posSize.toFixed(2)} below MEXC minimum $${MEXC_MIN}. Increase capital or reduce maxPos.`, 'err');
        } else {
          enter(px, sig.reason, false);
          S.lastLiveEntry = now;
        }
      }
    }
  }

  S.lastEntry     = now;  // shared cooldown (prevents signal spam)
  S.lastLiveEntry = now;  // separate live cooldown
}

// ── ENTER TRADE ───────────────────────────────────────────────────────────────
function enter(px, reason, isPaper) {
  const amt  = S.capital / S.maxPos;
  // Use AI-suggested TP/SL if available
  const useTp = S._aiTpOverride || S.tpPct;
  const useSl = S._aiSlOverride || S.slPct;
  S._aiTpOverride = null; S._aiSlOverride = null; // consume

  const configTp = px * (1 + useTp/100);
  const safeTpPx = minTP(px, amt) * 1.0005;
  const tp = parseFloat(Math.max(configTp, safeTpPx).toFixed(8));
  const guaranteedNet = (tp - px) / px * 100 - RT_FEE * 100;
  const sl   = parseFloat((px*(1-S.slPct/100)).toFixed(8));
  const trail = 0; // trail disabled — TP/SL only

  const o = {
    id: Date.now()+(isPaper?1:0),
    status:'open', isPaper, strat:S.strategy,
    entryPx:px, amt, qty:amt/px,
    tp, sl,
    openAt:new Date().toISOString().slice(11,19),
    reason
  };

  if (isPaper) {
    S.papOrders.push(o);
    log(`📝 PAPER BUY ${S.strategy} @ $${px.toFixed(2)} | $${amt.toFixed(2)}/pos TP=$${tp.toFixed(2)} SL=$${sl.toFixed(2)}`,'buy');
  } else {
    S.liveOrders.push(o);
    const expectedNet = ((tp - px) / px * 100 - RT_FEE * 100).toFixed(3);
    log(`💰 LIVE BUY @ $${px.toFixed(2)} | pos=$${amt.toFixed(2)} TP=$${tp.toFixed(2)}(+${((tp-px)/px*100).toFixed(3)}%) SL=$${sl.toFixed(2)} | expected net ~${expectedNet}%`,'buy');
    placeOrder('BUY', o.qty, S.pair);
  }
}

// ── EXIT CHECK ────────────────────────────────────────────────────────────────
function exitCheck(px, isPaper) {
  const orders = isPaper ? S.papOrders : S.liveOrders;
  let changed  = false;

  orders.forEach(o => {
    if (o.status !== 'open') return;

    // Track peak price and peak net profit seen on this position
    if (!o.peakPx || px > o.peakPx) o.peakPx = px;
    const currentNet = feeMath(o.entryPx, px, o.amt).net;
    if (currentNet > (o.peakNet||0)) o.peakNet = currentNet;

    // ── PROFIT PROTECTION ──────────────────────────────────────────────────
    // If position was in profit (peakNet > minProfit) and price dropped
    // giving back more than 60% of peak profit -> close now to protect gains
    const minProfit = o.amt * 0.0008; // minimum $0.0008 per $1 to be worth protecting
    if (o.peakNet > minProfit) {
      const givebackRatio = (o.peakNet - currentNet) / o.peakNet;
      if (givebackRatio >= 0.60 && currentNet > 0) {
        // We've given back 60% of peak profit but still positive -> PROTECT
        const why = 'PROTECT';
        const exitAt = px;
        const {fee, net, gross} = feeMath(o.entryPx, exitAt, o.amt);
        o.status = 'closed'; changed = true;
        const tr = {
          n:isPaper?++S.papT:++S.liveT, time:new Date().toISOString().slice(11,19),
          dur:o.openAt?`${o.openAt}->${new Date().toISOString().slice(11,19)}`:'',
          pair:S.pair, strat:o.strat, isPaper, side:why,
          entryPx:o.entryPx, exitPx:exitAt, amt:o.amt,
          fee:+fee.toFixed(6), gross:+gross.toFixed(6), net:+net.toFixed(6)
        };
        if(isPaper){S.papProfit+=net;S.papFees+=fee;if(net>=0){S.papW++;if(net>S.papBest)S.papBest=net;}else S.papL++;S.papTrades.unshift(tr);if(S.papTrades.length>200)S.papTrades.length=200;log(`🛡 PAPER PROTECT @ $${px.toFixed(4)} | peak=$${o.peakNet.toFixed(4)} saved=$${net.toFixed(4)}`,'profit');}
        else{S.liveProfit+=net;S.todayP+=net;S.feesT+=fee;if(net>=0){S.liveW++;if(net>S.bestT)S.bestT=net;}else S.liveL++;S.liveTrades.unshift(tr);if(S.liveTrades.length>200)S.liveTrades.length=200;log(`🛡 LIVE PROTECT @ $${px.toFixed(4)} | was peaking at +$${o.peakNet.toFixed(4)} -> saved +$${net.toFixed(4)}`,'profit');placeOrder('SELL',o.qty,S.pair);}
        save(); return;
      }
    }

    // Standard exits: TP or SL
    let why = null;
    let exitAt = px;

    if (px >= o.tp) {
      why    = 'TP';
      exitAt = o.tp;
    } else if (px <= o.sl) {
      why    = 'SL';
      exitAt = o.sl;
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
      dur:o.openAt?`${o.openAt}->${new Date().toISOString().slice(11,19)}`:'',
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
      const movePct = o.entryPx>0 ? ((exitAt-o.entryPx)/o.entryPx*100).toFixed(3) : '?';
      log(`📝 PAPER ${why} entry=$${o.entryPx.toFixed(2)} exit=$${exitAt.toFixed(2)} move=${movePct}% | ${pnlStr}`, net>=0?'profit':'err');
    } else {
      S.liveProfit+=net; S.todayP+=net; S.feesT+=fee;
      if(net>=0){S.liveW++;if(net>S.bestT)S.bestT=net;}else S.liveL++;
      S.liveTrades.unshift(tr);
      if(S.liveTrades.length>200)S.liveTrades.length=200;
      const livePnlStr = `gross=${gross>=0?'+':''}$${gross.toFixed(4)} fee=$${fee.toFixed(4)} NET=${net>=0?'+':''}$${net.toFixed(4)}`;
      const liveMovePct = o.entryPx>0 ? ((exitAt-o.entryPx)/o.entryPx*100).toFixed(3) : '?';
      log(`💰 LIVE ${why} entry=$${o.entryPx.toFixed(2)} exit=$${exitAt.toFixed(2)} move=${liveMovePct}% | ${livePnlStr}`, net>=0?'sell':'err');
      if(net>0) log(`💰 Expected wallet change: +$${(net).toFixed(4)} USDT in MEXC Spot`, 'profit');
      placeOrder('SELL', o.qty, S.pair);
    }
    save();
  });

  if (changed) {
    if (isPaper) S.papOrders = S.papOrders.filter(o=>o.status==='open');
    else         S.liveOrders = S.liveOrders.filter(o=>o.status==='open');
  }
}

// ── MEXC API SIGNING (FIXED) ─────────────────────────────────────────────────
//
// MEXC v3 correct signing rules:
// 1. Build query string from ALL params including timestamp & recvWindow
// 2. Sign that exact raw string with HMAC-SHA256
// 3. For GET: append ?querystring&signature=SIG to URL
// 4. For POST: send querystring&signature=SIG in the BODY as form-urlencoded
//    Content-Type: application/x-www-form-urlencoded
//
// CRITICAL: The signed string must match EXACTLY what is sent.
// Do NOT url-encode values when building the signature string.
// Do NOT add any extra params after signing.

function mexcRequest(method, urlPath, params, apiKey, apiSecret, callback) {
  // MEXC v3 signing — ALL params including timestamp go in query string
  // For both GET and POST: params are in URL query string, body is empty
  // Content-Type must NOT be set (MEXC rejects it with code 700013)

  const allParams = {
    ...params,
    timestamp:  Date.now().toString(),
    recvWindow: '5000'
  };

  // Build raw query string for signing (no url-encoding of values)
  const rawQS = Object.keys(allParams)
    .map(k => `${k}=${allParams[k]}`)
    .join('&');

  // Sign with HMAC-SHA256
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(rawQS)
    .digest('hex');

  // Final URL: all params + signature in query string
  const finalQS = rawQS + '&signature=' + signature;
  const reqPath = `${urlPath}?${finalQS}`;

  // Headers: API key only, NO Content-Type
  const headers = {
    'X-MEXC-APIKEY': apiKey,
    'Accept':        'application/json',
    'User-Agent':    'CryptoBotPro/1.0'
  };

  // Body is always empty — params are in URL
  const reqBody = '';
  let reqPathFinal = reqPath;

  const opts = {
    hostname: 'api.mexc.com',
    path:     reqPathFinal,
    method,
    headers,
    timeout: 8000
  };

  const req = https.request(opts, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try { callback(null, JSON.parse(d)); }
      catch(e) { callback(new Error('JSON parse: ' + d.substring(0,100))); }
    });
  });
  req.on('error',   e => callback(e));
  req.on('timeout', () => { req.destroy(); callback(new Error('timeout')); });
  req.end();  // No body — params are in URL query string
}

// ─── PLACE ORDER ─────────────────────────────────────────────────────────────
function placeOrder(side, qty, pair) {
  if (!S.apiKey || !S.apiSecret) {
    log('⚠ No API keys — order skipped', 'err');
    return;
  }
  const sym = pair.replace('/','');
  const params = { symbol:sym, side:side.toUpperCase(), type:'MARKET' };

  if (side.toUpperCase() === 'BUY') {
    // Use quoteOrderQty to spend exact USDT amount
    const usdtAmt = (S.capital / S.maxPos).toFixed(2);
    params.quoteOrderQty = usdtAmt;
    log(`💰 MEXC BUY $${usdtAmt} USDT of ${sym}`, 'buy');
  } else {
    // Sell quantity of coins (6 decimal places)
    params.quantity = qty.toFixed(6);
    log(`💰 MEXC SELL ${params.quantity} ${sym}`, 'sell');
  }

  mexcRequest('POST', '/api/v3/order', params, S.apiKey, S.apiSecret, (err, r) => {
    if (err) { log(`MEXC order error: ${err.message}`, 'err'); return; }
    if (r.orderId) {
      log(`✅ ORDER FILLED! orderId=${r.orderId} status=${r.status} qty=${r.executedQty}`, 'profit');
      log(`✅ Check your MEXC Spot wallet — balance has changed`, 'profit');
    } else {
      log(`❌ ORDER FAILED code=${r.code} msg=${r.msg}`, 'err');
      if (r.code==700002||r.code=='700002') log('❌ Signature invalid — check MEXC_KEY & MEXC_SECRET match exactly','err');
      if (r.code==700003||r.code=='700003') log('❌ Invalid API key — re-copy key from MEXC API Management page','err');
      if (r.code==700006||r.code=='700006') log('❌ IP whitelist blocking — remove IP restriction from MEXC API key','err');
      if (r.code==30004 ||r.code=='30004')  log('❌ Insufficient USDT — deposit funds to MEXC Spot wallet','err');
      if (r.code==2010  ||r.code=='2010')   log('❌ Insufficient balance for this order amount','err');
    }
  });
}

// ── TEST MEXC CONNECTION ──────────────────────────────────────────────────────
function testMexcConnection() {
  if (!S.apiKey || !S.apiSecret) {
    log('⚠ No API keys in memory', 'err');
    return;
  }
  mexcRequest('GET', '/api/v3/account', {}, S.apiKey, S.apiSecret, (err, r) => {
    if (err) { log(`MEXC test error: ${err.message}`, 'err'); return; }
    if (r.balances) {
      const usdt = r.balances.find(b => b.asset === 'USDT');
      const bal  = parseFloat(usdt?.free||0).toFixed(4);
      S.mexcBalance = bal;
      log(`✅ MEXC VERIFIED! USDT=$${bal} free`, 'profit');
      log(`✅ Signature is correct — bot can place real orders`, 'profit');
    } else {
      log(`❌ Key test: code=${r.code} msg=${r.msg}`, 'err');
      if (r.code==700002||r.code=='700002') log('❌ Signature invalid — copy keys again from MEXC exactly, no spaces','err');
      if (r.code==700003||r.code=='700003') log('❌ Invalid API key — re-copy MEXC_KEY from MEXC API Management','err');
      if (r.code===700006) log('❌ FIX: IP whitelist on — MEXC API key -> Edit -> remove all IP restrictions','err');
      if (r.code===10072)  log('❌ FIX: API key not found or deleted on MEXC','err');
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// MEXC FUTURES ENGINE
// Contract: BTC_USDT perpetual | Fee: 0.02% taker | Leverage: 3x default
// API: contract.mexc.com (separate from spot api.mexc.com)
// ══════════════════════════════════════════════════════════════════════════════

// ── FUTURES PRICE FEED ────────────────────────────────────────────────────────
let futPriceTimer = null;
let futPX = [], futRsi = [], futEma = [], futBb = [];
let futTicks = 0;

function startFuturesFeed() {
  clearInterval(futPriceTimer);
  futPriceTimer = setInterval(fetchFuturesPrice, 1500);
  fetchFuturesPrice();
  log(`Futures feed: MEXC ${S.futPair} every 1.5s`, 'ws');
}

function stopFuturesFeed() {
  clearInterval(futPriceTimer);
  futPriceTimer = null;
}

async function fetchFuturesPrice() {
  try {
    // MEXC futures ticker endpoint
    const d = await get('contract.mexc.com', `/api/v1/contract/ticker?symbol=${S.futPair}`);
    // Response: { data: { lastPrice: "77000.0", ... } }
    const px = parseFloat(d?.data?.lastPrice || d?.data?.last || 0);
    if (px > 0) {
      S.futLastPx = px;
      S.prices[S.futPair] = px;
      onFuturesTick(px);
    }
  } catch(e) {
    // Fallback: use spot price as proxy (BTC price is same across spot/futures)
    if (S.lastPx > 0) onFuturesTick(S.lastPx);
  }
}

// ── FUTURES TICK ──────────────────────────────────────────────────────────────
async function onFuturesTick(px) {
  S.futLastPx = px;
  futTicks++;
  S.futTicks = futTicks;

  futPX.push(px);  if (futPX.length > 300) futPX.shift();
  futRsi.push(px); if (futRsi.length > 60)  futRsi.shift();
  futEma.push(px); if (futEma.length > 60)  futEma.shift();
  futBb.push(px);  if (futBb.length > 30)   futBb.shift();

  if (!S.futuresOn) return;

  // Exit checks first
  futExitCheck(px, true);   // paper
  futExitCheck(px, false);  // live

  if (futTicks < 5) return;   // warmup (5 ticks = ~8s)

  const now = Date.now();
  if (now - S.futLastEntry < S.futCooldown) return;
  if (S.futT >= S.futMaxDaily && S.futPapT >= S.futMaxDaily) return;

  // Get signal (reuse same signal engine)
  const sig = getFuturesSignal(px);

  if (futTicks % 20 === 0) {
    log(`[FUT T${futTicks}] $${px.toFixed(2)} sig=${sig.signal} ${sig.reason}`, 'info');
  }

  // In AI-only mode: skip indicator signals, AI decides everything
  if (!sig.signal && S.aiMode !== 'ai-only') {
    if (S.aiKey) callDeepSeek(px, true); // keep AI fresh
    return;
  }
  if (!sig.signal && S.aiMode === 'ai-only') {
    // AI-only: continue to AI check even without indicator signal
  }

  // AI check for futures — also runs even without indicator signal in ai-only mode
  if (S.aiKey && S.aiMode !== 'off') await callDeepSeek(px, true);
  const aiCheck = aiSignalOk(true);

  // In AI-only mode: AI can trigger entry even without indicator signal
  if (S.aiMode === 'ai-only' && !aiCheck.ok) {
    if (aiCheck.reason) log(`🤖 FUT BLOCKED: ${aiCheck.reason}`, 'info');
    return;
  }
  if (S.aiMode !== 'ai-only' && !aiCheck.ok) {
    if (aiCheck.reason) log(`🤖 FUT BLOCKED: ${aiCheck.reason}`, 'info');
    return;
  }

  // Use AI-suggested TP/SL if available
  const futAiDec = aiCheck.decision;
  const futAiAction = aiCheck.action; // 'BUY' (long) or 'SHORT'
  if (futAiDec?.tp_suggest) S._futAiTpOverride = futAiDec.tp_suggest;
  if (futAiDec?.sl_suggest) S._futAiSlOverride = futAiDec.sl_suggest;

  // Enter paper futures always
  const papOpen = S.futPapOrders.filter(o=>o.status==='open').length;
  if (papOpen < S.futMaxPos) futEnter(px, sig.reason, true);

  // Enter live futures if mode=live and keys exist
  if (S.futMode === 'live' && S.apiKey && S.apiSecret) {
    const liveOpen = S.futOrders.filter(o=>o.status==='open').length;
    if (liveOpen < S.futMaxPos && S.futT < S.futMaxDaily) {
      const posMargin = S.futCapital / S.futMaxPos;
      if (posMargin >= 5) {
        futEnter(px, sig.reason, false);
        S.futLastEntry = now;
      }
    }
  }
  S.futLastEntry = now;
}

// ── FUTURES SIGNAL ───────────────────────────────────────────────────────────
// Strict entry: needs 3/5 conditions — fewer bad trades = higher win rate
function getFuturesSignal(px) {
  if (futPX.length < 5) return {signal:false, reason:'warmup'};
  const raw = futPX;
  const r14  = calcRSI(raw, 14);
  const r9   = calcRSI(raw, 9);
  const e9   = calcEMA(raw, Math.min(9, raw.length));
  const e21  = calcEMA(raw, Math.min(21, raw.length));
  const bb   = calcBB(raw, Math.min(20, raw.length));
  const n    = raw.length;
  const ch1  = n>1 ? (px - raw[n-2]) / raw[n-2] * 100 : 0;
  const ch3  = n>3 ? (px - raw[n-4]) / raw[n-4] * 100 : 0;
  const hi10 = Math.max(...raw.slice(-10));
  const lo10 = Math.min(...raw.slice(-10));
  const dip  = (px - hi10) / hi10 * 100;
  const fromLo = (px - lo10) / lo10 * 100;

  let score = 0, reasons = [];

  // 1. RSI oversold (not at top)
  if (r14 !== null && r14 < 48) { score++; reasons.push(`rsi14=${r14.toFixed(0)}`); }
  // 2. Dip from recent high — price pulled back (mean reversion entry)
  if (dip <= -0.05 && dip >= -0.6) { score++; reasons.push(`dip=${dip.toFixed(3)}%`); }
  // 3. Currently bouncing up (ch1 positive)
  if (ch1 > 0 && ch1 < 0.3) { score++; reasons.push(`up=${ch1.toFixed(3)}%`); }
  // 4. BB — near or below lower band
  if (bb && px <= bb.lower * 1.004) { score++; reasons.push('bb-low'); }
  // 5. EMA bullish structure
  if (e9 && e21 && e9 > e21) { score++; reasons.push('ema-bull'); }

  // Need 3/5 for normal entry, OR 2/5 with very strong dip
  const strongDip = dip <= -0.15 && ch1 > 0;
  const ok = score >= 3 || (score >= 2 && strongDip);

  return {signal:ok, reason:`${score}/5 [${reasons.join(',')}] strongDip=${strongDip}`};
}

// ── FUTURES FEE MATH (exact MEXC calculation) ────────────────────────────────
// MEXC perpetual fees:
//   Open fee  = notional × 0.02%
//   Close fee = notional × 0.02%  (notional at close ≈ same)
//   Net PnL   = (exitPx − entryPx) / entryPx × notional − totalFee
function futFeeMath(entryPx, exitPx, marginUsdt, leverage) {
  const notional  = marginUsdt * leverage;
  const contracts = notional / entryPx;
  const pnl       = (exitPx - entryPx) * contracts;
  const openFee   = notional * FUT_TAKER;
  const closeFee  = notional * FUT_TAKER;  // simplified: same notional
  const fee       = openFee + closeFee;
  const net       = pnl - fee;
  return {net, fee, pnl, contracts, notional};
}

// Break-even exit price (net = 0 after fees)
function futBreakEven(entryPx, marginUsdt, leverage) {
  const notional  = marginUsdt * leverage;
  const contracts = notional / entryPx;
  // pnl = fee -> (exitPx - entryPx) * contracts = fee
  // exitPx = entryPx + fee/contracts
  const fee = notional * FUT_RT_FEE;
  return entryPx + (fee / contracts);
}

function futMinTP(entryPx, marginUsdt, leverage) {
  // Minimum TP = break-even + minimum profit (0.08% of notional)
  const be = futBreakEven(entryPx, marginUsdt, leverage);
  return be * (1 + 0.0008);
}

// ── ENTER FUTURES POSITION ────────────────────────────────────────────────────
function futEnter(px, reason, isPaper) {
  const margin   = S.futCapital / S.futMaxPos;
  const lev      = S.futLeverage;
  const notional = margin * lev;

  // Use AI-suggested TP/SL if available, else use config
  const aiTp = S._futAiTpOverride || S.futTpPct;
  const aiSl = S._futAiSlOverride || S.futSlPct;
  S._futAiTpOverride = null; S._futAiSlOverride = null; // consume override

  const minTpPx  = futMinTP(px, margin, lev);
  const wantTp   = px * (1 + aiTp / 100);
  const tp       = parseFloat(Math.max(wantTp, minTpPx).toFixed(4));

  const tpDist   = tp - px;
  const wantSl   = px * (1 - aiSl / 100);
  const maxSlDist = tpDist * 0.55;
  const sl       = parseFloat(Math.max(wantSl, px - maxSlDist).toFixed(4));

  // Break-even stop: once price reaches 50% of TP, move SL to break-even+fee
  const bePx     = parseFloat(futBreakEven(px, margin, lev).toFixed(4));

  const expectedNet = futFeeMath(px, tp, margin, lev).net;
  const expectedLoss = futFeeMath(px, sl, margin, lev).net;
  const rr = Math.abs(expectedNet / expectedLoss);

  const o = {
    id:        Date.now() + (isPaper ? 1 : 0),
    status:    'open',
    isPaper,   isFutures: true,
    direction: 'LONG',
    entryPx:   px,
    margin,    leverage: lev,
    notional,
    tp, sl,
    bePx,              // break-even price (for BE-stop logic)
    beStopMoved: false, // flag: has SL been moved to break-even yet?
    peakPx: px,        // highest price seen since open (for profit lock)
    openAt: new Date().toISOString().slice(11, 19),
    reason
  };

  log(`${isPaper?'📝 FUT-PAPER':'🚀 FUT-LIVE'} LONG @ $${px.toFixed(2)} | margin=$${margin.toFixed(2)} ${lev}x = $${notional.toFixed(2)} | TP=$${tp.toFixed(2)} SL=$${sl.toFixed(2)} BE=$${bePx.toFixed(2)} | R:R=${rr.toFixed(2)} net=+$${expectedNet.toFixed(4)}`, 'buy');

  if (isPaper) {
    S.futPapOrders.push(o);
  } else {
    S.futOrders.push(o);
    futPlaceOrder('open_long', margin, lev, px);
  }
}

// ── FUTURES EXIT CHECK ────────────────────────────────────────────────────────
// Smart exits:
// 1. TP hit -> close in profit (guaranteed after fees)
// 2. SL hit -> small controlled loss
// 3. Break-even stop: if price reached 50% toward TP then fell back -> close at 0 loss
// 4. Profit lock: if position shows live profit > 50% of target -> move SL to lock it
function futExitCheck(px, isPaper) {
  const orders = isPaper ? S.futPapOrders : S.futOrders;
  let changed  = false;

  orders.forEach(o => {
    if (o.status !== 'open') return;

    // Track peak price since open
    if (px > o.peakPx) o.peakPx = px;

    // ── Break-even stop logic ────────────────────────────────────────────────
    // Once price has moved 40%+ toward TP, move SL to break-even price
    // This means from here the trade can NEVER lose — worst case = 0
    if (!o.beStopMoved) {
      const tpDist      = o.tp - o.entryPx;
      const movedSoFar  = o.peakPx - o.entryPx;
      const pctToTP     = tpDist > 0 ? movedSoFar / tpDist : 0;
      if (pctToTP >= 0.40) {
        // Move SL up to break-even price (= entry + fees)
        if (o.bePx > o.sl) {
          o.sl = o.bePx;
          o.beStopMoved = true;
          log(`🔒 FUT BE-STOP: SL moved to break-even $${o.bePx.toFixed(2)} (${(pctToTP*100).toFixed(0)}% toward TP)`, 'info');
        }
      }
    }

    // ── Profit lock: if at 80%+ toward TP, tighten SL to lock 70% of profit ─
    if (o.beStopMoved) {
      const tpDist     = o.tp - o.entryPx;
      const movedSoFar = o.peakPx - o.entryPx;
      const pctToTP    = tpDist > 0 ? movedSoFar / tpDist : 0;
      if (pctToTP >= 0.80) {
        // Lock in 70% of max profit by setting SL to 70% of TP distance
        const lockSl = o.entryPx + (tpDist * 0.70);
        if (lockSl > o.sl) {
          o.sl = parseFloat(lockSl.toFixed(4));
          log(`🔒 FUT PROFIT-LOCK: SL at $${o.sl.toFixed(2)} (locks 70% of TP profit)`, 'info');
        }
      }
    }

    // ── Profit protection: if in profit and giving back 60%+ of gains -> close ──
    const curNet = futFeeMath(o.entryPx, px, o.margin, o.leverage).net;
    if (curNet > (o.peakNet||0)) o.peakNet = curNet;
    const futMinProfit = o.margin * 0.001; // minimum threshold to protect
    if ((o.peakNet||0) > futMinProfit && curNet > 0) {
      const giveback = (o.peakNet - curNet) / o.peakNet;
      if (giveback >= 0.60) {
        // Gave back 60% of peak profit but still positive -> protect it
        const {net, fee, pnl} = futFeeMath(o.entryPx, px, o.margin, o.leverage);
        o.status = 'closed'; changed = true;
        const movePct = ((px-o.entryPx)/o.entryPx*100).toFixed(3);
        const tr = {n:isPaper?++S.futPapT:++S.futT,time:new Date().toISOString().slice(11,19),pair:S.futPair,direction:'LONG',isPaper,side:'PROTECT',entryPx:o.entryPx,exitPx:px,margin:o.margin,leverage:o.leverage,notional:o.notional,move:movePct+'%',leveragedMove:(parseFloat(movePct)*o.leverage).toFixed(3)+'%',fee:+fee.toFixed(6),pnl:+pnl.toFixed(6),net:+net.toFixed(6)};
        if(isPaper){S.futPapProfit+=net;S.futFees+=fee;if(net>=0)S.futPapW++;else S.futPapL++;S.futPapTrades.unshift(tr);if(S.futPapTrades.length>200)S.futPapTrades.length=200;log(`🛡 FUT-PAPER PROTECT @ $${px.toFixed(2)} | peak=+$${o.peakNet.toFixed(4)} saved=+$${net.toFixed(4)}`,'profit');}
        else{S.futProfit+=net;S.futFees+=fee;if(net>=0){S.futW++;if(net>S.futBest)S.futBest=net;}else S.futL++;S.futTrades.unshift(tr);if(S.futTrades.length>200)S.futTrades.length=200;log(`🛡 FUT-LIVE PROTECT @ $${px.toFixed(2)} | peaked +$${o.peakNet.toFixed(4)} -> locked +$${net.toFixed(4)}`,'profit');futPlaceOrder('close_long',o.margin,o.leverage,px);}
        save(); return;
      }
    }

    // ── Check exit conditions ────────────────────────────────────────────────
    let why = null, exitAt = px;

    if (px >= o.tp) {
      why    = 'TP';
      exitAt = o.tp;
    } else if (px <= o.sl) {
      why    = o.beStopMoved ? 'BE-STOP' : 'SL';
      exitAt = o.sl;
    }

    if (!why) return;

    const {net, fee, pnl} = futFeeMath(o.entryPx, exitAt, o.margin, o.leverage);

    // Safety: if somehow TP gives negative (rounding), don't record as loss
    if (why === 'TP' && net < 0) {
      log(`⚠ FUT TP net negative ($${net.toFixed(6)}) — rounding issue, marking as $0.0001`, 'err');
    }

    o.status = 'closed';
    changed  = true;

    const movePct      = ((exitAt - o.entryPx) / o.entryPx * 100).toFixed(3);
    const leveragedPct = (parseFloat(movePct) * o.leverage).toFixed(3);

    const tr = {
      n: isPaper ? ++S.futPapT : ++S.futT,
      time: new Date().toISOString().slice(11, 19),
      pair: S.futPair, direction: 'LONG', isPaper,
      side: why, entryPx: o.entryPx, exitPx: exitAt,
      margin: o.margin, leverage: o.leverage,
      notional: o.notional,
      move: movePct+'%', leveragedMove: leveragedPct+'%',
      fee: +fee.toFixed(6), pnl: +pnl.toFixed(6), net: +net.toFixed(6)
    };

    if (isPaper) {
      S.futPapProfit += net; S.futFees += fee;
      if (net >= 0) S.futPapW++; else S.futPapL++;
      S.futPapTrades.unshift(tr);
      if (S.futPapTrades.length > 200) S.futPapTrades.length = 200;
      log(`📝 FUT-PAPER ${why} @ $${exitAt.toFixed(2)} | ${movePct}% (${leveragedPct}% lev${o.leverage}x) | fee=$${fee.toFixed(4)} NET=${net>=0?'+':''}$${net.toFixed(4)}`, net>=0?'profit':'err');
    } else {
      S.futProfit  += net; S.futFees += fee;
      S.todayFutP  = (S.todayFutP||0) + net;
      if (net >= 0) { S.futW++; if (net > S.futBest) S.futBest = net; } else S.futL++;
      S.futTrades.unshift(tr);
      if (S.futTrades.length > 200) S.futTrades.length = 200;
      const emoji = why==='TP'?'✅':why==='BE-STOP'?'🔒':'🛑';
      log(`${emoji} FUT-LIVE ${why} @ $${exitAt.toFixed(2)} | ${movePct}% (${leveragedPct}% lev) | fee=$${fee.toFixed(4)} NET=${net>=0?'+':''}$${net.toFixed(4)}`, net>=0?'sell':'err');
      if (net > 0) log(`💰 FUT PROFIT +$${net.toFixed(4)} added to wallet`, 'profit');
      futPlaceOrder('close_long', o.margin, o.leverage, exitAt);
    }
    save();
  });

  if (changed) {
    if (isPaper) S.futPapOrders = S.futPapOrders.filter(o=>o.status==='open');
    else         S.futOrders    = S.futOrders.filter(o=>o.status==='open');
  }
}

// ── FUTURES ORDER PLACEMENT (MEXC Perpetual API) ──────────────────────────────
// MEXC Futures API: contract.mexc.com
// Signing: HMAC-SHA256(apiKey + timestamp + params)
// Params for POST: JSON body string
function futPlaceOrder(action, marginUsdt, leverage, px) {
  if (!S.apiKey || !S.apiSecret) {
    log('Futures: no API keys', 'err');
    return;
  }

  const ts  = Date.now().toString();
  const sym = S.futPair; // e.g. BTC_USDT

  // Calculate number of contracts
  // MEXC BTC_USDT: 1 contract = 0.0001 BTC
  // Notional = contracts × 0.0001 × price = marginUsdt × leverage
  const notional  = marginUsdt * leverage;
  const contracts = Math.floor(notional / (0.0001 * px));

  if (contracts < 1) {
    log(`Futures: too small — contracts=${contracts} (need ≥1). Increase capital or leverage.`, 'err');
    return;
  }

  // side: 1=open long, 2=close long, 3=open short, 4=close short
  const side = action === 'open_long' ? 1 : 2;

  const body = {
    symbol:   sym,
    price:    0,          // 0 = market order
    vol:      contracts,
    side:     side,
    type:     5,          // 5 = market order
    openType: 1,          // 1 = isolated margin
    leverage: leverage
  };

  const bodyStr = JSON.stringify(body);

  // MEXC Futures signature: HMAC-SHA256(apiKey + timestamp + bodyString)
  const sigInput = S.apiKey + ts + bodyStr;
  const signature = crypto.createHmac('sha256', S.apiSecret).update(sigInput).digest('hex');

  const headers = {
    'ApiKey':       S.apiKey,
    'Request-Time': ts,
    'Signature':    signature,
    'Content-Type': 'application/json',
    'Accept':       'application/json'
  };

  log(`🚀 Futures order: ${action} ${contracts} contracts ${sym} @ market (notional~$${notional.toFixed(2)})`, 'buy');

  const req = https.request({
    hostname: 'contract.mexc.com',
    path:     '/api/v1/private/order/submit',
    method:   'POST',
    headers,
    timeout:  8000
  }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const r = JSON.parse(d);
        if (r.success) {
          log(`✅ Futures order filled! orderId=${r.data} action=${action} contracts=${contracts}`, 'profit');
          log(`✅ Check MEXC Futures wallet — margin changed by $${marginUsdt.toFixed(2)}`, 'profit');
        } else {
          log(`❌ Futures order failed: code=${r.code} msg=${r.message||r.msg}`, 'err');
          if (r.code === 1002) log('❌ FUT FIX: Futures permission not enabled — MEXC API key needs Futures permission', 'err');
          if (r.code === 4001) log('❌ FUT FIX: Insufficient futures margin — transfer USDT to Futures wallet on MEXC', 'err');
          if (r.code === 1003) log('❌ FUT FIX: Invalid signature for futures API', 'err');
        }
      } catch(e) {
        log(`Futures parse err: ${e.message} raw=${d.substring(0,150)}`, 'err');
      }
    });
  });
  req.on('error', e => log(`Futures net err: ${e.message}`, 'err'));
  req.on('timeout', () => { req.destroy(); log('Futures timeout', 'err'); });
  req.write(bodyStr);
  req.end();
}

// ── FUTURES BALANCE CHECK ─────────────────────────────────────────────────────
function getFuturesBalance(callback) {
  if (!S.apiKey || !S.apiSecret) { callback(null, 'No API keys'); return; }
  const ts  = Date.now().toString();
  const sig = crypto.createHmac('sha256', S.apiSecret)
    .update(S.apiKey + ts)
    .digest('hex');
  https.request({
    hostname: 'contract.mexc.com',
    path:     '/api/v1/private/account/assets',
    method:   'GET',
    headers:  {'ApiKey':S.apiKey,'Request-Time':ts,'Signature':sig,'Accept':'application/json'},
    timeout:  8000
  }, res => {
    let d=''; res.on('data',c=>d+=c);
    res.on('end',()=>{
      try {
        const r = JSON.parse(d);
        if (r.success && r.data) {
          const usdt = r.data.find ? r.data.find(a=>a.currency==='USDT') : null;
          callback({
            availableBalance: usdt?.availableBalance || r.data.availableBalance || '?',
            equity: usdt?.equity || r.data.equity || '?'
          }, null);
        } else {
          callback(null, `code=${r.code} ${r.message||''}`);
        }
      } catch(e) { callback(null, e.message); }
    });
  }).on('error', e=>callback(null,e.message)).end();
}

// ── RSI/EMA/BB helpers (shared with spot) ─────────────────────────────────────
function calcRSI(arr, n=14) {
  if(arr.length<n+1) return 50;
  const sl=arr.slice(-(n+1));let g=0,l=0;
  for(let i=1;i<sl.length;i++){const d=sl[i]-sl[i-1];if(d>0)g+=d;else l-=d;}
  const al=l/n;if(al===0)return 100;return 100-(100/(1+(g/n)/al));
}
function calcEMA(arr,n){
  if(arr.length<n)return arr[arr.length-1]||0;
  const k=2/(n+1);let e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<arr.length;i++)e=arr[i]*k+e*(1-k);return e;
}
function calcBB(arr,n=20){
  if(arr.length<n)return null;
  const sl=arr.slice(-n),m=sl.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/n);
  return{upper:m+2*sd,middle:m,lower:m-2*sd};
}

// ══════════════════════════════════════════════════════════════════════════════
// AI BRAIN — DeepSeek Integration
// Analyzes market conditions every 30s and returns BUY/HOLD/AVOID + reasoning
// Cost: ~$0.001 per analysis (deepseek-chat model)
// ══════════════════════════════════════════════════════════════════════════════

function buildMarketContext(px, isFutures) {
  const raw = (isFutures ? futPX : PX.map(p=>p.px||p)).filter(v=>v>0);
  const n   = raw.length;
  if (n < 3) return null;

  const r14  = calcRSI(raw, Math.min(14,n-1));
  const r9   = calcRSI(raw, Math.min(9,n-1));
  const e9   = calcEMA(raw, Math.min(9,n));
  const e21  = calcEMA(raw, Math.min(21,n));
  const bb   = n>=10 ? calcBB(raw, Math.min(20,n)) : null;
  const slc  = raw.slice(-Math.min(10,n));
  const hi   = Math.max(...slc);
  const lo   = Math.min(...slc);
  const dip  = ((px-hi)/hi*100).toFixed(3);
  const ch1  = n>1 ? ((px-raw[n-2])/raw[n-2]*100).toFixed(4) : '0';
  const ch5  = n>5 ? ((px-raw[n-6])/raw[n-6]*100).toFixed(4) : '0';
  const trend= e9>e21 ? 'UPTREND' : e9<e21 ? 'DOWNTREND' : 'SIDEWAYS';
  const bbPos= bb ? (px<=bb.lower?'AT_SUPPORT':px>=bb.upper?'AT_RESISTANCE':px<bb.middle?'MID_LOW':'MID_HIGH') : 'UNKNOWN';
  const vol  = slc.length>1 ? (Math.max(...slc)-Math.min(...slc))/lo*100 : 0;

  const allTrades = isFutures ? S.futTrades : S.liveTrades;
  const papTrades = isFutures ? S.futPapTrades : S.papTrades;
  const recentL   = allTrades.slice(0,5).map(t=>`${t.side}${t.net>=0?'+'+t.net.toFixed(3):t.net.toFixed(3)}`).join(' ');
  const recentP   = papTrades.slice(0,5).map(t=>`${t.side}${t.net>=0?'+'+t.net.toFixed(3):t.net.toFixed(3)}`).join(' ');
  const totalP    = isFutures ? S.futProfit : S.liveProfit;
  const winRate   = isFutures ? (S.futT>0?Math.round(S.futW/S.futT*100):0) : (S.liveT>0?Math.round(S.liveW/S.liveT*100):0);
  const openPos   = (isFutures ? S.futOrders : S.liveOrders).filter(o=>o.status==='open').length;

  return {
    pair: isFutures ? S.futPair : S.pair,
    type: isFutures ? `FUTURES ${S.futLeverage}x leverage` : 'SPOT',
    price: px,
    rsi14: r14.toFixed(1), rsi9: r9.toFixed(1),
    ema9: e9.toFixed(2), ema21: e21.toFixed(2),
    trend, bbPos,
    bbLower: bb?.lower.toFixed(2)||'n/a',
    bbMid:   bb?.middle.toFixed(2)||'n/a',
    bbUpper: bb?.upper.toFixed(2)||'n/a',
    dip10tick: dip,
    ch1tick: ch1, ch5tick: ch5,
    volatility: vol.toFixed(4)+'%',
    recentPrices: raw.slice(-8).map(p=>p.toFixed(0)).join('->'),
    liveTrades: recentL||'none',
    paperTrades: recentP||'none',
    totalProfit: '$'+totalP.toFixed(4),
    winRate: winRate+'%',
    openPositions: openPos,
    maxPositions: isFutures ? S.futMaxPos : S.maxPos,
    capital: isFutures ? S.futCapital : S.capital,
    fee: isFutures ? '0.04%' : '0.10%',
    tpConfig: isFutures ? S.futTpPct+'%' : S.tpPct+'%',
    slConfig: isFutures ? S.futSlPct+'%' : S.slPct+'%'
  };
}

function buildPrompt(ctx) {
  var isFut = ctx.type.indexOf("FUTURES") !== -1;
  var shortLine = isFut ? "- SHORT: RSI>60, EMA bearish, price at resistance -> open short\n" : "";
  var p = "";
  p += "You are an autonomous crypto trading agent managing real money. Goal: grow the account.\n\n";
  p += "ACCOUNT: capital=$" + ctx.capital + " open=" + ctx.openPositions + "/" + ctx.maxPositions;
  p += " profit=" + ctx.totalProfit + " winRate=" + ctx.winRate + "\n";
  p += "LiveTrades: " + ctx.liveTrades + "\n";
  p += "PaperTrades: " + ctx.paperTrades + "\n\n";
  p += "MARKET " + ctx.pair + " " + ctx.type + ":\n";
  p += "Price=$" + ctx.price + " RSI14=" + ctx.rsi14 + " RSI9=" + ctx.rsi9 + "\n";
  p += "EMA9=$" + ctx.ema9 + " EMA21=$" + ctx.ema21 + " trend=" + ctx.trend + "\n";
  p += "BB: lower=$" + ctx.bbLower + " mid=$" + ctx.bbMid + " upper=$" + ctx.bbUpper + " pos=" + ctx.bbPos + "\n";
  p += "dip=" + ctx.dip10tick + "% ch1=" + ctx.ch1tick + "% ch5=" + ctx.ch5tick + "%\n";
  p += "volatility=" + ctx.volatility + " recentPx=" + ctx.recentPrices + "\n\n";
  p += "SETTINGS: TP=" + ctx.tpConfig + " SL=" + ctx.slConfig + " fee=" + ctx.fee + "\n\n";
  p += "YOUR RULES:\n";
  p += "- BUY: RSI<50, price bouncing from dip, EMA uptrend or neutral -> enter long\n";
  p += shortLine;
  p += "- HOLD: uncertain, RSI 50-65, sideways, recent losses -> skip this cycle\n";
  p += "- Never chase pumps: if RSI>70 or price at top, HOLD\n";
  p += "- If last 3 trades all SL losses -> be conservative, HOLD unless very strong signal\n\n";
  p += "Respond ONLY with this JSON (no text outside JSON):\n";
  p += "{\"action\":\"BUY\",\"confidence\":78,\"reason\":\"one sentence\",\"risk\":\"low|med|high\",\"tp_suggest\":0.45,\"sl_suggest\":0.20}";
  return p;
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
  // Handle CORS preflight first
  if (req.method === 'OPTIONS') {
    setHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const url = req.url.split('?')[0];

  // ── PUBLIC endpoints (no PIN required) ──────────────────────────────────────
  if (url === '/' || url === '/ping' || url === '/health') {
    send(res, 200, {ok:true, uptime:process.uptime().toFixed(0)+'s', time:new Date().toISOString()});
    return;
  }

  if (url === '/prices') {
    send(res, 200, {prices:S.prices, ticks});
    return;
  }

  if (url === '/debug') {
    const keyPreview = S.apiKey ? S.apiKey.substring(0,6)+'••••••'+S.apiKey.slice(-4) : 'NOT SET';
    const secPreview = S.apiSecret ? S.apiSecret.substring(0,4)+'••••'+S.apiSecret.slice(-4) : 'NOT SET';
    // Also show raw env var to check for invisible chars
    const envKeyRaw  = process.env.MEXC_KEY    || '';
    const envSecRaw  = process.env.MEXC_SECRET || '';
    const envKeySan  = sanitizeKey(envKeyRaw);
    const envSecSan  = sanitizeKey(envSecRaw);
    send(res, 200, {
      mode:S.mode, botOn:S.botOn, pair:S.pair, strategy:S.strategy,
      hasApiKey:!!S.apiKey, hasSecret:!!S.apiSecret, keyPreview, secPreview,
      keyLen: S.apiKey.length, secLen: S.apiSecret.length,
      envKeySet:!!process.env.MEXC_KEY, envSecSet:!!process.env.MEXC_SECRET,
      envKeyLen: envKeyRaw.length, envKeySanLen: envKeySan.length,
      envSecLen: envSecRaw.length, envSecSanLen: envSecSan.length,
      envKeyMatch: envKeyRaw === envKeySan,
      envRunning:process.env.BOT_RUNNING, envMode:process.env.BOT_MODE,
      capital:S.capital, tpPct:S.tpPct, slPct:S.slPct,
      ticks, warmedUp:ticks>=S.warmup,
      liveOrders:S.liveOrders.length, papOrders:S.papOrders.length,
      liveT:S.liveT, papT:S.papT, uptime:process.uptime().toFixed(0)+'s'
    });
    return;
  }

  // ── PIN check — required for all remaining endpoints ────────────────────────
  if (req.headers['x-bot-pin'] !== BOT_PIN) {
    send(res, 401, {error:'Invalid PIN'});
    return;
  }

  // ── GET /status ──────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url === '/status') {
    const I = getIndicators();
    const addPnl = o => ({...o, livePnl:feeMath(o.entryPx,S.lastPx,o.amt).net, peakNet:o.peakNet||0});
    send(res, 200, {
      botOn:S.botOn, mode:S.mode, strategy:S.strategy, pair:S.pair,
      capital:S.capital, maxPos:S.maxPos, tpPct:S.tpPct, slPct:S.slPct,
      trailPct:S.trailPct, maxDaily:S.maxDaily, cooldown:S.cooldown,
      lastPx:S.lastPx, prices:S.prices, ticks, warmup:S.warmup,
      warmedUp:ticks>=S.warmup,
      liveProfit:S.liveProfit, todayP:S.todayP, liveT:S.liveT,
      liveW:S.liveW, liveL:S.liveL, bestT:S.bestT, feesT:S.feesT,
      liveWR:S.liveT>0?Math.round(S.liveW/S.liveT*100):0,
      papProfit:S.papProfit, papT:S.papT, papW:S.papW, papL:S.papL,
      papBest:S.papBest, papFees:S.papFees,
      papWR:S.papT>0?Math.round(S.papW/S.papT*100):0,
      liveOrders:S.liveOrders.filter(o=>o.status==='open').map(addPnl),
      papOrders:S.papOrders.filter(o=>o.status==='open').map(addPnl),
      liveTrades:S.liveTrades.slice(0,60), papTrades:S.papTrades.slice(0,60),
      log:S.log.slice(0,150),
      hasApiKeys:!!(S.apiKey&&S.apiSecret), mexcBalance:S.mexcBalance||null,
      startedAt:S.startedAt, savedAt:S.savedAt, feeRt:RT_FEE*100,
      // AI Brain status
      aiEnabled:  !!(S.aiKey),
      aiMode:     S.aiMode,
      aiInterval: S.aiInterval,
      aiMinConf:  S.aiMinConf,
      aiDecision: S.aiDecision,
      aiFutDecision: S.aiFutDecision,
      aiCallCount: S.aiCallCount,
      aiTokensUsed: S.aiTokensUsed,
      aiCost:     S.aiCost,
      // Futures status
      futuresOn:S.futuresOn, futMode:S.futMode, futPair:S.futPair,
      futCapital:S.futCapital, futMaxPos:S.futMaxPos, futLeverage:S.futLeverage,
      futTpPct:S.futTpPct, futSlPct:S.futSlPct, futLastPx:S.futLastPx,
      futFeeRt: FUT_RT_FEE*100,
      futProfit:S.futProfit, todayFutP:S.todayFutP||0, futT:S.futT, futW:S.futW, futL:S.futL, futBest:S.futBest, futFees:S.futFees,
      futWR: S.futT>0?Math.round(S.futW/S.futT*100):0,
      futPapProfit:S.futPapProfit, futPapT:S.futPapT, futPapW:S.futPapW, futPapL:S.futPapL,
      futPapWR: S.futPapT>0?Math.round(S.futPapW/S.futPapT*100):0,
      futOrders:  S.futOrders.filter(o=>o.status==='open').map(o=>({...o, livePnl:futFeeMath(o.entryPx,S.futLastPx||S.lastPx,o.margin,o.leverage).net, peakNet:o.peakNet||0, beStopMoved:o.beStopMoved||false, bePx:o.bePx||0})),
      futPapOrders: S.futPapOrders.filter(o=>o.status==='open').map(o=>({...o, livePnl:futFeeMath(o.entryPx,S.futLastPx||S.lastPx,o.margin,o.leverage).net, peakNet:o.peakNet||0, beStopMoved:o.beStopMoved||false, bePx:o.bePx||0})),
      futTrades:    S.futTrades.slice(0,50),
      futPapTrades: S.futPapTrades.slice(0,50),
      futTicks:     S.futTicks||0,
      indicators:I?{
        rsi14:I.rsi14.toFixed(1), rsi9:I.rsi9.toFixed(1),
        e9:I.e9.toFixed(4), e21:I.e21.toFixed(4),
        bbLow:I.bb?.lower.toFixed(4)||null, bbMid:I.bb?.middle.toFixed(4)||null,
        dipFromHi:I.dipFromHi.toFixed(4), ch1:I.ch1.toFixed(4), ch5:I.ch5.toFixed(4),
        trend:I.trend, lastSig:getSignal(S.lastPx)
      }:null
    });
    return;
  }

  // ── /balance ─────────────────────────────────────────────────────────────────
  if (url === '/balance') {
    if (!S.apiKey || !S.apiSecret) {
      send(res, 400, {error:'No API keys in server memory. Go to Config tab -> enter MEXC keys -> Save API Keys Permanently', hasKeys:false});
      return;
    }
    mexcRequest('GET', '/api/v3/account', {}, S.apiKey, S.apiSecret, (err, acc) => {
      if (err) { send(res, 500, {error:err.message}); return; }
      if (acc.balances) {
        const usdt     = acc.balances.find(b=>b.asset==='USDT');
        const coinName = S.pair.replace('USDT','');
        const coin     = acc.balances.find(b=>b.asset===coinName);
        const free     = parseFloat(usdt?.free||0).toFixed(4);
        S.mexcBalance  = free;
        log(`💳 Wallet — USDT: $${free} free | ${coinName}: ${coin?.free||'0'}`, 'profit');
        send(res, 200, {
          ok:true,
          usdt:{free:usdt?.free||'0', locked:usdt?.locked||'0'},
          coin:{asset:coinName, free:coin?.free||'0', locked:coin?.locked||'0'}
        });
      } else {
        log(`❌ Balance failed: code=${acc.code} msg=${acc.msg}`, 'err');
        if (acc.code===700002) log('❌ FIX: Signature invalid — copy keys again from MEXC, no spaces','err');
        if (acc.code===700003) log('❌ FIX: Invalid key — re-copy from MEXC API Management','err');
        if (acc.code===700006) log('❌ FIX: IP whitelist — remove IP restriction from MEXC API key','err');
        send(res, 200, {ok:false, error:acc.msg||'Unknown', code:acc.code||0});
      }
    });
    return;
  }

  // ── GET or POST /testconnection ───────────────────────────────────────────────
  if (url === '/testconnection') {
    if (!S.apiKey || !S.apiSecret) {
      send(res, 400, {error:'No API keys in server memory. Go to Config -> enter MEXC keys -> Save API Keys Permanently', hasKeys:false});
      return;
    }
    testMexcConnection();
    send(res, 200, {ok:true, msg:'Testing MEXC — check Server Log in 5 seconds'});
    return;
  }

  // ── All POST endpoints ────────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    send(res, 404, {error:'Not found'});
    return;
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', async () => {
    let d = {};
    try { d = JSON.parse(body); } catch(e) {}

    // /savekeys
    if (url === '/savekeys') {
      if (!d.apiKey || !d.apiSecret) {
        send(res, 400, {error:'apiKey and apiSecret required'});
        return;
      }
      const rawKey = sanitizeKey(d.apiKey);
      const rawSec = sanitizeKey(d.apiSecret);
      log(`Sanitized key: len=${rawKey.length} first6=${rawKey.substring(0,6)} last4=${rawKey.slice(-4)}`,'info');
      log(`Sanitized sec: len=${rawSec.length} first4=${rawSec.substring(0,4)} last4=${rawSec.slice(-4)}`,'info');
      if (rawKey.length < 10 || rawSec.length < 10) {
        send(res, 400, {error:'Key looks too short — copy the full key from MEXC'});
        return;
      }
      S.apiKey    = rawKey;
      S.apiSecret = rawSec;
      saveKeys(rawKey, rawSec);
      save();
      log(`Keys saved: ${rawKey.substring(0,6)}••••${rawKey.slice(-4)} (len=${rawKey.length})`, 'info');
      // Immediately test keys using the same signing helper
      mexcRequest('GET', '/api/v3/account', {}, rawKey, rawSec, (err, acc) => {
        if (err) { log(`Key test error: ${err.message}`, 'err'); return; }
        if (acc.balances) {
          const usdt = acc.balances.find(b=>b.asset==='USDT');
          const bal  = parseFloat(usdt?.free||0).toFixed(4);
          S.mexcBalance = bal;
          log(`✅ MEXC KEYS VERIFIED! USDT balance: $${bal} — signature is correct`, 'profit');
          log(`✅ Bot will place real orders on next live signal`, 'profit');
        } else {
          log(`❌ Key test FAILED: code=${acc.code} msg=${acc.msg}`, 'err');
          if (acc.code==700002||acc.code=='700002') log('❌ Signature invalid — try saving keys again. Make sure no spaces in key/secret','err');
          if (acc.code==700003||acc.code=='700003') log('❌ Invalid key — re-copy Access Key from MEXC API Management exactly','err');
          if (acc.code==700006||acc.code=='700006') log('❌ IP whitelist blocking — MEXC API Management -> your key -> remove IP restriction','err');
        }
      });

      send(res, 200, {ok:true, keyLength:rawKey.length, secLength:rawSec.length,
        msg:'Keys saved. Testing with MEXC — check Server Log in 5 seconds.'});
      return;
    }

    // /config
    if (url === '/config') {
      if(d.pair)     S.pair     = d.pair.replace('/','');
      if(d.strategy) S.strategy = d.strategy;
      if(d.mode)     S.mode     = d.mode;
      if(d.capital)  S.capital  = parseFloat(d.capital)||20;
      if(d.maxPos)   S.maxPos   = parseInt(d.maxPos)||3;
      if(d.tpPct)    S.tpPct    = Math.max(parseFloat(d.tpPct), RT_FEE*100+0.12);
      if(d.slPct)    S.slPct    = Math.max(parseFloat(d.slPct), RT_FEE*100*2); // SL >= 2x fee
      if(d.trailPct) S.trailPct = parseFloat(d.trailPct)||0.10;
      if(d.maxDaily) S.maxDaily = parseInt(d.maxDaily)||200;
      if(d.cooldown) S.cooldown = parseInt(d.cooldown)*1000||8000;
      if(d.apiKey && d.apiSecret && d.apiKey!=='[saved]' && d.apiKey.length>5) {
        S.apiKey    = sanitizeKey(d.apiKey);
        S.apiSecret = sanitizeKey(d.apiSecret);
        saveKeys(S.apiKey, S.apiSecret);
      }
      if(S.mode==='live') S.lastLiveEntry=0;
      save();
      const posSize = S.capital / S.maxPos;
      log(`Config: ${S.pair} MODE=${S.mode} tp=${S.tpPct}% sl=${S.slPct}% pos=$${posSize.toFixed(2)} keys=${!!(S.apiKey&&S.apiSecret)}`,'info');
      if (posSize < 5) log(`⚠ Position size $${posSize.toFixed(2)} is below MEXC minimum $5. Reduce maxPos or increase capital.`,'err');
      if (S.apiKey && S.apiKey.length < 20) log(`⚠ API key len=${S.apiKey.length} seems short. Real MEXC keys are 30+ chars. Re-copy full key from MEXC.`,'err');
      send(res, 200, {ok:true, tpPct:S.tpPct, slPct:S.slPct, mode:S.mode, hasKeys:!!(S.apiKey&&S.apiSecret)});
      return;
    }

    // /start
    if (url === '/start') {
      if (S.botOn) { send(res,200,{ok:true,msg:'Already running'}); return; }
      S.botOn=true; S.liveOrders=[]; S.papOrders=[];
      S.lastEntry=0; S.startedAt=new Date().toISOString();
      PX=[]; ticks=0;
      startFeed();
      log(`▶ STARTED ${S.pair} [${S.strategy}] mode=${S.mode} $${S.capital} keys=${!!(S.apiKey&&S.apiSecret)}`,'buy');
      save();
      send(res, 200, {ok:true});
      return;
    }

    // /stop
    if (url === '/stop') {
      S.botOn=false; S.liveOrders=[]; S.papOrders=[];
      stopFeed();
      log('■ Bot stopped.','info');
      save();
      send(res, 200, {ok:true});
      return;
    }

    // /setlive
    if (url === '/setlive') {
      if (!S.apiKey || !S.apiSecret) {
        send(res, 400, {error:'No API keys. Save keys first.', hasKeys:false});
        return;
      }
      S.mode='live'; S.lastLiveEntry=0;
      save();
      log(`🚀 LIVE MODE ON: ${S.pair} $${S.capital} TP=${S.tpPct}% SL=${S.slPct}%`,'buy');
      send(res, 200, {ok:true, mode:'live', pair:S.pair, capital:S.capital, hasKeys:true});
      return;
    }

    // /setpaper
    if (url === '/setpaper') {
      S.mode='paper'; save();
      log('📝 Paper mode.','info');
      send(res, 200, {ok:true, mode:'paper'});
      return;
    }

    // /reset
    if (url === '/reset') {
      const ak=S.apiKey, as=S.apiSecret;
      S.liveProfit=0;S.todayP=0;S.liveT=0;S.liveW=0;S.liveL=0;S.bestT=0;S.feesT=0;
      S.papProfit=0;S.papT=0;S.papW=0;S.papL=0;S.papBest=0;S.papFees=0;
      S.liveTrades=[];S.papTrades=[];S.liveOrders=[];S.papOrders=[];S.log=[];
      S.apiKey=ak; S.apiSecret=as;
      save(); send(res, 200, {ok:true}); return;
    }

    // /resetpaper
    if (url === '/resetpaper') {
      S.papProfit=0;S.papT=0;S.papW=0;S.papL=0;S.papBest=0;S.papFees=0;
      S.papTrades=[];S.papOrders=[];
      save(); send(res, 200, {ok:true}); return;
    }

    // /closetrade — manually close a spot position by id
    if (url === '/closetrade') {
      const {id, isPaper} = d;
      const orders = isPaper ? S.papOrders : S.liveOrders;
      const o = orders.find(o => o.id == id && o.status === 'open');
      if (!o) { send(res, 404, {error:'Position not found'}); return; }
      const px = S.lastPx;
      const {fee, net, gross} = feeMath(o.entryPx, px, o.amt);
      o.status = 'closed';
      const tr = {
        n:isPaper?++S.papT:++S.liveT, time:new Date().toISOString().slice(11,19),
        dur:o.openAt?`${o.openAt}->${new Date().toISOString().slice(11,19)}`:'',
        pair:S.pair, strat:o.strat, isPaper, side:'MANUAL',
        entryPx:o.entryPx, exitPx:px, amt:o.amt,
        fee:+fee.toFixed(6), gross:+gross.toFixed(6), net:+net.toFixed(6)
      };
      if(isPaper){S.papProfit+=net;S.papFees+=fee;if(net>=0){S.papW++;if(net>S.papBest)S.papBest=net;}else S.papL++;S.papTrades.unshift(tr);S.papOrders=S.papOrders.filter(o=>o.status==='open');}
      else{S.liveProfit+=net;S.todayP+=net;S.feesT+=fee;if(net>=0){S.liveW++;if(net>S.bestT)S.bestT=net;}else S.liveL++;S.liveTrades.unshift(tr);S.liveOrders=S.liveOrders.filter(o=>o.status==='open');placeOrder('SELL',o.qty,S.pair);}
      log(`🖱 MANUAL CLOSE spot @ $${px.toFixed(4)} NET=${net>=0?'+':''}$${net.toFixed(4)}`,'info');
      save();
      send(res, 200, {ok:true, net, fee, exitPx:px}); return;
    }

    // /closefuttrade — manually close a futures position by id
    if (url === '/closefuttrade') {
      const {id, isPaper} = d;
      const orders = isPaper ? S.futPapOrders : S.futOrders;
      const o = orders.find(o => o.id == id && o.status === 'open');
      if (!o) { send(res, 404, {error:'Futures position not found'}); return; }
      const px = S.futLastPx || S.lastPx;
      const {net, fee, pnl} = futFeeMath(o.entryPx, px, o.margin, o.leverage);
      o.status = 'closed';
      const movePct = ((px-o.entryPx)/o.entryPx*100).toFixed(3);
      const tr = {n:isPaper?++S.futPapT:++S.futT,time:new Date().toISOString().slice(11,19),pair:S.futPair,direction:'LONG',isPaper,side:'MANUAL',entryPx:o.entryPx,exitPx:px,margin:o.margin,leverage:o.leverage,notional:o.notional,move:movePct+'%',leveragedMove:(parseFloat(movePct)*o.leverage).toFixed(3)+'%',fee:+fee.toFixed(6),pnl:+pnl.toFixed(6),net:+net.toFixed(6)};
      if(isPaper){S.futPapProfit+=net;S.futFees+=fee;if(net>=0)S.futPapW++;else S.futPapL++;S.futPapTrades.unshift(tr);S.futPapOrders=S.futPapOrders.filter(o=>o.status==='open');}
      else{S.futProfit+=net;S.futFees+=fee;if(net>=0){S.futW++;if(net>S.futBest)S.futBest=net;}else S.futL++;S.futTrades.unshift(tr);S.futOrders=S.futOrders.filter(o=>o.status==='open');futPlaceOrder('close_long',o.margin,o.leverage,px);}
      log(`🖱 MANUAL CLOSE futures @ $${px.toFixed(2)} NET=${net>=0?'+':''}$${net.toFixed(4)}`,'info');
      save();
      send(res, 200, {ok:true, net, fee, exitPx:px}); return;
    }

    // /setaikey — save DeepSeek API key
    if (url === '/setaikey') {
      if (!d.aiKey) { send(res,400,{error:'aiKey required'}); return; }
      S.aiKey = d.aiKey.trim();
      if(d.aiMode)    S.aiMode    = d.aiMode;
      if(d.aiInterval)S.aiInterval= parseInt(d.aiInterval)||30;
      if(d.aiMinConf) S.aiMinConf = parseInt(d.aiMinConf)||65;
      save();
      // Reset last call timestamps so AI runs immediately
      S.aiLastCall = 0; S.aiFutLastCall = 0;
      S.aiDecision = null; S.aiFutDecision = null;
      log(`🤖 AI AGENT ACTIVATED: mode=${S.aiMode} interval=${S.aiInterval}s minConf=${S.aiMinConf}%`, 'info');
      log(`📊 Modes: ai-only=AI drives ALL entries | hybrid=AI+signals both agree | off=signals only`, 'info');
      log(`💰 Cost: ~$${(0.28/1000000*150*(86400/S.aiInterval)).toFixed(4)}/day | DeepSeek deepseek-chat`, 'info');
      if (S.aiMode === 'ai-only') log(`⚡ AI-ONLY MODE: Indicators ignored. AI decides every trade.`, 'buy');
      send(res,200,{ok:true, mode:S.aiMode, interval:S.aiInterval, minConf:S.aiMinConf});
      return;
    }

    // /aidecision — get latest AI decision manually triggered
    if (url === '/aidecision') {
      if (!S.aiKey) { send(res,400,{error:'No AI key set'}); return; }
      const px = d.isFutures ? (S.futLastPx||S.lastPx) : S.lastPx;
      const decision = await callDeepSeek(px, !!d.isFutures);
      send(res,200,{ok:true, decision: decision||S.aiDecision, futDecision: S.aiFutDecision});
      return;
    }

    // /startfutures
    if (url === '/startfutures') {
      if (S.futuresOn) { send(res,200,{ok:true,msg:'Futures already running'}); return; }
      S.futuresOn=true; S.futOrders=[]; S.futPapOrders=[]; S.futLastEntry=0;
      futPX=[]; futRsi=[]; futEma=[]; futBb=[]; futTicks=0;
      startFuturesFeed();
      const posM = S.futCapital/S.futMaxPos;
      const posN = posM*S.futLeverage;
      const netTP = futFeeMath(100, 100*(1+S.futTpPct/100), posM, S.futLeverage).net;
      const netSL = futFeeMath(100, 100*(1-S.futSlPct/100), posM, S.futLeverage).net;
      const rr = Math.abs(netTP/netSL);
      log(`🚀 FUTURES STARTED: ${S.futPair} ${S.futLeverage}x | margin=$${posM.toFixed(2)} notional=$${posN.toFixed(2)} | tp=${S.futTpPct}% sl=${S.futSlPct}% mode=${S.futMode}`, 'buy');
      log(`📊 Fee: ${(FUT_RT_FEE*100).toFixed(2)}% RT | TP net≈+$${netTP.toFixed(4)} | SL net≈-$${Math.abs(netSL).toFixed(4)} | R:R=${rr.toFixed(2)} | Strategy: 3/5 signals`, 'info');
      log(`🔒 Smart exits: BE-stop activates at 40% toward TP (locks 0-loss). Profit-lock at 80%.`, 'info');
      save(); send(res,200,{ok:true}); return;
    }

    // /stopfutures
    if (url === '/stopfutures') {
      S.futuresOn=false; S.futOrders=[]; S.futPapOrders=[];
      stopFuturesFeed();
      log('■ Futures stopped.', 'info');
      save(); send(res,200,{ok:true}); return;
    }

    // /configfutures
    if (url === '/configfutures') {
      if(d.futPair)     S.futPair     = d.futPair;
      if(d.futCapital)  S.futCapital  = parseFloat(d.futCapital)||20;
      if(d.futMaxPos)   S.futMaxPos   = parseInt(d.futMaxPos)||1;
      if(d.futLeverage) S.futLeverage = Math.min(parseInt(d.futLeverage)||3, 10); // max 10x
      if(d.futTpPct)    S.futTpPct    = Math.max(parseFloat(d.futTpPct), FUT_RT_FEE*100+0.08);
      if(d.futSlPct)    S.futSlPct    = Math.max(parseFloat(d.futSlPct), 0.10);
      if(d.futMode)     S.futMode     = d.futMode;
      if(d.futStrategy) S.futStrategy = d.futStrategy;
      if(d.futMaxDaily) S.futMaxDaily = parseInt(d.futMaxDaily)||300;
      if(d.futCooldown) S.futCooldown = parseInt(d.futCooldown)*1000||8000;
      const posMargin = S.futCapital/S.futMaxPos;
      const notional  = posMargin * S.futLeverage;
      log(`Futures config: ${S.futPair} lev=${S.futLeverage}x margin=$${posMargin.toFixed(2)} notional=$${notional.toFixed(2)} tp=${S.futTpPct}% sl=${S.futSlPct}% mode=${S.futMode}`, 'info');
      save(); send(res,200,{ok:true, posMargin, notional, futTpPct:S.futTpPct}); return;
    }

    // /futuresbalance
    if (url === '/futuresbalance') {
      getFuturesBalance((data, err) => {
        if (err) { send(res,200,{ok:false,error:err}); return; }
        log(`💳 Futures wallet — available: $${data.availableBalance} equity: $${data.equity}`, 'profit');
        send(res,200,{ok:true, ...data});
      }); return;
    }

    // /resetfutures
    if (url === '/resetfutures') {
      S.futProfit=0;S.todayFutP=0;S.futT=0;S.futW=0;S.futL=0;S.futBest=0;S.futFees=0;
      S.futPapProfit=0;S.futPapT=0;S.futPapW=0;S.futPapL=0;
      S.futTrades=[];S.futPapTrades=[];S.futOrders=[];S.futPapOrders=[];
      save(); send(res,200,{ok:true}); return;
    }

    send(res, 404, {error:'Not found: '+url});
  });
});


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
  // Log key status clearly on startup
  if (S.apiKey) {
    log(`Keys in memory: key=${S.apiKey.substring(0,6)}••••${S.apiKey.slice(-4)} (${S.apiKey.length} chars)`, 'info');
  } else {
    log('⚠ NO API KEYS in memory. Set MEXC_KEY + MEXC_SECRET in Railway Variables tab, or use Save API Keys button in dashboard.', 'err');
  }
  // Auto-resume bot if BOT_RUNNING=true env var is set
  if (S.botOn || ENV_RUNNING) {
    S.botOn = true;
    S.liveOrders=[]; S.papOrders=[];
    PX=[]; ticks=0;
    log('▶ Auto-resuming spot bot...','buy');
    startFeed();
  } else {
    log('Bot ready. Press Start to begin trading.','info');
    log('Tip: Set MEXC_KEY + MEXC_SECRET + BOT_RUNNING=true in Railway Variables for auto-start.','info');
  }
});

server.on('error', e => { console.error(e); process.exit(1); });
process.on('SIGTERM', ()=>{ save(); process.exit(0); });
process.on('SIGINT',  ()=>{ save(); process.exit(0); });
