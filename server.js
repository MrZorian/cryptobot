'use strict';
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');

// ── ENV ──────────────────────────────────────────────────────────────────────
const PORT       = parseInt(process.env.PORT||'3000');
const BOT_PIN    = process.env.BOT_PIN||'123456';
const ENV_KEY    = (process.env.MEXC_KEY   ||'').trim();
const ENV_SECRET = (process.env.MEXC_SECRET||'').trim();

console.log('=== CryptoBot Pro v10 ===');
console.log('Port:',PORT);

// ── GLOBAL ERROR HANDLERS — prevent Railway crashes ───────────────────────────
process.on('uncaughtException', function(err){
  console.error('[CRASH PREVENTED] uncaughtException:', err.message, err.stack);
});
process.on('unhandledRejection', function(reason, promise){
  console.error('[CRASH PREVENTED] unhandledRejection:', reason);
});

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const FUT_TAKER   = 0.0002;      // 0.02% per side
const SPOT_TAKER  = 0.0005;      // 0.05% per side
const STATE_FILE  = './bot_state.json';
const KEYS_FILE   = './bot_keys.enc';
// MEXC BTC_USDT perpetual: 1 contract = 0.0001 BTC face value
// From screenshot: vol=1 gave 0.0002 BTC → likely contract=0.0001 with 2 placed
// We'll use 0.0001 BTC per lot as MEXC standard
const MEXC_LOT_BTC = 0.0001;

// ── STATE ────────────────────────────────────────────────────────────────────
let S = {
  // Spot
  botOn:false, mode:'paper', pair:'BTCUSDT',
  capital:20, maxPos:1, tpPct:0.45, slPct:0.25, cooldown:8000,
  apiKey:ENV_KEY, apiSecret:ENV_SECRET,
  liveProfit:0, liveT:0, liveW:0, liveL:0, bestT:0, feesT:0,
  papProfit:0,  papT:0,  papW:0,  papL:0,  papBest:0, papFees:0,
  liveOrders:[], papOrders:[], liveTrades:[], papTrades:[],
  log:[], prices:{}, lastPx:0, lastEntry:0,
  // Futures — CRT only, AI-controlled
  futuresOn:false, futMode:'paper', futPair:'BTC_USDT',
  futCapital:20, futMaxPos:1, futLeverage:3,
  futTpPct:0.35, futSlPct:0.18, futCooldown:6000,
  futProfit:0, futT:0, futW:0, futL:0, futBest:0, futFees:0,
  futPapProfit:0, futPapT:0, futPapW:0, futPapL:0,
  futOrders:[], futPapOrders:[], futTrades:[], futPapTrades:[],
  futLastPx:0, futLastEntry:0, futRealBalance:0,
  // CRT engine
  crtCandleSize:40, crtCandles:[], crtCurrentCandle:null,
  crtLastSignal:null, crtStats:{setups:0,confirmed:0,entered:0},
  // AI
  aiKey:'', aiMinConf:65, aiInterval:20,
  aiFutDecision:null, aiLastCall:0, aiFutLastCall:0,
  aiCallCount:0, aiTokensUsed:0, aiCost:0,
  // Compounding
  compoundEnabled:false, compoundPct:100,
  futBaseCapital:20, futCompounded:0,
  // Sync
  lastSyncResult:null,
  // Ghost trade prevention
  lastCrtSig:'',          // signature of last entered CRT (direction+sweep level)
  lastCrtSigTime:0,       // when that signal was entered
  lastCrtCandle:null,     // which candle's H/L was swept — skip repeats
  // Misc
  startedAt:null, savedAt:null, mexcBalance:null,
};

// ── LOCKS — prevent concurrent ghost trades ───────────────────────────────────
let futTickBusy = false;
let futEntering = false;

// ── PRICE BUFFERS ────────────────────────────────────────────────────────────
let PX=[], futPX=[], ticks=0, futTicks=0;

// ── SAVE / LOAD ───────────────────────────────────────────────────────────────
function save(){
  try{ S.savedAt=new Date().toISOString(); fs.writeFileSync(STATE_FILE,JSON.stringify(S)); }catch(e){}
}
function load(){
  try{
    if(!fs.existsSync(STATE_FILE))return;
    const d=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    S=Object.assign({},S,d,{
      liveOrders:[],papOrders:[],futOrders:[],futPapOrders:[],
      crtCandles:[],crtCurrentCandle:null,crtLastSignal:null,
    });
    log('State loaded. Live=$'+S.liveProfit.toFixed(4)+' Fut=$'+S.futProfit.toFixed(4),'info');
  }catch(e){log('State load err: '+e.message,'err');}
}
function saveKeys(k,s){
  try{
    const salt=crypto.randomBytes(16),iv=crypto.randomBytes(16);
    const key=crypto.scryptSync(BOT_PIN+'v9',salt,32);
    const c=crypto.createCipheriv('aes-256-cbc',key,iv);
    const enc=Buffer.concat([c.update(JSON.stringify({k,s}),'utf8'),c.final()]);
    fs.writeFileSync(KEYS_FILE,JSON.stringify({salt:salt.toString('hex'),iv:iv.toString('hex'),enc:enc.toString('hex')}));
  }catch(e){log('Key save err: '+e.message,'err');}
}
function loadKeys(){
  try{
    if(!fs.existsSync(KEYS_FILE))return;
    const f=JSON.parse(fs.readFileSync(KEYS_FILE,'utf8'));
    const key=crypto.scryptSync(BOT_PIN+'v9',Buffer.from(f.salt,'hex'),32);
    const d=crypto.createDecipheriv('aes-256-cbc',key,Buffer.from(f.iv,'hex'));
    const dec=Buffer.concat([d.update(Buffer.from(f.enc,'hex')),d.final()]);
    const {k,s}=JSON.parse(dec.toString('utf8'));
    if(k)S.apiKey=k; if(s)S.apiSecret=s;
    if(k)log('API keys loaded from encrypted storage','info');
  }catch(e){log('Key load err: '+e.message,'err');}
}
setInterval(save,8000);
function log(msg,type){
  type=type||'info';
  const ts=new Date().toISOString().slice(11,19);
  S.log.unshift({ts,msg,type});
  if(S.log.length>500)S.log.length=500;
  console.log('['+ts+']['+type+'] '+msg);
}

// ── INDICATORS ───────────────────────────────────────────────────────────────
function calcRSI(arr,n){
  n=n||14; if(arr.length<n+1)return 50;
  const sl=arr.slice(-(n+1)); let g=0,l=0;
  for(let i=1;i<sl.length;i++){const d=sl[i]-sl[i-1];if(d>0)g+=d;else l-=d;}
  const ag=g/n,al=l/n; return al===0?100:100-(100/(1+ag/al));
}
function calcEMA(arr,n){
  if(!arr.length)return 0;
  if(arr.length<n)return arr[arr.length-1];
  const k=2/(n+1); let e=arr.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for(let i=n;i<arr.length;i++)e=arr[i]*k+e*(1-k); return e;
}
function calcBB(arr,n){
  n=n||20; if(arr.length<n)return null;
  const sl=arr.slice(-n),m=sl.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-m)*(b-m),0)/n);
  return {upper:m+2*sd,middle:m,lower:m-2*sd};
}

// ── P&L MATH ─────────────────────────────────────────────────────────────────
function spotFee(entryPx,exitPx,amt){
  const qty=amt/entryPx,proceeds=qty*exitPx,fee=amt*SPOT_TAKER+proceeds*SPOT_TAKER;
  return {fee,net:proceeds-amt-fee,qty};
}
function spotMinTP(entryPx,amt){
  const qty=amt/entryPx;
  return (amt*(1+SPOT_TAKER))/(qty*(1-SPOT_TAKER))*1.0012;
}
// Correct MEXC futures P&L calculation
// contracts = actual BTC held = lots × MEXC_LOT_BTC
// pnl = (exitPx - entryPx) × contracts  (positive for longs going up)
// fee = (entryPx × contracts + exitPx × contracts) × FUT_TAKER
function futCalcPnl(entryPx,exitPx,lots,isLong){
  const contracts = lots * MEXC_LOT_BTC;          // actual BTC
  const rawPnl    = (exitPx-entryPx)*contracts;
  const pnl       = isLong===false ? -rawPnl : rawPnl;
  const entryFee  = entryPx * contracts * FUT_TAKER;
  const exitFee   = exitPx  * contracts * FUT_TAKER;
  const fee       = entryFee + exitFee;
  const notional  = entryPx * contracts;          // real notional = price × contracts
  const margin    = notional / S.futLeverage;
  return {pnl, fee, net:pnl-fee, contracts, notional, margin, lots};
}
// Calculate how many MEXC lots needed for a target notional
function calcLots(targetNotional, px){
  const lotsNeeded = targetNotional / (MEXC_LOT_BTC * px);
  return Math.max(1, Math.round(lotsNeeded));
}
// Break-even price for a position
function futBE(entryPx,lots,isLong){
  const contracts=lots*MEXC_LOT_BTC;
  const fee=entryPx*contracts*FUT_TAKER;      // entry fee
  // At break-even: (bePx-entryPx)*contracts - bePx*contracts*FUT_TAKER = entryFee
  // Solving: bePx = entryPx/(1-FUT_TAKER) for longs (approx)
  return isLong===false
    ? entryPx*(1-FUT_TAKER*2)
    : entryPx*(1+FUT_TAKER*2);
}

// ── CRT ENGINE ────────────────────────────────────────────────────────────────
function crtUpdateCandle(px){
  if(!S.crtCurrentCandle){S.crtCurrentCandle={o:px,h:px,l:px,c:px,ticks:1};return;}
  const c=S.crtCurrentCandle;
  c.h=Math.max(c.h,px); c.l=Math.min(c.l,px); c.c=px; c.ticks++;
  if(c.ticks>=S.crtCandleSize){
    S.crtCandles.unshift(Object.assign({},c));
    if(S.crtCandles.length>50)S.crtCandles.length=50;
    S.crtCurrentCandle={o:px,h:px,l:px,c:px,ticks:1};
    // Reset signature — allow fresh entries on next candle
    S.lastCrtSig=''; S.lastCrtSigTime=0;
    const prev=S.crtCandles[0];
    if(prev)log('[CRT] Candle #'+S.crtCandles.length+' H=$'+prev.h.toFixed(2)+' L=$'+prev.l.toFixed(2)+' range='+(((prev.h-prev.l)/prev.l)*100).toFixed(3)+'%','info');
  }
}

function crtDetect(px){
  // Need at least 1 completed candle to use as reference
  if(!S.crtCandles.length||!S.crtCurrentCandle)return null;
  const prev = S.crtCandles[0];   // most recent COMPLETED candle
  const curr = S.crtCurrentCandle; // candle currently forming

  const prevRange    = prev.h - prev.l;
  const prevRangePct = prevRange / prev.l * 100;

  // Need minimum candle range to be worth trading
  if(prevRangePct < 0.010) return null;

  // Sweep buffer: 6% of range OR 0.004% of price (whichever is smaller avoidance)
  const sweepBuf = Math.max(prevRange * 0.06, prev.l * 0.00004);
  const minRR    = 0.70; // relaxed — high CRT win rate compensates

  // ── BULLISH CRT ──────────────────────────────────────────────────────────
  // Current candle swept BELOW prev.low (stop hunt below support)
  // Price has now rejected back ABOVE prev.low (reversal confirmed)
  if(curr.l < prev.l - sweepBuf && px > prev.l){
    const sweepD = (prev.l - curr.l) / prev.l * 100;
    if(sweepD < 0.001) return null;
    const tp  = parseFloat(prev.h.toFixed(2));
    const sl  = parseFloat((curr.l - sweepBuf * 0.15).toFixed(2));
    const tpD = (tp - px) / px * 100;
    const slD = (px - sl) / px * 100;
    const rr  = slD > 0 ? tpD / slD : 0;
    if(rr < minRR || tp <= px) return null;
    S.crtStats.setups++;
    return {
      direction:'BUY', type:'BULLISH_CRT',
      sweepDepth:sweepD.toFixed(4), sweepLow:curr.l, sweepHigh:null,
      entry:px, tp:tp, sl:sl,
      tpPct:parseFloat(tpD.toFixed(4)), slPct:parseFloat(slD.toFixed(4)),
      rr:parseFloat(rr.toFixed(2)), prevRange:prevRangePct.toFixed(4),
      prevHigh:prev.h, prevLow:prev.l,
      reason:'BULLISH CRT: swept $'+curr.l.toFixed(2)+' below prev.L $'+prev.l.toFixed(2)+
             ' | entry=$'+px.toFixed(2)+' TP=$'+tp.toFixed(2)+' SL=$'+sl.toFixed(2)+
             ' R:R='+rr.toFixed(2)+'x'
    };
  }

  // ── BEARISH CRT ──────────────────────────────────────────────────────────
  // Current candle swept ABOVE prev.high (stop hunt above resistance)
  // Price has now rejected back BELOW prev.high (reversal confirmed)
  if(curr.h > prev.h + sweepBuf && px < prev.h){
    const sweepDB = (curr.h - prev.h) / prev.h * 100;
    if(sweepDB < 0.001) return null;
    const tpB  = parseFloat(prev.l.toFixed(2));
    const slB  = parseFloat((curr.h + sweepBuf * 0.15).toFixed(2));
    const tpDB = (px - tpB) / px * 100;
    const slDB = (slB - px) / px * 100;
    const rrB  = slDB > 0 ? tpDB / slDB : 0;
    if(rrB < minRR || tpB >= px) return null;
    S.crtStats.setups++;
    return {
      direction:'SHORT', type:'BEARISH_CRT',
      sweepDepth:sweepDB.toFixed(4), sweepLow:null, sweepHigh:curr.h,
      entry:px, tp:tpB, sl:slB,
      tpPct:parseFloat(tpDB.toFixed(4)), slPct:parseFloat(slDB.toFixed(4)),
      rr:parseFloat(rrB.toFixed(2)), prevRange:prevRangePct.toFixed(4),
      prevHigh:prev.h, prevLow:prev.l,
      reason:'BEARISH CRT: swept $'+curr.h.toFixed(2)+' above prev.H $'+prev.h.toFixed(2)+
             ' | entry=$'+px.toFixed(2)+' TP=$'+tpB.toFixed(2)+' SL=$'+slB.toFixed(2)+
             ' R:R='+rrB.toFixed(2)+'x'
    };
  }
  return null;
}

// ── DEEPSEEK AI — CRT CONFIRMATION + TP/SL ───────────────────────────────────
async function callDeepSeek(prompt){
  if(!S.aiKey)return null;
  try{
  return new Promise(resolve=>{
    const body=JSON.stringify({
      model:'deepseek-chat',
      messages:[
        {role:'system',content:'You are a professional crypto futures trader. Respond ONLY with valid JSON. No text outside JSON.'},
        {role:'user',content:prompt}
      ],
      max_tokens:200, temperature:0.1, stream:false
    });
    const req=https.request({
      hostname:'api.deepseek.com',path:'/v1/chat/completions',method:'POST',
      headers:{'Authorization':'Bearer '+S.aiKey,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
      timeout:12000
    },res=>{
      let d=''; res.on('data',c=>d+=c);
      res.on('end',()=>{
        try{
          const r=JSON.parse(d);
          if(r.error){log('AI err: '+r.error.message,'err');resolve(null);return;}
          const raw=(r.choices&&r.choices[0]&&r.choices[0].message&&r.choices[0].message.content)||'{}';
          S.aiTokensUsed+=(r.usage&&r.usage.total_tokens||0);
          S.aiCost=parseFloat((S.aiTokensUsed/1000000*0.28).toFixed(6));
          S.aiCallCount++;
          const m=raw.match(/\{[\s\S]*\}/);
          resolve(m?JSON.parse(m[0]):null);
        }catch(e){resolve(null);}
      });
    });
    req.on('error',()=>resolve(null));
    req.on('timeout',()=>{req.destroy();resolve(null);});
    req.write(body); req.end();
  });
  }catch(e){console.error('callDeepSeek err:',e.message);return null;}
}

async function aiConfirmCRT(px,crt){
  // STRICT: AI confirmation is MANDATORY. No fallbacks. No trades without AI.
  if(!S.aiKey){
    log('CRT BLOCKED: No DeepSeek API key. Add key in AI Brain tab first.','err');
    return {confirmed:false,tp:0,sl:0,confidence:0,reason:'No AI key'};
  }
  const raw=futPX.filter(v=>v>0); const n=raw.length;
  const r14=n>2?calcRSI(raw,Math.min(14,n-1)):50;
  const r9 =n>2?calcRSI(raw,Math.min(9,n-1)) :50;
  const e9 =n>0?calcEMA(raw,Math.min(9,n))   :px;
  const e21=n>0?calcEMA(raw,Math.min(21,n))  :px;
  const bb =n>=10?calcBB(raw,Math.min(20,n)) :null;
  const hi10=n>0?Math.max.apply(null,raw.slice(-Math.min(10,n))):px;
  const lo10=n>0?Math.min.apply(null,raw.slice(-Math.min(10,n))):px;
  const ch1=n>1?((px-raw[n-2])/raw[n-2]*100).toFixed(3):'0';
  const trend=e9>e21*1.0002?'UPTREND':e9<e21*0.9998?'DOWNTREND':'SIDEWAYS';
  const bbPos=bb?(px<=bb.lower*1.002?'AT_SUPPORT':px>=bb.upper*0.998?'AT_RESISTANCE':px<bb.middle?'LOWER_HALF':'UPPER_HALF'):'UNKNOWN';
  const streak=S.futTrades.slice(0,3).filter(function(t){return t.net<0;}).length;
  const wr=S.futT>0?Math.round(S.futW/S.futT*100):0;
  const lots=calcLots((S.futCapital/S.futMaxPos)*S.futLeverage,px);
  const notional=lots*MEXC_LOT_BTC*px;
  const recent=S.futTrades.slice(0,5).map(function(t){return t.direction+' '+t.side+(t.net>=0?'+':'')+t.net.toFixed(3);}).join(', ')||'none';

  var p='';
  p+='=== MANDATORY CRT TRADE REVIEW ===\n';
  p+='You are the ONLY decision maker. Trade executes ONLY if you confirm.\n';
  p+='Set EXACT TP and SL price levels that maximize profit.\n\n';
  p+='=== CRT SETUP ===\n';
  p+='Type: '+crt.type+' | Direction: '+crt.direction+(crt.direction==='BUY'?' (LONG)':' (SHORT)')+'\n';
  p+='Entry: $'+px.toFixed(2)+'\n';
  p+='Prev candle: H=$'+(S.crtCandles[0]?S.crtCandles[0].h.toFixed(2):'?')+' L=$'+(S.crtCandles[0]?S.crtCandles[0].l.toFixed(2):'?')+' Range='+crt.prevRange+'%\n';
  p+='Sweep: '+crt.sweepDepth+'% beyond level\n';
  p+='CRT levels: TP=$'+crt.tp.toFixed(2)+' (+'+crt.tpPct+'%) SL=$'+crt.sl.toFixed(2)+' (-'+crt.slPct+'%) R:R='+crt.rr+'x\n\n';
  p+='=== POSITION ===\n';
  p+='Lots: '+lots+' ('+MEXC_LOT_BTC+' BTC/lot) | Notional: $'+notional.toFixed(2)+' | Leverage: '+S.futLeverage+'x\n';
  p+='RT fee: $'+(notional*FUT_TAKER*2).toFixed(4)+' | Min TP to profit: fee+0.1% move\n\n';
  p+='=== MARKET ===\n';
  p+='Price: $'+px.toFixed(2)+' | Trend: '+trend+' | BB: '+bbPos+'\n';
  p+='RSI14='+r14.toFixed(1)+' RSI9='+r9.toFixed(1)+' | ch1='+ch1+'%\n';
  p+='EMA9=$'+e9.toFixed(2)+' EMA21=$'+e21.toFixed(2)+'\n';
  if(bb)p+='BB: L=$'+bb.lower.toFixed(2)+' M=$'+bb.middle.toFixed(2)+' H=$'+bb.upper.toFixed(2)+'\n';
  p+='10-tick: $'+lo10.toFixed(2)+'-$'+hi10.toFixed(2)+'\n\n';
  p+='=== ACCOUNT ===\n';
  p+='P&L: $'+S.futProfit.toFixed(4)+' | WR: '+wr+'% ('+S.futW+'W/'+S.futL+'L) | Loss streak: '+streak+'\n';
  p+='Recent: '+recent+'\n\n';
  p+='=== CONFIRM WHEN ===\n';
  p+='- BUY: RSI<60, AT_SUPPORT or LOWER_HALF, bounce confirmed, R:R>=1.0\n';
  p+='- SHORT: RSI>40, AT_RESISTANCE or UPPER_HALF, rejection confirmed, R:R>=1.0\n';
  p+='- Sweep clean (>0.005%), trend supports or neutral\n\n';
  p+='=== REJECT WHEN ===\n';
  p+='- BUY: RSI>70 (overbought), strong DOWNTREND, AT_RESISTANCE\n';
  p+='- SHORT: RSI<30 (oversold), strong UPTREND, AT_SUPPORT\n';
  p+='- Loss streak=3 AND confidence<75%, sweep<0.003%\n\n';
  p+='=== SET EXACT PRICES ===\n';
  p+='TP = price where you take profit (CRT target = opposite side of candle)\n';
  p+='SL = price where you stop loss (just beyond the sweep wick)\n';
  p+='Both must be valid: LONG needs TP>entry>SL, SHORT needs TP<entry<SL\n\n';
  p+='Reply ONLY with JSON (confirmed=false means trade is skipped):\n';
  p+='{"confirmed":true,"tp":103250.50,"sl":102780.00,"confidence":82,"reason":"brief reason","risk":"low"}\n';
  p+='{"confirmed":false,"tp":0,"sl":0,"confidence":30,"reason":"RSI overbought reject","risk":"high"}';

  log('Asking DeepSeek AI to review CRT setup...','info');
  var dec=await callDeepSeek(p);

  if(!dec){
    log('AI TIMEOUT — CRT trade SKIPPED (no fallback in strict mode)','err');
    S.aiFutDecision={action:crt.direction,confirmed:false,confidence:0,reason:'AI timeout - trade skipped',ts:new Date().toISOString().slice(11,19),price:px};
    return {confirmed:false,tp:0,sl:0,confidence:0,reason:'AI timeout'};
  }

  var aiTp=parseFloat(dec.tp||0),aiSl=parseFloat(dec.sl||0);
  var aiConf=parseInt(dec.confidence||0),aiOk=!!dec.confirmed;
  var isLng=crt.direction==='BUY';

  // Validate AI-provided TP/SL make sense for the direction
  if(aiOk){
    if(aiTp<=0||aiSl<=0){log('AI confirmed but invalid TP/SL prices — SKIPPING','err');aiOk=false;dec.reason='AI gave no valid TP/SL';}
    if(isLng&&aiTp<=px){log('AI TP $'+aiTp+' <= entry $'+px.toFixed(2)+' for LONG — SKIPPING','err');aiOk=false;dec.reason='TP below entry for LONG';}
    if(!isLng&&aiTp>=px){log('AI TP $'+aiTp+' >= entry $'+px.toFixed(2)+' for SHORT — SKIPPING','err');aiOk=false;dec.reason='TP above entry for SHORT';}
    if(isLng&&aiSl>=px){log('AI SL $'+aiSl+' >= entry $'+px.toFixed(2)+' for LONG — SKIPPING','err');aiOk=false;dec.reason='SL above entry for LONG';}
    if(!isLng&&aiSl<=px){log('AI SL $'+aiSl+' <= entry $'+px.toFixed(2)+' for SHORT — SKIPPING','err');aiOk=false;dec.reason='SL below entry for SHORT';}
  }

  S.aiFutDecision={action:crt.direction,confirmed:aiOk,confidence:aiConf,reason:dec.reason||'',
    risk:dec.risk||'med',tp:aiTp,sl:aiSl,crtType:crt.type,sweepDepth:crt.sweepDepth,rr:crt.rr,
    ts:new Date().toISOString().slice(11,19),price:px};
  S.aiFutLastCall=Date.now(); S.aiCallCount++;

  log('DeepSeek: '+(aiOk?'CONFIRMED':'REJECTED')+' conf='+aiConf+'% | '+dec.reason,'info');
  return {confirmed:aiOk,tp:parseFloat(aiTp.toFixed(4)),sl:parseFloat(aiSl.toFixed(4)),confidence:aiConf,reason:dec.reason||''};
}


// AI sets TP/SL for synced positions
async function aiSetTpSlForPosition(o){
  if(!S.aiKey)return;
  const px=S.futLastPx||S.lastPx; if(!px)return;
  const isLng=o.direction!=='SHORT';
  const r=futCalcPnl(o.entryPx,px,o.lots||1,isLng);
  let p='Set TP and SL for this open MEXC futures position. JSON only.\n\n';
  p+='Direction: '+o.direction+' | Entry: $'+o.entryPx.toFixed(2)+' | Current: $'+px.toFixed(2)+'\n';
  p+='Lots: '+(o.lots||1)+' | Notional: $'+r.notional.toFixed(2)+' | Leverage: '+o.leverage+'x\n';
  p+='Current P&L: '+(r.pnl>=0?'+':'')+'$'+r.pnl.toFixed(4)+' | Net: '+(r.net>=0?'+':'')+'$'+r.net.toFixed(4)+'\n';
  p+='Fee: $'+r.fee.toFixed(4)+' | MEXC fee rate: 0.02% per side\n\n';
  p+='Rules: TP must give profit > fee. If in profit set SL above entry. Max SL distance 0.5% from entry.\n';
  p+='{"tp":103250.50,"sl":102800.00,"reason":"brief reason"}';
  const dec=await callDeepSeek(p);
  if(dec&&dec.tp>0){o.tp=parseFloat(dec.tp.toFixed(4));}
  if(dec&&dec.sl>0){o.sl=parseFloat(dec.sl.toFixed(4));}
  if(dec)log('AI set TP=$'+o.tp.toFixed(2)+' SL=$'+o.sl.toFixed(2)+' | '+dec.reason,'profit');
  save();
}

// ── EXIT CHECKS ───────────────────────────────────────────────────────────────
function futExitCheck(px,isPaper){
  const orders=isPaper?S.futPapOrders:S.futOrders;
  let changed=false;
  orders.forEach(o=>{
    if(o.status!=='open')return;
    const isLng=o.direction!=='SHORT';
    const r=futCalcPnl(o.entryPx,px,o.lots||1,isLng);
    // Track peak raw pnl (matches MEXC display)
    if(r.pnl>(o.peakPnl||0))o.peakPnl=r.pnl;
    // Profit protection: gave back 60% of peak while still positive
    if((o.peakPnl||0)>r.fee*2&&r.pnl>0&&(o.peakPnl-r.pnl)/o.peakPnl>=0.60){
      closeFut(o,px,'PROTECT',isPaper); changed=true; return;
    }
    // BE-stop: at 40% toward TP, move SL to break-even
    if(!o.beStopMoved&&isLng){
      const pct=(o.tp-o.entryPx)>0?(px-o.entryPx)/(o.tp-o.entryPx):0;
      if(pct>=0.40){const be=futBE(o.entryPx,o.lots||1,isLng);if(be>o.sl){o.sl=parseFloat(be.toFixed(4));o.beStopMoved=true;log('BE-stop moved to $'+o.sl.toFixed(2),'info');}}
    }
    // TP / SL
    let why=null;
    if(isLng){if(px>=o.tp)why='TP';else if(px<=o.sl)why=o.beStopMoved?'BE-STOP':'SL';}
    else{if(px<=o.tp)why='TP';else if(px>=o.sl)why=o.beStopMoved?'BE-STOP':'SL';}
    if(!why)return;
    closeFut(o,px,why,isPaper); changed=true;
  });
  if(changed){
    if(isPaper)S.futPapOrders=S.futPapOrders.filter(o=>o.status==='open');
    else S.futOrders=S.futOrders.filter(o=>o.status==='open');
    save();
  }
}

function closeFut(o,px,why,isPaper){
  const isLng=o.direction!=='SHORT';
  const r=futCalcPnl(o.entryPx,px,o.lots||1,isLng);
  o.status='closed';
  const movePct=((px-o.entryPx)/o.entryPx*100).toFixed(3);
  const tr={n:isPaper?++S.futPapT:++S.futT,time:new Date().toISOString().slice(11,19),
    pair:S.futPair,direction:o.direction,isPaper,side:why,crtType:o.crtType||'',rr:o.crtRR||0,
    entryPx:o.entryPx,exitPx:px,lots:o.lots||1,notional:r.notional,
    leverage:o.leverage,move:movePct+'%',
    fee:+r.fee.toFixed(6),pnl:+r.pnl.toFixed(6),net:+r.net.toFixed(6)};
  if(isPaper){
    S.futPapProfit+=r.net; S.futFees+=r.fee;
    if(r.net>=0)S.futPapW++;else S.futPapL++;
    S.futPapTrades.unshift(tr); if(S.futPapTrades.length>200)S.futPapTrades.length=200;
  }else{
    S.futProfit+=r.net; S.futFees+=r.fee;
    if(r.net>=0){S.futW++;if(r.net>S.futBest)S.futBest=r.net;}else S.futL++;
    S.futTrades.unshift(tr); if(S.futTrades.length>200)S.futTrades.length=200;
    futPlaceOrder(isLng?'close_long':'close_short',o.lots||1,px);
    // Compounding: add profit to capital
    if(S.compoundEnabled&&r.net>0){
      const reinvest=parseFloat((r.net*(S.compoundPct/100)).toFixed(4));
      S.futCapital=parseFloat((S.futCapital+reinvest).toFixed(4));
      S.futCompounded=parseFloat((S.futCompounded+reinvest).toFixed(4));
      log('COMPOUND +$'+reinvest.toFixed(4)+' → capital=$'+S.futCapital.toFixed(4),'profit');
    }
  }
  log((isPaper?'PAP ':'LIVE ')+o.direction+' '+why+' @ $'+px.toFixed(2)+
    ' lots='+( o.lots||1)+' notional=$'+r.notional.toFixed(2)+
    ' pnl='+(r.pnl>=0?'+':'')+'$'+r.pnl.toFixed(4)+
    ' net='+(r.net>=0?'+':'')+'$'+r.net.toFixed(4), r.net>=0?'profit':'err');
}

// ── FUTURES TICK ────────────────────────────────────────────────────────────────
// ARCHITECTURE: Exit checks + candle updates run on EVERY tick (never blocked).
// Entry detection runs only when AI is NOT busy (futEntering=false).
async function onFutTick(px){
  try{
    // ── STEP 1: ALWAYS update price buffer, candle, check exits ─────────────
    S.futLastPx=px;
    futPX.push(px); if(futPX.length>300)futPX.shift();
    futTicks++;
    if(!S.futuresOn)return;
    crtUpdateCandle(px);      // build OHLC candle
    futExitCheck(px,true);    // check paper position exits
    futExitCheck(px,false);   // check live position exits

    // ── STEP 2: ENTRY DETECTION (skip if AI busy or too soon) ───────────────
    if(futTicks<5)return;
    if(futEntering)return;    // AI is running — don't overlap
    const now=Date.now();
    if(now-S.futLastEntry<(S.futCooldown||6000))return;

    // Skip if all position slots full
    const papOpen=S.futPapOrders.filter(function(o){return o.status==='open';}).length;
    const liveOpen=S.futOrders.filter(function(o){return o.status==='open';}).length;
    if(papOpen>=S.futMaxPos && liveOpen>=S.futMaxPos)return;

    // ── STEP 3: CRT DETECTION ────────────────────────────────────────────────
    const crt=crtDetect(px);
    if(!crt){
      if(futTicks%40===0){
        const p=S.crtCandles[0],c=S.crtCurrentCandle;
        if(p&&c) log('[CRT T'+futTicks+'] $'+px.toFixed(2)+
          ' prevH=$'+p.h.toFixed(2)+' prevL=$'+p.l.toFixed(2)+
          ' currH=$'+c.h.toFixed(2)+' currL=$'+c.l.toFixed(2)+
          ' tick='+c.ticks+'/'+S.crtCandleSize+
          ' candles='+S.crtCandles.length+' setups='+S.crtStats.setups,'info');
        else log('[CRT T'+futTicks+'] $'+px.toFixed(2)+' warming up: '+S.crtCandles.length+' candles (need 1+)','info');
      }
      return;
    }

    // ── STEP 4: GHOST TRADE PREVENTION ───────────────────────────────────────
    // Use FIXED prev.h/prev.l as signature (stable — don't use curr.l/curr.h
    // which change every tick and would re-fire the same setup 40 times)
    const crtSig=crt.direction+'_'+crt.prevHigh+'_'+crt.prevLow;
    if(S.lastCrtSig===crtSig)return;  // same setup already handled this candle
    S.lastCrtSig=crtSig;
    S.lastCrtSigTime=now;

    // Extra live position cap guard
    if(liveOpen>=S.futMaxPos && S.futMode==='live')return;

    // ── STEP 5: DEEPSEEK AI CONFIRMATION (mandatory) ─────────────────────────
    futEntering=true;       // block new entry attempts while AI thinks
    S.futLastEntry=now;
    log('CRT DETECTED: '+crt.type+
      ' @ $'+px.toFixed(2)+
      ' sweep='+crt.sweepDepth+'%'+
      ' R:R='+crt.rr+'x'+
      ' TP=$'+crt.tp+' SL=$'+crt.sl+
      ' | asking DeepSeek...','buy');

    const aiResult=await aiConfirmCRT(px,crt);

    if(!aiResult.confirmed){
      log('TRADE SKIPPED by AI: '+aiResult.reason,'info');
      S.crtLastSignal=Object.assign({},crt,{aiRejected:true,aiReason:aiResult.reason});
      return;
    }
    if(aiResult.confidence<(S.aiMinConf||65)){
      log('TRADE SKIPPED: AI conf='+aiResult.confidence+'% < min='+(S.aiMinConf||65)+'%','info');
      return;
    }

    log('TRADE CONFIRMED by DeepSeek: conf='+aiResult.confidence+
      '% TP=$'+aiResult.tp+' SL=$'+aiResult.sl+
      ' | '+aiResult.reason,'profit');
    S.crtStats.confirmed++;
    S.crtLastSignal=Object.assign({},crt,{
      aiConfirmed:true, aiConf:aiResult.confidence,
      aiTp:aiResult.tp, aiSl:aiResult.sl, aiReason:aiResult.reason
    });

    // ── STEP 6: ENTER TRADE ──────────────────────────────────────────────────
    // Re-read position counts (AI took 8-10s — old values are stale)
    const papNow  = S.futPapOrders.filter(function(o){return o.status==='open';}).length;
    const liveNow = S.futOrders.filter(function(o){return o.status==='open';}).length;

    const notional=(S.futCapital/S.futMaxPos)*S.futLeverage;
    const lots=calcLots(notional,px);
    const streak=S.futTrades.slice(0,3).filter(function(t){return t.net<0;}).length;
    const finalLots=streak>=3?Math.max(1,Math.floor(lots*0.5)):streak>=2?Math.max(1,Math.floor(lots*0.75)):lots;

    log('ENTRY: mode='+S.futMode+
      ' paper='+papNow+'/'+S.futMaxPos+
      ' live='+liveNow+'/'+S.futMaxPos+
      ' lots='+finalLots+
      ' notional=$'+(finalLots*MEXC_LOT_BTC*px).toFixed(2),'info');

    // Paper trade (always enters if slot available)
    if(papNow<S.futMaxPos){
      enterFut(px,crt,aiResult,finalLots,true);
    }else{
      log('Paper SKIPPED: '+papNow+'/'+S.futMaxPos+' positions open','info');
    }

    // Live trade
    if(S.futMode==='live'){
      if(!S.apiKey||!S.apiSecret){
        log('Live SKIPPED: no API keys — save in Config tab','err');
      }else if(liveNow>=S.futMaxPos){
        log('Live SKIPPED: '+liveNow+'/'+S.futMaxPos+' already open','info');
      }else{
        S.crtStats.entered++;
        enterFut(px,crt,aiResult,finalLots,false);
        log('LIVE ORDER placed on MEXC','profit');
      }
    }else{
      log('Live SKIPPED: mode='+S.futMode+' — click Futures Live Mode to trade real money','info');
    }
  }catch(e){
    console.error('[onFutTick error]',e.message);
  }finally{
    futEntering=false;  // always release lock
  }
}

function enterFut(px,crt,ai,lots,isPaper){
  const isLng=crt.direction!=='SHORT';
  const r=futCalcPnl(px,ai.tp,lots,isLng);  // expected profit
  const bePx=parseFloat(futBE(px,lots,isLng).toFixed(4));
  const o={
    id:Date.now()+(isPaper?1:0),status:'open',isPaper,isFutures:true,
    direction:isLng?'LONG':'SHORT',
    entryPx:px, tp:ai.tp, sl:ai.sl, bePx,
    lots, leverage:S.futLeverage,
    notional:lots*MEXC_LOT_BTC*px,
    margin:(lots*MEXC_LOT_BTC*px)/S.futLeverage,
    beStopMoved:false, peakPnl:0,
    crtType:crt.type, crtRR:crt.rr,
    openAt:new Date().toISOString().slice(11,19),
    openedAt:Date.now(),
    reason:crt.reason+' AI:'+ai.confidence+'%'
  };
  const expNet=r.net;
  log((isPaper?'CRT-PAPER ':'CRT-LIVE ')+o.direction+
    ' @ $'+px.toFixed(2)+
    ' | lots='+lots+' ('+MEXC_LOT_BTC+'BTC/lot)'+
    ' | notional=$'+(o.notional).toFixed(2)+
    ' | TP=$'+ai.tp.toFixed(2)+' SL=$'+ai.sl.toFixed(2)+
    ' | exp net=+'+(expNet>0?'$'+expNet.toFixed(4):'calculating'),'buy');
  if(isPaper){
    // Paper: check we don't exceed maxPos
    const papCount=S.futPapOrders.filter(function(x){return x.status==='open';}).length;
    if(papCount>=S.futMaxPos){log('Paper maxPos reached — skipping paper entry','info');return;}
    S.futPapOrders.push(o);
  } else {
    // Live: hard check before placing ANY MEXC order
    const liveCount=S.futOrders.filter(function(x){return x.status==='open';}).length;
    if(liveCount>=S.futMaxPos){
      log('LIVE maxPos reached — NOT placing MEXC order (ghost trade prevented)','err');
      return;
    }
    S.futOrders.push(o);
    log('Placing MEXC order: lots='+lots+' direction='+(isLng?'LONG':'SHORT'),'info');
    futPlaceOrder(isLng?'open_long':'open_short',lots,px);
  }
}

// ── SPOT TICK ────────────────────────────────────────────────────────────────
async function onSpotTick(px){
  S.lastPx=px; PX.push(px); if(PX.length>300)PX.shift(); ticks++;
  if(!S.botOn)return;
  // Spot exit checks
  [S.papOrders,S.liveOrders].forEach((orders,idx)=>{
    const isPaper=idx===0;
    orders.forEach(o=>{
      if(o.status!=='open')return;
      const r=spotFee(o.entryPx,px,o.amt);
      if(r.pnl>(o.peakPnl||0))o.peakPnl=r.pnl;
      let why=null;
      if(px>=o.tp)why='TP'; else if(px<=o.sl)why='SL';
      if((o.peakPnl||0)>o.amt*0.001&&r.net>0&&o.peakPnl>0&&(o.peakPnl-r.net)/o.peakPnl>=0.60)why='PROTECT';
      if(!why)return;
      const tr={n:isPaper?++S.papT:++S.liveT,time:new Date().toISOString().slice(11,19),
        pair:S.pair,isPaper,side:why,entryPx:o.entryPx,exitPx:px,amt:o.amt,
        fee:+r.fee.toFixed(6),net:+r.net.toFixed(6)};
      o.status='closed';
      if(isPaper){S.papProfit+=r.net;S.papFees+=r.fee;if(r.net>=0){S.papW++;if(r.net>S.papBest)S.papBest=r.net;}else S.papL++;S.papTrades.unshift(tr);}
      else{S.liveProfit+=r.net;S.feesT+=r.fee;if(r.net>=0){S.liveW++;if(r.net>S.bestT)S.bestT=r.net;}else S.liveL++;S.liveTrades.unshift(tr);placeSpotOrder('SELL',o.qty,S.pair);}
      log((isPaper?'PAP':'LIVE')+' SPOT '+why+' @ $'+px.toFixed(2)+' net='+(r.net>=0?'+':'')+'$'+r.net.toFixed(4),r.net>=0?'profit':'err');
    });
    if(isPaper)S.papOrders=S.papOrders.filter(o=>o.status==='open');
    else S.liveOrders=S.liveOrders.filter(o=>o.status==='open');
  });
  if(ticks<5)return;
  const now=Date.now(); if(now-S.lastEntry<S.cooldown)return;
  const raw=PX.filter(v=>v>0),n=raw.length;
  if(n<5)return;
  const r14=calcRSI(raw,Math.min(14,n-1));
  const e9=calcEMA(raw,Math.min(9,n)),e21=calcEMA(raw,Math.min(21,n));
  const bb=n>=10?calcBB(raw,Math.min(20,n)):null;
  const hi=Math.max(...raw.slice(-Math.min(10,n)));
  const dip=(px-hi)/hi*100;
  const ch1=n>1?(px-raw[n-2])/raw[n-2]*100:0;
  let score=0;
  if(r14<50)score++; if(dip<=-0.04)score++; if(ch1>0)score++;
  if(e9>e21*1.0002)score++; if(bb&&px<=bb.lower*1.003)score++;
  if(score<3)return;
  const papOpen=S.papOrders.filter(o=>o.status==='open').length;
  if(papOpen<S.maxPos){
    const amt=S.capital/S.maxPos;
    const tp=parseFloat(Math.max(px*(1+S.tpPct/100),spotMinTP(px,amt)).toFixed(8));
    const sl=parseFloat((px*(1-S.slPct/100)).toFixed(8));
    const o={id:Date.now()+1,status:'open',isPaper:true,strat:'auto',entryPx:px,amt,qty:amt/px,tp,sl,peakPnl:0,openAt:new Date().toISOString().slice(11,19)};
    S.papOrders.push(o);
    log('PAP SPOT BUY @ $'+px.toFixed(2)+' score='+score+'/5','buy');
  }
  if(S.mode==='live'&&S.apiKey&&S.apiSecret){
    const liveOpen=S.liveOrders.filter(o=>o.status==='open').length;
    if(liveOpen<S.maxPos){
      const amt=S.capital/S.maxPos;
      const tp=parseFloat(Math.max(px*(1+S.tpPct/100),spotMinTP(px,amt)).toFixed(8));
      const sl=parseFloat((px*(1-S.slPct/100)).toFixed(8));
      const o={id:Date.now(),status:'open',isPaper:false,strat:'auto',entryPx:px,amt,qty:amt/px,tp,sl,peakPnl:0,openAt:new Date().toISOString().slice(11,19)};
      S.liveOrders.push(o);
      log('LIVE SPOT BUY @ $'+px.toFixed(2)+' score='+score+'/5','buy');
      placeSpotOrder('BUY',o.qty,S.pair);
    }
  }
  S.lastEntry=now;
}

// ── PRICE FEEDS ───────────────────────────────────────────────────────────────
let spotTimer=null,futTimer=null,multiTimer=null,autoSyncTimer=null;

function startSpotFeed(){clearInterval(spotTimer);spotTimer=setInterval(fetchSpot,1500);fetchSpot();}
function stopSpotFeed(){clearInterval(spotTimer);spotTimer=null;}
function startFutFeed(){clearInterval(futTimer);futTimer=setInterval(fetchFut,1500);fetchFut();}
function stopFutFeed(){clearInterval(futTimer);futTimer=null;}
function startMultiFeed(){clearInterval(multiTimer);multiTimer=setInterval(fetchMulti,5000);fetchMulti();}
function startAutoSync(){clearInterval(autoSyncTimer);autoSyncTimer=setInterval(()=>syncMexc(null,true),30000);log('Auto-sync ON: checking MEXC every 30s','info');}
function stopAutoSync(){clearInterval(autoSyncTimer);autoSyncTimer=null;}

function fetchSpot(){
  const req=https.request({hostname:'api.mexc.com',path:'/api/v3/ticker/price?symbol='+S.pair.replace('/',''),method:'GET',timeout:5000},res=>{
    let d=''; res.on('data',c=>d+=c);
    res.on('end',()=>{try{const r=JSON.parse(d);const px=parseFloat(r.price||0);if(px>0){S.prices[S.pair]=px;onSpotTick(px);}}catch(e){}});
  });
  req.on('error',()=>{}); req.on('timeout',()=>req.destroy()); req.end();
}
function fetchFut(){
  try{
  const req=https.request({hostname:'contract.mexc.com',path:'/api/v1/contract/ticker?symbol='+S.futPair,method:'GET',timeout:5000},res=>{
    let d=''; res.on('data',c=>d+=c);
    res.on('end',()=>{
      try{const r=JSON.parse(d);const px=parseFloat(r.data&&r.data.lastPrice||0);if(px>0){S.prices[S.futPair]=px;onFutTick(px);}else if(S.lastPx>0)onFutTick(S.lastPx);}
      catch(e){if(S.lastPx>0)onFutTick(S.lastPx);}
    });
  });
  req.on('error',()=>{if(S.lastPx>0)onFutTick(S.lastPx);}); req.on('timeout',()=>req.destroy()); req.end();
  }catch(e){if(S.lastPx>0)onFutTick(S.lastPx);}
}
function fetchMulti(){
  const req=https.request({hostname:'api.mexc.com',path:'/api/v3/ticker/price',method:'GET',timeout:5000},res=>{
    let d=''; res.on('data',c=>d+=c);
    res.on('end',()=>{
      try{const arr=JSON.parse(d);const TOP=['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','PEPEUSDT'];
      if(Array.isArray(arr))arr.forEach(t=>{if(TOP.includes(t.symbol)){const px=parseFloat(t.price);if(px>0)S.prices[t.symbol]=px;}});}catch(e){}
    });
  });
  req.on('error',()=>{}); req.on('timeout',()=>req.destroy()); req.end();
}

// ── MEXC ORDERS ───────────────────────────────────────────────────────────────
function placeSpotOrder(side,qty,pair){
  if(!S.apiKey||!S.apiSecret)return;
  const sym=pair.replace('/','');
  const p={symbol:sym,side:side.toUpperCase(),type:'MARKET',timestamp:Date.now(),recvWindow:5000};
  if(side==='BUY')p.quoteOrderQty=(qty*S.lastPx).toFixed(2); else p.quantity=qty.toFixed(6);
  const qs=Object.entries(p).map(e=>e[0]+'='+encodeURIComponent(e[1])).join('&');
  const sig=crypto.createHmac('sha256',S.apiSecret).update(qs).digest('hex');
  const req=https.request({hostname:'api.mexc.com',path:'/api/v3/order?'+qs+'&signature='+sig,method:'POST',headers:{'X-MEXC-APIKEY':S.apiKey,'Content-Type':'application/json'}},res=>{
    let d=''; res.on('data',c=>d+=c);
    res.on('end',()=>{try{const r=JSON.parse(d);if(r.orderId)log('SPOT ORDER '+side+' #'+r.orderId,'profit');else log('SPOT ORDER ERR: '+JSON.stringify(r).slice(0,80),'err');}catch(e){}});
  });
  req.on('error',e=>log('Spot order err: '+e.message,'err')); req.end();
}
function futPlaceOrder(action,lots,px){
  if(!S.apiKey||!S.apiSecret)return;
  const isClose=action==='close_long'||action==='close_short';
  const side=action==='open_long'?1:action==='close_long'?2:action==='open_short'?3:4;
  const vol=Math.max(1,Math.round(lots));  // lots = number of MEXC contracts
  const ts=Date.now().toString();
  const body=JSON.stringify({
    symbol:S.futPair,price:px,vol,side,type:5,
    openType:2,marketCeiling:0,priceProtect:0,
    reduceOnly:isClose,   // CRITICAL: true for close orders
    leverage:S.futLeverage
  });
  const sig=crypto.createHmac('sha256',S.apiSecret).update(S.apiKey+ts+body).digest('hex');
  log('MEXC FUT '+(isClose?'CLOSE':'OPEN')+' '+action.toUpperCase()+' vol='+vol+' lots='+lots,'info');
  const req=https.request({hostname:'contract.mexc.com',path:'/api/v1/private/order/submit',method:'POST',
    headers:{'ApiKey':S.apiKey,'Request-Time':ts,'Signature':sig,'Content-Type':'application/json','Accept':'application/json'},timeout:8000},res=>{
    let d=''; res.on('data',c=>d+=c);
    res.on('end',()=>{
      try{const r=JSON.parse(d);
        if(r.success)log('FUT ORDER OK '+action+' id='+r.data,'profit');
        else{log('FUT ORDER FAIL code='+r.code+': '+r.message,'err');log('Position may remain on MEXC! Check app. vol='+vol,'err');}
      }catch(e){log('FUT order parse err','err');}
    });
  });
  req.on('error',e=>log('FUT order err: '+e.message,'err'));
  req.on('timeout',()=>{req.destroy();log('FUT order TIMEOUT! Check MEXC app!','err');});
  req.write(body); req.end();
}

// ── MEXC POSITION SYNC ────────────────────────────────────────────────────────
function syncMexc(cb,silent){
  if(!S.apiKey||!S.apiSecret){if(cb)cb(0);return;}
  const ts=Date.now().toString();
  const sig=crypto.createHmac('sha256',S.apiSecret).update(S.apiKey+ts+'').digest('hex');
  const req=https.request({hostname:'contract.mexc.com',path:'/api/v1/private/position/open_positions',method:'GET',
    headers:{'ApiKey':S.apiKey,'Request-Time':ts,'Signature':sig,'Content-Type':'application/json'},timeout:8000},res=>{
    let d=''; res.on('data',c=>d+=c);
    res.on('end',()=>{
      try{
        const r=JSON.parse(d);
        // Detect positions bot tracks but MEXC closed
        const liveOpen=S.futOrders.filter(o=>o.status==='open');
        if(r.success&&liveOpen.length>0){
          const mexcIds=(r.data||[]).map(p=>p.positionId);
          liveOpen.forEach(o=>{
            if(o.mexcId&&!mexcIds.includes(o.mexcId)){
              log('MEXC closed position detected: '+o.direction+' entry=$'+o.entryPx.toFixed(2),'err');
              closeFut(o,S.futLastPx||S.lastPx,'MEXC-CLOSED',false);
              S.futOrders=S.futOrders.filter(x=>x.status==='open');
              save();
            }
          });
        }
        if(!r.success||!r.data||!r.data.length){
          S.lastSyncResult={time:new Date().toISOString().slice(11,19),found:0,synced:0};
          if(cb)cb(0); return;
        }
        let synced=0; const newPos=[];
        r.data.forEach(pos=>{
          if(pos.symbol!==S.futPair)return;
          const entPx=parseFloat(pos.openAvgPrice||0);
          const sizeInBtc=parseFloat(pos.holdVol||1)*MEXC_LOT_BTC;
          const lots=parseInt(pos.holdVol||1);
          const isLng=pos.positionType===1;
          // Check if already tracked (same direction + entry within 0.1%)
          const exists=S.futOrders.some(o=>{
            if(o.status!=='open')return false;
            if(o.mexcId&&o.mexcId===pos.positionId)return true;
            return (o.direction==='LONG')==isLng&&entPx>0&&Math.abs(o.entryPx-entPx)/entPx<0.001;
          });
          if(exists)return;
          const notional=sizeInBtc*(S.futLastPx||entPx);
          const margin=notional/S.futLeverage;
          const tp=isLng?entPx*(1+S.futTpPct/100):entPx*(1-S.futTpPct/100);
          const sl=isLng?entPx*(1-S.futSlPct/100):entPx*(1+S.futSlPct/100);
          const o={id:Date.now()+synced,status:'open',isPaper:false,isFutures:true,
            direction:isLng?'LONG':'SHORT',entryPx:entPx,lots,leverage:S.futLeverage,
            notional,margin,tp:parseFloat(tp.toFixed(4)),sl:parseFloat(sl.toFixed(4)),
            bePx:parseFloat(futBE(entPx,lots,isLng).toFixed(4)),
            beStopMoved:false,peakPnl:0,crtType:'SYNCED',crtRR:0,
            openAt:new Date().toISOString().slice(11,19),openedAt:Date.now(),
            mexcId:pos.positionId,reason:'Synced from MEXC'};
          S.futOrders.push(o); newPos.push(o); synced++;
          if(!silent)log('SYNCED: '+o.direction+' entry=$'+entPx.toFixed(2)+' lots='+lots+' notional=$'+notional.toFixed(2),'err');
        });
        S.lastSyncResult={time:new Date().toISOString().slice(11,19),found:r.data.length,synced};
        if(synced>0){
          save();
          // Ask AI to set proper TP/SL
          if(S.aiKey)Promise.all(newPos.map(aiSetTpSlForPosition)).then(()=>log('AI set TP/SL for '+synced+' synced position(s)','profit'));
        }
        if(cb)cb(synced);
      }catch(e){log('Sync err: '+e.message,'err');if(cb)cb(0);}
    });
  });
  req.on('error',e=>{log('Sync net err: '+e.message,'err');if(cb)cb(0);});
  req.on('timeout',()=>{req.destroy();if(cb)cb(0);});
  req.end();
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
function cors(res){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Bot-Pin');res.setHeader('Access-Control-Max-Age','86400');}
function send(res,code,data){cors(res);res.writeHead(code,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}

const server=http.createServer((req,res)=>{
  if(req.method==='OPTIONS'){cors(res);res.writeHead(204);res.end();return;}
  const url=req.url.split('?')[0];
  if(url==='/'||url==='/ping'||url==='/health'){send(res,200,{ok:true,uptime:process.uptime().toFixed(0)+'s',v:'v9'});return;}
  if(url==='/prices'){send(res,200,{prices:S.prices,ticks,futTicks});return;}
  if(req.headers['x-bot-pin']!==BOT_PIN){send(res,401,{error:'Invalid PIN'});return;}

  if(req.method==='GET'&&url==='/status'){
    const futLO=S.futOrders.filter(o=>o.status==='open');
    const futPO=S.futPapOrders.filter(o=>o.status==='open');
    const mapFut=o=>{
      const isL=o.direction!=='SHORT';
      const px=S.futLastPx||S.lastPx;
      const r=futCalcPnl(o.entryPx,px,o.lots||1,isL);
      return Object.assign({},o,{
        livePnl:r.pnl,    // raw pnl = matches MEXC unrealized P&L display
        liveNet:r.net,    // after fees = real take-home
        liveFee:r.fee,
        peakPnl:o.peakPnl||0,
        notional:r.notional
      });
    };
    send(res,200,{
      botOn:S.botOn,mode:S.mode,pair:S.pair,capital:S.capital,maxPos:S.maxPos,
      tpPct:S.tpPct,slPct:S.slPct,lastPx:S.lastPx,prices:S.prices,ticks,
      liveProfit:S.liveProfit,liveT:S.liveT,liveW:S.liveW,liveL:S.liveL,bestT:S.bestT,feesT:S.feesT,
      liveWR:S.liveT>0?Math.round(S.liveW/S.liveT*100):0,
      papProfit:S.papProfit,papT:S.papT,papW:S.papW,papL:S.papL,papBest:S.papBest,papFees:S.papFees,
      papWR:S.papT>0?Math.round(S.papW/S.papT*100):0,
      liveOrders:S.liveOrders.filter(o=>o.status==='open'),
      papOrders:S.papOrders.filter(o=>o.status==='open'),
      liveTrades:S.liveTrades.slice(0,60),papTrades:S.papTrades.slice(0,60),
      futuresOn:S.futuresOn,futMode:S.futMode,futPair:S.futPair,futLastPx:S.futLastPx,
      futCapital:S.futCapital,futMaxPos:S.futMaxPos,futLeverage:S.futLeverage,
      futTpPct:S.futTpPct,futSlPct:S.futSlPct,
      futProfit:S.futProfit,futT:S.futT,futW:S.futW,futL:S.futL,futBest:S.futBest,futFees:S.futFees,
      futWR:S.futT>0?Math.round(S.futW/S.futT*100):0,
      futPapProfit:S.futPapProfit,futPapT:S.futPapT,futPapW:S.futPapW,futPapL:S.futPapL,
      futPapWR:S.futPapT>0?Math.round(S.futPapW/S.futPapT*100):0,
      futOrders:futLO.map(mapFut),futPapOrders:futPO.map(mapFut),
      futTrades:S.futTrades.slice(0,60),futPapTrades:S.futPapTrades.slice(0,60),
      futRealBalance:S.futRealBalance||0,futTicks,
      crtStats:S.crtStats,crtCandleSize:S.crtCandleSize,lastCrtSig:S.lastCrtSig,lastCrtSigTime:S.lastCrtSigTime,
      crtLastSignal:S.crtLastSignal,crtCandles:S.crtCandles.slice(0,5),crtCurrentCandle:S.crtCurrentCandle,
      aiEnabled:!!(S.aiKey),aiMinConf:S.aiMinConf,aiInterval:S.aiInterval,
      aiFutDecision:S.aiFutDecision,aiCallCount:S.aiCallCount,aiTokensUsed:S.aiTokensUsed,aiCost:S.aiCost,
      compoundEnabled:S.compoundEnabled,compoundPct:S.compoundPct,
      futBaseCapital:S.futBaseCapital||S.futCapital,futCompounded:S.futCompounded||0,
      autoSync:!!(autoSyncTimer),lastSyncResult:S.lastSyncResult,
      hasApiKeys:!!(S.apiKey&&S.apiSecret),startedAt:S.startedAt,savedAt:S.savedAt,
      mexcLotBtc:MEXC_LOT_BTC,
      log:S.log.slice(0,150)
    });
    return;
  }

  if(req.method==='POST'){
    let body=''; req.on('data',c=>body+=c);
    req.on('end',async()=>{
      let d={}; try{d=JSON.parse(body);}catch(e){}

      if(url==='/start'){
        S.botOn=true;S.liveOrders=[];S.papOrders=[];S.lastEntry=0;PX=[];ticks=0;
        S.startedAt=new Date().toISOString();startSpotFeed();
        log('SPOT BOT STARTED '+S.pair+' mode='+S.mode,'buy');save();send(res,200,{ok:true});return;
      }
      if(url==='/stop'){
        S.botOn=false;S.liveOrders=[];S.papOrders=[];stopSpotFeed();
        log('Spot stopped','info');save();send(res,200,{ok:true});return;
      }
      if(url==='/startfutures'){
        S.futuresOn=true;S.futOrders=[];S.futPapOrders=[];S.futLastEntry=0;
        S.crtCandles=[];S.crtCurrentCandle=null;S.crtLastSignal=null;
        S.crtStats={setups:0,confirmed:0,entered:0};futPX=[];futTicks=0;
        futTickBusy=false;futEntering=false;
        if(d.mode)S.futMode=d.mode;if(d.pair)S.futPair=d.pair;
        if(d.capital)S.futCapital=parseFloat(d.capital)||20;
        if(d.leverage)S.futLeverage=parseInt(d.leverage)||3;
        if(d.maxPos)S.futMaxPos=parseInt(d.maxPos)||1;
        if(d.candleSize)S.crtCandleSize=parseInt(d.candleSize)||40;
        startFutFeed();startAutoSync();
        setTimeout(()=>{log('Checking MEXC for ghost positions...','info');syncMexc(n=>{if(n>0)log(n+' untracked position(s) synced from MEXC!','err');},false);},3000);
        log('CRT FUTURES STARTED '+S.futPair+' mode='+S.futMode+' $'+S.futCapital+' '+S.futLeverage+'x candle='+S.crtCandleSize+'ticks','buy');
        log('Contract size: '+MEXC_LOT_BTC+' BTC/lot | Target notional: $'+(S.futCapital/S.futMaxPos*S.futLeverage).toFixed(2),'info');
        log('Target lots: '+calcLots(S.futCapital/S.futMaxPos*S.futLeverage,S.futLastPx||100000)+' (recalculates on each entry)','info');
        save();send(res,200,{ok:true});return;
      }
      if(url==='/stopfutures'){
        S.futuresOn=false;S.futOrders=[];S.futPapOrders=[];stopFutFeed();stopAutoSync();
        log('Futures stopped','info');save();send(res,200,{ok:true});return;
      }
      if(url==='/config'){
        if(d.pair)S.pair=d.pair.replace('/','');if(d.mode)S.mode=d.mode;
        if(d.capital)S.capital=parseFloat(d.capital)||20;if(d.maxPos)S.maxPos=parseInt(d.maxPos)||1;
        if(d.tpPct)S.tpPct=parseFloat(d.tpPct);if(d.slPct)S.slPct=parseFloat(d.slPct);
        if(d.cooldown)S.cooldown=parseInt(d.cooldown)*1000||8000;
        if(d.apiKey&&d.apiKey!=='[saved]'){S.apiKey=d.apiKey.trim();}
        if(d.apiSecret&&d.apiSecret!=='[saved]'){S.apiSecret=d.apiSecret.trim();}
        if(d.apiKey&&d.apiSecret&&d.apiKey!=='[saved]')saveKeys(d.apiKey.trim(),d.apiSecret.trim());
        save();send(res,200,{ok:true});return;
      }
      if(url==='/savekeys'){
        if(!d.apiKey||!d.apiSecret){send(res,400,{error:'apiKey and apiSecret required'});return;}
        S.apiKey=d.apiKey.trim();S.apiSecret=d.apiSecret.trim();saveKeys(S.apiKey,S.apiSecret);save();
        log('API keys saved and encrypted','info');send(res,200,{ok:true,keyLength:S.apiKey.length});return;
      }
      if(url==='/configfutures'){
        if(d.futPair)S.futPair=d.futPair;if(d.futMode)S.futMode=d.futMode;
        if(d.futCapital)S.futCapital=parseFloat(d.futCapital)||20;
        if(d.futMaxPos)S.futMaxPos=parseInt(d.futMaxPos)||1;
        if(d.futLeverage)S.futLeverage=parseInt(d.futLeverage)||3;
        if(d.futTpPct)S.futTpPct=parseFloat(d.futTpPct)||0.35;
        if(d.futSlPct)S.futSlPct=parseFloat(d.futSlPct)||0.18;
        if(d.futCooldown)S.futCooldown=parseInt(d.futCooldown)*1000||6000;
        if(d.candleSize)S.crtCandleSize=parseInt(d.candleSize)||40;
        save();
        const n=S.futLastPx||100000;
        const lots=calcLots(S.futCapital/S.futMaxPos*S.futLeverage,n);
        log('Futures config: '+S.futPair+' '+S.futLeverage+'x $'+S.futCapital+' candle='+S.crtCandleSize+'ticks','info');
        log('Estimated lots at current price: '+lots+' ('+MEXC_LOT_BTC+'BTC/lot = $'+(lots*MEXC_LOT_BTC*n).toFixed(2)+' notional)','info');
        send(res,200,{ok:true,estimatedLots:lots,estimatedNotional:lots*MEXC_LOT_BTC*n,mexcLotBtc:MEXC_LOT_BTC});return;
      }
      if(url==='/setaikey'){
        if(!d.aiKey){send(res,400,{error:'aiKey required'});return;}
        S.aiKey=d.aiKey.trim();
        if(d.aiMinConf)S.aiMinConf=parseInt(d.aiMinConf)||65;
        S.aiFutLastCall=0;S.aiFutDecision=null;save();
        log('AI Brain activated — DeepSeek CRT validation mode','buy');
        send(res,200,{ok:true,aiMinConf:S.aiMinConf});return;
      }
      if(url==='/setlive'){S.mode='live';save();log('Spot mode: LIVE','buy');send(res,200,{ok:true});return;}
      if(url==='/setpaper'){S.mode='paper';save();log('Spot mode: paper','info');send(res,200,{ok:true});return;}
      if(url==='/toggleautosync'){
        if(d.enabled&&S.futuresOn){startAutoSync();}else{stopAutoSync();}
        send(res,200,{ok:true,autoSync:!!(autoSyncTimer)});return;
      }
      if(url==='/syncpositions'){
        syncMexc(n=>send(res,200,{ok:true,synced:n,livePositions:S.futOrders.filter(o=>o.status==='open').length}),false);return;
      }
      if(url==='/closefuttrade'){
        const orders=d.isPaper?S.futPapOrders:S.futOrders;
        const o=orders.find(o=>String(o.id)===String(d.id)&&o.status==='open');
        if(!o){send(res,404,{error:'Not found'});return;}
        const px=S.futLastPx||S.lastPx;
        closeFut(o,px,'MANUAL',!!d.isPaper);
        if(d.isPaper)S.futPapOrders=S.futPapOrders.filter(o=>o.status==='open');
        else S.futOrders=S.futOrders.filter(o=>o.status==='open');
        save();send(res,200,{ok:true});return;
      }
      if(url==='/closeallfutures'){
        const openPos=S.futOrders.filter(o=>o.status==='open');
        const px=S.futLastPx||S.lastPx;
        openPos.forEach(o=>closeFut(o,px,'EMERGENCY',false));
        S.futOrders=S.futOrders.filter(o=>o.status==='open');
        save();send(res,200,{ok:true,closed:openPos.length});return;
      }
      if(url==='/closetrade'){
        const orders=d.isPaper?S.papOrders:S.liveOrders;
        const o=orders.find(o=>String(o.id)===String(d.id)&&o.status==='open');
        if(!o){send(res,404,{error:'Not found'});return;}
        const px=S.lastPx;const r=spotFee(o.entryPx,px,o.amt);o.status='closed';
        const tr={n:d.isPaper?++S.papT:++S.liveT,time:new Date().toISOString().slice(11,19),pair:S.pair,isPaper:!!d.isPaper,side:'MANUAL',entryPx:o.entryPx,exitPx:px,amt:o.amt,fee:+r.fee.toFixed(6),net:+r.net.toFixed(6)};
        if(d.isPaper){S.papProfit+=r.net;S.papFees+=r.fee;if(r.net>=0){S.papW++;if(r.net>S.papBest)S.papBest=r.net;}else S.papL++;S.papTrades.unshift(tr);S.papOrders=S.papOrders.filter(o=>o.status==='open');}
        else{S.liveProfit+=r.net;S.feesT+=r.fee;if(r.net>=0){S.liveW++;if(r.net>S.bestT)S.bestT=r.net;}else S.liveL++;S.liveTrades.unshift(tr);S.liveOrders=S.liveOrders.filter(o=>o.status==='open');placeSpotOrder('SELL',o.qty,S.pair);}
        save();send(res,200,{ok:true,net:r.net});return;
      }
      if(url==='/setcompound'){
        S.compoundEnabled=!!d.enabled;if(d.pct)S.compoundPct=Math.min(100,Math.max(1,parseInt(d.pct)||100));
        if(S.compoundEnabled)S.futBaseCapital=S.futCapital;
        save();log('Compound '+(S.compoundEnabled?'ON '+S.compoundPct+'%':'OFF'),'info');
        send(res,200,{ok:true,enabled:S.compoundEnabled,pct:S.compoundPct,capital:S.futCapital});return;
      }
      if(url==='/resetcompound'){S.futCapital=S.futBaseCapital||S.futCapital;S.futCompounded=0;save();send(res,200,{ok:true,capital:S.futCapital});return;}
      if(url==='/reset'){S.liveProfit=0;S.liveT=0;S.liveW=0;S.liveL=0;S.bestT=0;S.feesT=0;S.papProfit=0;S.papT=0;S.papW=0;S.papL=0;S.papBest=0;S.papFees=0;S.liveTrades=[];S.papTrades=[];S.liveOrders=[];S.papOrders=[];save();send(res,200,{ok:true});return;}
      if(url==='/resetfutures'){S.futProfit=0;S.futT=0;S.futW=0;S.futL=0;S.futBest=0;S.futFees=0;S.futPapProfit=0;S.futPapT=0;S.futPapW=0;S.futPapL=0;S.futTrades=[];S.futPapTrades=[];S.futOrders=[];S.futPapOrders=[];S.crtStats={setups:0,confirmed:0,entered:0};save();send(res,200,{ok:true});return;}
      if(url==='/resetpaper'){S.papProfit=0;S.papT=0;S.papW=0;S.papL=0;S.papBest=0;S.papFees=0;S.papTrades=[];S.papOrders=[];save();send(res,200,{ok:true});return;}
      if(url==='/balance'){
        if(!S.apiKey||!S.apiSecret){send(res,200,{ok:false,error:'No API keys'});return;}
        const tsB=Date.now().toString(),qsB='timestamp='+tsB+'&recvWindow=5000';
        const sigB=crypto.createHmac('sha256',S.apiSecret).update(qsB).digest('hex');
        const bReq=https.request({hostname:'api.mexc.com',path:'/api/v3/account?'+qsB+'&signature='+sigB,method:'GET',headers:{'X-MEXC-APIKEY':S.apiKey},timeout:8000},rB=>{
          let dB=''; rB.on('data',c=>dB+=c);
          rB.on('end',()=>{try{const rb=JSON.parse(dB);if(rb.balances){const coins=['USDT','BTC','ETH','BNB'],result={};rb.balances.forEach(b=>{if(coins.includes(b.asset)&&parseFloat(b.free)>0)result[b.asset]=parseFloat(b.free);});S.mexcBalance=result;save();send(res,200,{ok:true,balance:result});}else send(res,200,{ok:false,error:rb.msg||'err',raw:rb});}catch(e){send(res,200,{ok:false,error:e.message});}});
        });
        bReq.on('error',e=>send(res,200,{ok:false,error:e.message}));bReq.on('timeout',()=>{bReq.destroy();send(res,200,{ok:false,error:'timeout'});});bReq.end();return;
      }
      if(url==='/futuresbalance'){
        if(!S.apiKey||!S.apiSecret){send(res,200,{ok:false,error:'No API keys'});return;}
        const tsFB=Date.now().toString();
        const sigFB=crypto.createHmac('sha256',S.apiSecret).update(S.apiKey+tsFB+'').digest('hex');
        const fbReq=https.request({hostname:'contract.mexc.com',path:'/api/v1/private/account/assets',method:'GET',headers:{'ApiKey':S.apiKey,'Request-Time':tsFB,'Signature':sigFB,'Content-Type':'application/json'},timeout:8000},rFB=>{
          let dFB=''; rFB.on('data',c=>dFB+=c);
          rFB.on('end',()=>{try{const rfb=JSON.parse(dFB);if(rfb.success&&rfb.data){const arr=Array.isArray(rfb.data)?rfb.data:[rfb.data];const u=arr.find(a=>a.currency==='USDT');const bal=u?parseFloat(u.availableBalance||0):0;S.futRealBalance=bal;save();send(res,200,{ok:true,balance:bal,equity:u?parseFloat(u.equity||bal):0});}else send(res,200,{ok:false,error:rfb.message||'err',raw:rfb});}catch(e){send(res,200,{ok:false,error:e.message});}});
        });
        fbReq.on('error',e=>send(res,200,{ok:false,error:e.message}));fbReq.on('timeout',()=>{fbReq.destroy();send(res,200,{ok:false,error:'timeout'});});fbReq.end();return;
      }
      if(url==='/testconnection'){
        if(!S.apiKey||!S.apiSecret){send(res,200,{ok:false,error:'No API keys set'});return;}
        const tsX=Date.now().toString(),qsX='timestamp='+tsX+'&recvWindow=5000';
        const sigX=crypto.createHmac('sha256',S.apiSecret).update(qsX).digest('hex');
        const xReq=https.request({hostname:'api.mexc.com',path:'/api/v3/account?'+qsX+'&signature='+sigX,method:'GET',headers:{'X-MEXC-APIKEY':S.apiKey},timeout:8000},rX=>{
          let dx=''; rX.on('data',c=>dx+=c);
          rX.on('end',()=>{try{const rx=JSON.parse(dx);if(rx.balances){const u=rx.balances.find(b=>b.asset==='USDT');send(res,200,{ok:true,balance:u?parseFloat(u.free):0,msg:'MEXC connected!'});}else send(res,200,{ok:false,error:rx.msg||'err'});}catch(e){send(res,200,{ok:false,error:e.message});}});
        });
        xReq.on('error',e=>send(res,200,{ok:false,error:e.message}));xReq.on('timeout',()=>{xReq.destroy();send(res,200,{ok:false,error:'timeout'});});xReq.end();return;
      }
      if(url==='/aidecision'){
        if(!S.aiKey){send(res,200,{ok:false,error:'No AI key set'});return;}
        const px=S.futLastPx||S.lastPx;
        if(!px){send(res,200,{ok:false,error:'No price data. Start futures bot first.'});return;}
        const raw=(futPX.length>0?futPX:PX.map(p=>p.px||p)).filter(v=>v>0);
        const n=raw.length;
        const r14=n>2?calcRSI(raw,Math.min(14,n-1)).toFixed(1):'50';
        const e9=n>0?calcEMA(raw,Math.min(9,n)).toFixed(2):px.toFixed(2);
        const e21=n>0?calcEMA(raw,Math.min(21,n)).toFixed(2):px.toFixed(2);
        const trend=parseFloat(e9)>parseFloat(e21)*1.0002?'UPTREND':parseFloat(e9)<parseFloat(e21)*0.9998?'DOWNTREND':'SIDEWAYS';
        const cand=S.crtCandles[0];
        let p='CRT bot diagnostic. Current market status for '+S.futPair+'.\n\n';
        p+='Price: $'+px.toFixed(2)+' | RSI14: '+r14+' | EMA9: $'+e9+' EMA21: $'+e21+' trend: '+trend+'\n';
        p+='CRT candles: '+S.crtCandles.length+' | Current: '+( S.crtCurrentCandle?S.crtCurrentCandle.ticks+'/'+S.crtCandleSize:'0/'+S.crtCandleSize)+'\n';
        if(cand)p+='Prev candle: H=$'+cand.h.toFixed(2)+' L=$'+cand.l.toFixed(2)+' range='+(((cand.h-cand.l)/cand.l)*100).toFixed(3)+'%\n';
        p+='P&L: $'+S.futProfit.toFixed(4)+' | Trades: '+S.futT+' | Win: '+(S.futT>0?Math.round(S.futW/S.futT*100):0)+'%\n\n';
        p+='Is market good for CRT setups? What direction? Reply JSON: {"action":"BUY","confidence":70,"reason":"brief","risk":"low"}';
        const dec=await callDeepSeek(p);
        if(dec){S.aiFutDecision=Object.assign({},dec,{ts:new Date().toISOString().slice(11,19),price:px,crtCandles:S.crtCandles.length,warmup:S.crtCandles.length<2});}
        send(res,200,{ok:true,decision:S.aiFutDecision,crtCandles:S.crtCandles.length,warmup:S.crtCandles.length<2,mexcLotBtc:MEXC_LOT_BTC});return;
      }
      send(res,404,{error:'Not found: '+url});
    });
    return;
  }
  send(res,404,{error:'Not found'});
});

// ── START ─────────────────────────────────────────────────────────────────────
server.listen(PORT,'0.0.0.0',()=>{
  console.log('Server listening on 0.0.0.0:'+PORT);
  load(); loadKeys(); startMultiFeed();
  if(S.botOn){S.liveOrders=[];S.papOrders=[];PX=[];ticks=0;log('Auto-resuming spot bot','info');startSpotFeed();}
  else log('Bot ready. Press Start.','info');
  if(S.futuresOn){
    S.futPapOrders=[];futPX=[];futTicks=0;S.crtCandles=[];S.crtCurrentCandle=null;futTickBusy=false;futEntering=false;
    log('Auto-resuming futures CRT bot','info');startFutFeed();startAutoSync();
    setTimeout(()=>{try{syncMexc(n=>{if(n>0)log(n+' ghost position(s) found and synced!','err');},false);}catch(e){log('sync err: '+e.message,'err');}},3000);
  }
});
server.on('error',e=>{console.error(e);process.exit(1);});
process.on('SIGTERM',()=>{save();process.exit(0);});
process.on('SIGINT', ()=>{save();process.exit(0);});
