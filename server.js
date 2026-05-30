'use strict';
const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const fs     = require('fs');

const PORT    = parseInt(process.env.PORT || '3000');
const BOT_PIN = process.env.BOT_PIN || '123456';
const ENV_KEY    = (process.env.MEXC_KEY    || '').trim();
const ENV_SECRET = (process.env.MEXC_SECRET || '').trim();
const ENV_PAIR   = process.env.BOT_PAIR    || 'BTCUSDT';
const ENV_MODE   = process.env.BOT_MODE    || 'paper';
const ENV_RUN    = process.env.BOT_RUNNING === 'true';

console.log('=== CryptoBot Pro v8 — CRT Strategy ===');
console.log('Port:', PORT, '| Mode:', ENV_MODE);

// ── CONSTANTS ────────────────────────────────────────────────────────────────
const TAKER      = 0.0005;
const RT_FEE     = TAKER * 2;
const FUT_TAKER  = 0.0002;
const FUT_RT     = FUT_TAKER * 2;
const STATE_FILE = './bot_state.json';
const KEYS_FILE  = './bot_keys.enc';

// ── STATE ────────────────────────────────────────────────────────────────────
let S = {
  // Spot
  botOn:false, mode:ENV_MODE, strategy:'auto', pair:ENV_PAIR,
  capital:20, maxPos:1, tpPct:0.45, slPct:0.25,
  cooldown:8000, warmup:5, maxDaily:200,
  apiKey:ENV_KEY, apiSecret:ENV_SECRET,
  liveProfit:0, todayP:0, liveT:0, liveW:0, liveL:0, bestT:0, feesT:0,
  papProfit:0,  papT:0,  papW:0,  papL:0,  papBest:0, papFees:0,
  liveOrders:[], papOrders:[], liveTrades:[], papTrades:[],
  log:[], prices:{}, lastPx:0, lastEntry:0, startedAt:null, savedAt:null,
  // Futures — CRT only
  futuresOn:false, futMode:'paper', futPair:'BTC_USDT',
  futCapital:20, futMaxPos:1, futLeverage:3,
  futProfit:0, futT:0, futW:0, futL:0, futBest:0, futFees:0,
  futPapProfit:0, futPapT:0, futPapW:0, futPapL:0,
  futOrders:[], futPapOrders:[], futTrades:[], futPapTrades:[],
  futLastPx:0, futLastEntry:0, futCooldown:6000,
  // Compounding
  compoundEnabled: false,   // auto-reinvest profits
  compoundPct:     100,     // % of profit to reinvest (1-100)
  futBaseCapital:  20,      // original capital before compounding
  futCompounded:   0,       // total amount reinvested so far
  // CRT Engine
  crtCandleSize:40, crtCandles:[], crtCurrentCandle:null,
  crtLastSignal:null, crtStats:{setups:0,confirmed:0,entered:0},
  // AI Brain (DeepSeek)
  aiKey:'', aiMinConf:65, aiInterval:20,
  aiDecision:null, aiFutDecision:null,
  aiLastCall:0, aiFutLastCall:0,
  aiCallCount:0, aiTokensUsed:0, aiCost:0,
};

// ── PRICE BUFFERS ────────────────────────────────────────────────────────────
let PX = [], futPX = [], ticks = 0, futTicks = 0;

// ── PERSIST ──────────────────────────────────────────────────────────────────
function save() {
  try {
    S.savedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(S));
  } catch(e) {}
}
function load() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const d = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    S = Object.assign({}, S, d, {
      liveOrders:[], papOrders:[], futOrders:[], futPapOrders:[],
      crtCandles:[], crtCurrentCandle:null, crtLastSignal:null,
    });
    log('State loaded. P&L live=$'+S.liveProfit.toFixed(4)+' fut=$'+S.futProfit.toFixed(4),'info');
  } catch(e) { log('State load err: '+e.message,'err'); }
}
function saveKeys(k,s) {
  try {
    const salt=crypto.randomBytes(16),iv=crypto.randomBytes(16);
    const key=crypto.scryptSync(BOT_PIN+'crt8',salt,32);
    const c=crypto.createCipheriv('aes-256-cbc',key,iv);
    const enc=Buffer.concat([c.update(JSON.stringify({k,s}),'utf8'),c.final()]);
    fs.writeFileSync(KEYS_FILE,JSON.stringify({salt:salt.toString('hex'),iv:iv.toString('hex'),enc:enc.toString('hex')}));
    log('Keys encrypted & saved.','info');
  } catch(e) { log('Key save err: '+e.message,'err'); }
}
function loadKeys() {
  try {
    if (!fs.existsSync(KEYS_FILE)) return;
    const f=JSON.parse(fs.readFileSync(KEYS_FILE,'utf8'));
    const key=crypto.scryptSync(BOT_PIN+'crt8',Buffer.from(f.salt,'hex'),32);
    const d=crypto.createDecipheriv('aes-256-cbc',key,Buffer.from(f.iv,'hex'));
    const dec=Buffer.concat([d.update(Buffer.from(f.enc,'hex')),d.final()]);
    const {k,s}=JSON.parse(dec.toString('utf8'));
    S.apiKey=k||''; S.apiSecret=s||'';
    if(S.apiKey) log('Keys loaded from encrypted storage.','info');
  } catch(e) { log('Key load err: '+e.message,'err'); }
}
setInterval(save, 8000);
function log(msg,type='info'){
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
  const ag=g/n,al=l/n; if(al===0)return 100;
  return 100-(100/(1+ag/al));
}
function calcEMA(arr,n){
  if(arr.length<n)return arr[arr.length-1]||0;
  const k=2/(n+1); let e=arr.slice(0,n).reduce(function(a,b){return a+b;},0)/n;
  for(let i=n;i<arr.length;i++)e=arr[i]*k+e*(1-k); return e;
}
function calcBB(arr,n){
  n=n||20; if(arr.length<n)return null;
  const sl=arr.slice(-n),m=sl.reduce(function(a,b){return a+b;},0)/n;
  const sd=Math.sqrt(sl.reduce(function(a,b){return a+(b-m)*(b-m);},0)/n);
  return {upper:m+2*sd,middle:m,lower:m-2*sd};
}

// ── FEE MATH ─────────────────────────────────────────────────────────────────
function feeMath(entryPx,exitPx,amt){
  const qty=amt/entryPx,proceeds=qty*exitPx,fee=amt*TAKER+proceeds*TAKER;
  return {fee,net:proceeds-amt-fee,qty,proceeds};
}
function minTpPx(entryPx,amt){
  const qty=amt/entryPx,be=(amt*(1+TAKER))/(qty*(1-TAKER));
  return be*(1+0.0012);
}
function futFee(entryPx,exitPx,margin,lev,isLong){
  const notional=margin*lev,contracts=notional/entryPx;
  const rawPnl=(exitPx-entryPx)*contracts;
  const pnl=isLong===false?-rawPnl:rawPnl;
  const fee=notional*FUT_TAKER*2;
  return {net:pnl-fee,fee,pnl,notional,contracts};
}
function futBE(entryPx,margin,lev,isLong){
  const notional=margin*lev,contracts=notional/entryPx,fee=notional*FUT_RT;
  return isLong===false?entryPx-fee/contracts:entryPx+fee/contracts;
}

// ── SIGNAL ENGINE (SPOT) ─────────────────────────────────────────────────────
function getSpotSig(px){
  const raw=PX.filter(function(v){return v>0;});
  const n=raw.length; if(n<5)return {signal:false,reason:'warmup'};
  const r14=calcRSI(raw,14),e9=calcEMA(raw,Math.min(9,n)),e21=calcEMA(raw,Math.min(21,n));
  const bb=n>=10?calcBB(raw,Math.min(20,n)):null;
  const hi=Math.max.apply(null,raw.slice(-Math.min(10,n)));
  const dip=(px-hi)/hi*100;
  const ch1=n>1?(px-raw[n-2])/raw[n-2]*100:0;
  const trend=e9>e21*1.0002?'up':e9<e21*0.9998?'down':'flat';
  const bbPos=bb?(px<=bb.lower*1.003?'support':px>=bb.upper*0.997?'resist':'mid'):'mid';
  let score=0;
  if(r14<50)score++; if(dip<=-0.04)score++; if(ch1>0)score++;
  if(trend==='up')score++; if(bbPos==='support')score++;
  return {signal:score>=3,reason:'score='+score+'/5 rsi='+r14.toFixed(1)+' dip='+dip.toFixed(3)+'%'};
}

// ══════════════════════════════════════════════════════════════════════════════
// CRT ENGINE — CANDLE RANGE THEORY (FUTURES ONLY)
// Market makers sweep liquidity above/below candle H/L → price reverses.
// We enter AFTER the sweep and rejection, with tight SL and 2:1+ R:R.
// ══════════════════════════════════════════════════════════════════════════════

function crtUpdateCandle(px){
  if(!S.crtCurrentCandle){
    S.crtCurrentCandle={o:px,h:px,l:px,c:px,ticks:1};
    return;
  }
  var c=S.crtCurrentCandle;
  c.h=Math.max(c.h,px); c.l=Math.min(c.l,px); c.c=px; c.ticks++;
  if(c.ticks>=S.crtCandleSize){
    S.crtCandles.unshift(Object.assign({},c));
    if(S.crtCandles.length>50)S.crtCandles.length=50;
    S.crtCurrentCandle={o:px,h:px,l:px,c:px,ticks:1};
  }
}

function crtDetect(px){
  if(S.crtCandles.length<2)return null;
  var prev=S.crtCandles[0],curr=S.crtCurrentCandle;
  if(!prev||!curr)return null;
  var prevRange=prev.h-prev.l, prevRangePct=prevRange/prev.l*100;

  // Adaptive thresholds — work for both 1-min (small) and 4-min (large) BTC candles
  // Thresholds tuned for BTC 1-min candles (range typically 0.02-0.08%)
  var minRange = 0.015;              // 0.015% min range (~$15 on BTC)
  var minSweep = 0.002;              // 0.002% min sweep depth (~$2 on BTC)
  var minRR    = 0.8;                // min R:R 0.8 — CRT's high win rate compensates
  var minTP    = FUT_RT*100;          // min TP = just cover fees (0.04%) — R:R handles quality
  var sweepBuf = Math.max(prevRange*0.10, prev.l*0.00008); // 10% of range OR 0.008% of price

  if(prevRangePct < minRange) return null;

  // BULLISH CRT: current candle swept BELOW prev.low, price now back ABOVE prev.low
  if(curr.l < prev.l-sweepBuf && px > prev.l){
    var sweepD=(prev.l-curr.l)/prev.l*100;
    if(sweepD<minSweep)return null;
    var tp=parseFloat(prev.h.toFixed(4));
    var sl=parseFloat((curr.l-(sweepBuf*0.3)).toFixed(4));
    var tpD=(tp-px)/px*100, slD=(px-sl)/px*100;
    var rr=slD>0?tpD/slD:0;
    if(tpD<minTP||rr<minRR)return null;
    S.crtStats.setups++;
    return {direction:'BUY',type:'BULLISH_CRT',sweepLevel:prev.l,sweepLow:curr.l,sweepHigh:null,
      sweepDepth:sweepD.toFixed(4),entry:px,tp:tp,sl:sl,
      tpPct:parseFloat(tpD.toFixed(4)),slPct:parseFloat(slD.toFixed(4)),rr:parseFloat(rr.toFixed(2)),
      prevRange:prevRangePct.toFixed(4),
      reason:'Bullish CRT: swept $'+curr.l.toFixed(2)+' below prev.lo $'+prev.l.toFixed(2)+' R:R='+rr.toFixed(2)+'x range='+prevRangePct.toFixed(3)+'%'};
  }

  // BEARISH CRT: current candle swept ABOVE prev.high, price now back BELOW prev.high
  if(curr.h > prev.h+sweepBuf && px < prev.h){
    var sweepDB=(curr.h-prev.h)/prev.h*100;
    if(sweepDB<minSweep)return null;
    var tpB=parseFloat(prev.l.toFixed(4));
    var slB=parseFloat((curr.h+(sweepBuf*0.3)).toFixed(4));
    var tpDB=(px-tpB)/px*100, slDB=(slB-px)/px*100;
    var rrB=slDB>0?tpDB/slDB:0;
    if(tpDB<minTP||rrB<minRR)return null;
    S.crtStats.setups++;
    return {direction:'SHORT',type:'BEARISH_CRT',sweepLevel:prev.h,sweepLow:null,sweepHigh:curr.h,
      sweepDepth:sweepDB.toFixed(4),entry:px,tp:tpB,sl:slB,
      tpPct:parseFloat(tpDB.toFixed(4)),slPct:parseFloat(slDB.toFixed(4)),rr:parseFloat(rrB.toFixed(2)),
      prevRange:prevRangePct.toFixed(4),
      reason:'Bearish CRT: swept $'+curr.h.toFixed(2)+' above prev.hi $'+prev.h.toFixed(2)+' R:R='+rrB.toFixed(2)+'x range='+prevRangePct.toFixed(3)+'%'};
  }
  return null;
}

// ── CRT AI CONFIRMATION — DeepSeek validates CRT setup ───────────────────────
async function crtAiConfirm(px,sig){
  if(!S.aiKey) return {confirmed:true,reason:'no-key',confidence:70};
  var now=Date.now();
  if(now-S.aiFutLastCall<8000){
    var cached=S.aiFutDecision;
    if(cached&&now-S.aiFutLastCall<45000){
      var match=(sig.direction==='BUY'&&cached.action==='BUY')||
                (sig.direction==='SHORT'&&cached.action==='SHORT');
      if(cached.action==='HOLD'&&(cached.confidence||0)>=80)
        return {confirmed:false,reason:'AI says HOLD '+cached.confidence+'%',confidence:cached.confidence};
      if(match) return {confirmed:true,reason:'cached '+cached.action+' '+cached.confidence+'%',confidence:cached.confidence};
    }
    return {confirmed:true,reason:'throttled',confidence:65};
  }
  S.aiFutLastCall=now; S.aiCallCount++;
  var raw=futPX.filter(function(v){return v>0;});
  var n=raw.length;
  var r14=calcRSI(raw,Math.min(14,n-1));
  var e9=n>0?calcEMA(raw,Math.min(9,n)):px;
  var e21=n>0?calcEMA(raw,Math.min(21,n)):px;
  var bb=n>=10?calcBB(raw,Math.min(20,n)):null;
  var trend=e9>e21*1.0002?'UPTREND':e9<e21*0.9998?'DOWNTREND':'SIDEWAYS';
  // Loss streak
  var streak=0;
  for(var li=0;li<S.futTrades.length;li++){if(S.futTrades[li].net<0)streak++;else break;}
  var prompt='';
  prompt+='You are a CRT (Candle Range Theory) trading expert. Confirm or reject this futures setup.\n\n';
  prompt+='=== CRT SETUP DETECTED ===\n';
  prompt+='Type: '+sig.type+'\n';
  prompt+='Direction: '+sig.direction+' ('+( sig.direction==='BUY'?'LONG':'SHORT')+')\n';
  prompt+='Previous candle range: '+sig.prevRange+'%\n';
  prompt+='Sweep depth beyond level: '+sig.sweepDepth+'%\n';
  prompt+='Entry: $'+px.toFixed(2)+'\n';
  prompt+='Take Profit: $'+sig.tp+' (+'+sig.tpPct+'%)\n';
  prompt+='Stop Loss: $'+sig.sl+' (-'+sig.slPct+'%)\n';
  prompt+='R:R ratio: '+sig.rr+'x\n\n';
  prompt+='=== MARKET CONTEXT ===\n';
  prompt+='Price: $'+px.toFixed(2)+' | RSI-14: '+r14.toFixed(1)+'\n';
  prompt+='EMA trend: '+trend+' | EMA9=$'+e9.toFixed(2)+' EMA21=$'+e21.toFixed(2)+'\n';
  if(bb)prompt+='BB: low=$'+bb.lower.toFixed(2)+' mid=$'+bb.middle.toFixed(2)+' hi=$'+bb.upper.toFixed(2)+'\n';
  prompt+='Loss streak: '+streak+'\n\n';
  prompt+='=== YOUR DECISION ===\n';
  if(sig.direction==='BUY'){
    prompt+='CONFIRM if: RSI not overbought (<65), price swept LOW (liquidity grab) and reversed UP, R:R >= 1.5\n';
    prompt+='REJECT if: RSI>70 (overbought), strong downtrend, sweep was tiny (<0.01%)\n';
  } else {
    prompt+='CONFIRM if: RSI not oversold (>35), price swept HIGH (liquidity grab) and reversed DOWN, R:R >= 1.5\n';
    prompt+='REJECT if: RSI<30 (oversold), strong uptrend, sweep was tiny (<0.01%)\n';
  }
  prompt+='Auto-CONFIRM if R:R > 2.0 (excellent setup)\n';
  prompt+='Auto-REJECT if '+streak+'+ recent losses (protect capital)\n\n';
  prompt+='Reply ONLY with JSON:\n';
  prompt+='{"confirmed":true,"confidence":82,"reason":"RSI neutral supports direction","risk":"low"}';
  return new Promise(function(resolve){
    var body=JSON.stringify({
      model:'deepseek-chat',
      messages:[
        {role:'system',content:'You are a CRT trading expert. Validate setups with JSON only. No text outside JSON.'},
        {role:'user',content:prompt}
      ],
      max_tokens:120,temperature:0.1,stream:false
    });
    var req=https.request({
      hostname:'api.deepseek.com',path:'/v1/chat/completions',method:'POST',
      headers:{'Authorization':'Bearer '+S.aiKey,'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)},
      timeout:10000
    },function(res){
      var d=''; res.on('data',function(c){d+=c;});
      res.on('end',function(){
        try{
          var resp=JSON.parse(d);
          if(resp.error){resolve({confirmed:true,reason:'AI error',confidence:65});return;}
          var raw2=resp.choices&&resp.choices[0]&&resp.choices[0].message&&resp.choices[0].message.content||'{}';
          var tokens=resp.usage&&resp.usage.total_tokens||0;
          S.aiTokensUsed+=tokens;
          S.aiCost=parseFloat((S.aiTokensUsed/1000000*0.28).toFixed(6));
          var m=raw2.match(/\{[\s\S]*\}/);
          var dec=m?JSON.parse(m[0]):{confirmed:true,confidence:65};
          dec.action=sig.direction; dec.ts=new Date().toISOString().slice(11,19); dec.price=px; dec.tokens=tokens;
          S.aiFutDecision=dec;
          resolve({confirmed:!!dec.confirmed,confidence:dec.confidence||65,reason:dec.reason||''});
        }catch(e){resolve({confirmed:true,reason:'parse-err',confidence:65});}
      });
    });
    req.on('error',function(){resolve({confirmed:true,reason:'network-err',confidence:65});});
    req.on('timeout',function(){req.destroy();resolve({confirmed:true,reason:'timeout',confidence:65});});
    req.write(body); req.end();
  });
}

// ── SPOT EXIT CHECK ──────────────────────────────────────────────────────────
function spotExitCheck(px,isPaper){
  var orders=isPaper?S.papOrders:S.liveOrders; var changed=false;
  orders.forEach(function(o){
    if(o.status!=='open')return;
    if(px>(o.peakPx||px))o.peakPx=px;
    var cur=feeMath(o.entryPx,px,o.amt).net;
    if(cur>(o.peakNet||0))o.peakNet=cur;
    // Profit protection: gave back 60% of peak
    if((o.peakNet||0)>o.amt*0.001&&cur>0&&(o.peakNet-cur)/o.peakNet>=0.60){
      closeSpotOrder(o,px,'PROTECT',isPaper); changed=true; return;
    }
    var why=null;
    if(px>=o.tp)why='TP';
    else if(px<=o.sl)why='SL';
    if(!why)return;
    closeSpotOrder(o,px,why,isPaper); changed=true;
  });
  if(changed){
    if(isPaper)S.papOrders=S.papOrders.filter(function(o){return o.status==='open';});
    else S.liveOrders=S.liveOrders.filter(function(o){return o.status==='open';});
    save();
  }
}
function closeSpotOrder(o,px,why,isPaper){
  var r=feeMath(o.entryPx,px,o.amt); o.status='closed';
  var tr={n:isPaper?++S.papT:++S.liveT,time:new Date().toISOString().slice(11,19),
    pair:S.pair,strat:o.strat,isPaper,side:why,
    entryPx:o.entryPx,exitPx:px,amt:o.amt,
    fee:+r.fee.toFixed(6),net:+r.net.toFixed(6)};
  if(isPaper){S.papProfit+=r.net;S.papFees+=r.fee;if(r.net>=0){S.papW++;if(r.net>S.papBest)S.papBest=r.net;}else S.papL++;S.papTrades.unshift(tr);if(S.papTrades.length>200)S.papTrades.length=200;}
  else{S.liveProfit+=r.net;S.todayP+=r.net;S.feesT+=r.fee;if(r.net>=0){S.liveW++;if(r.net>S.bestT)S.bestT=r.net;}else S.liveL++;S.liveTrades.unshift(tr);if(S.liveTrades.length>200)S.liveTrades.length=200;placeSpotOrder('SELL',o.qty,S.pair);}
  log((isPaper?'PAP':'LIVE')+' SPOT '+why+' @ $'+px.toFixed(2)+' NET='+(r.net>=0?'+':'')+'$'+r.net.toFixed(4),r.net>=0?'profit':'err');
}

// ── FUTURES EXIT CHECK ───────────────────────────────────────────────────────
function futExitCheck(px,isPaper){
  var orders=isPaper?S.futPapOrders:S.futOrders; var changed=false;
  orders.forEach(function(o){
    if(o.status!=='open')return;
    var isLong=o.direction!=='SHORT';
    var cur=futFee(o.entryPx,px,o.margin,o.leverage,isLong).net;
    if(cur>(o.peakNet||0))o.peakNet=cur;
    // Profit protection: in profit, gave back 60%
    if((o.peakNet||0)>o.margin*0.001&&cur>0&&(o.peakNet-cur)/o.peakNet>=0.60){
      closeFutOrder(o,px,'PROTECT',isPaper); changed=true; return;
    }
    // BE-stop: moved stop to break-even at 40% toward TP
    if(!o.beStopMoved&&isLong){
      var pct=(o.tp-o.entryPx)>0?(cur)/(futFee(o.entryPx,o.tp,o.margin,o.leverage,true).net):0;
      if(pct>=0.40&&o.bePx>o.sl){o.sl=o.bePx;o.beStopMoved=true;log('BE-stop LONG moved to $'+o.bePx.toFixed(2),'info');}
    }
    var why=null;
    if(isLong){if(px>=o.tp)why='TP';else if(px<=o.sl)why=o.beStopMoved?'BE-STOP':'SL';}
    else{if(px<=o.tp)why='TP';else if(px>=o.sl)why=o.beStopMoved?'BE-STOP':'SL';}
    if(!why)return;
    closeFutOrder(o,px,why,isPaper); changed=true;
  });
  if(changed){
    if(isPaper)S.futPapOrders=S.futPapOrders.filter(function(o){return o.status==='open';});
    else S.futOrders=S.futOrders.filter(function(o){return o.status==='open';});
    save();
  }
}
function closeFutOrder(o,px,why,isPaper){
  var isLong=o.direction!=='SHORT';
  var r=futFee(o.entryPx,px,o.margin,o.leverage,isLong); o.status='closed';
  var isLng2=o.direction!=='SHORT';
  // movePct = actual price movement (positive = price went up, negative = price went down)
  var movePct=((px-o.entryPx)/o.entryPx*100).toFixed(3);
  // levMovePct = leveraged profit direction (positive = trade was profitable)
  var levMovePct=(isLng2?1:-1)*parseFloat(movePct)*o.leverage;
  var tr={n:isPaper?++S.futPapT:++S.futT,time:new Date().toISOString().slice(11,19),
    pair:S.futPair,direction:o.direction||'LONG',isPaper,side:why,crtType:o.crtType||'',rr:o.crtRR||0,
    entryPx:o.entryPx,exitPx:px,margin:o.margin,leverage:o.leverage,notional:o.notional,
    move:movePct+'%',leveragedMove:levMovePct.toFixed(3)+'%',fee:+r.fee.toFixed(6),pnl:+r.pnl.toFixed(6),net:+r.net.toFixed(6)};
  if(isPaper){S.futPapProfit+=r.net;S.futFees+=r.fee;if(r.net>=0)S.futPapW++;else S.futPapL++;S.futPapTrades.unshift(tr);if(S.futPapTrades.length>200)S.futPapTrades.length=200;}
  else{S.futProfit+=r.net;S.futFees+=r.fee;if(r.net>=0){S.futW++;if(r.net>S.futBest)S.futBest=r.net;}else S.futL++;S.futTrades.unshift(tr);if(S.futTrades.length>200)S.futTrades.length=200;futPlaceOrder(isLong?'close_long':'close_short',o.margin,o.leverage,px,o.contracts);}
  log((isPaper?'CRT-PAP':'CRT-LIVE')+' '+o.direction+' '+why+' @ $'+px.toFixed(2)+' R:R='+(o.crtRR||0)+' NET='+(r.net>=0?'+':'')+'$'+r.net.toFixed(4),r.net>=0?'profit':'err');
}

// ── SPOT TICK ────────────────────────────────────────────────────────────────
async function onSpotTick(px){
  S.lastPx=px; PX.push(px); if(PX.length>300)PX.shift(); ticks++;
  if(!S.botOn)return;
  spotExitCheck(px,true); spotExitCheck(px,false);
  if(ticks<S.warmup)return;
  var now=Date.now(); if(now-S.lastEntry<S.cooldown)return;
  var sig=getSpotSig(px); if(!sig.signal)return;
  var papOpen=S.papOrders.filter(function(o){return o.status==='open';}).length;
  if(papOpen<S.maxPos)enterSpot(px,sig.reason,true);
  if(S.mode==='live'&&S.apiKey&&S.apiSecret){
    var liveOpen=S.liveOrders.filter(function(o){return o.status==='open';}).length;
    if(liveOpen<S.maxPos)enterSpot(px,sig.reason,false);
  }
  S.lastEntry=now;
}
function enterSpot(px,reason,isPaper){
  var amt=S.capital/S.maxPos;
  var tp=parseFloat(Math.max(px*(1+S.tpPct/100),minTpPx(px,amt)).toFixed(8));
  var sl=parseFloat((px*(1-S.slPct/100)).toFixed(8));
  var o={id:Date.now()+(isPaper?1:0),status:'open',isPaper,strat:S.strategy,entryPx:px,amt,qty:amt/px,tp,sl,peakPx:px,peakNet:0,openAt:new Date().toISOString().slice(11,19),reason};
  if(isPaper){S.papOrders.push(o);log('PAP SPOT BUY @ $'+px.toFixed(2)+' TP=$'+tp.toFixed(2)+' SL=$'+sl.toFixed(2),'buy');}
  else{S.liveOrders.push(o);log('LIVE SPOT BUY @ $'+px.toFixed(2)+' TP=$'+tp.toFixed(2)+' SL=$'+sl.toFixed(2),'buy');placeSpotOrder('BUY',o.qty,S.pair);}
}

// ══════════════════════════════════════════════════════════════════════════════
// FUTURES TICK — CRT IS THE ONLY STRATEGY
// Flow: build candle → check exits → detect CRT → AI confirms → enter
// ══════════════════════════════════════════════════════════════════════════════
async function onFutTick(px){
  S.futLastPx=px; futPX.push(px); if(futPX.length>300)futPX.shift(); futTicks++;
  if(!S.futuresOn)return;
  crtUpdateCandle(px);          // build OHLC candle from ticks
  futExitCheck(px,true);        // check paper exits
  futExitCheck(px,false);       // check live exits
  if(futTicks<5)return;
  var now=Date.now();
  if(now-S.futLastEntry<(S.futCooldown||6000))return;
  var papOpen=S.futPapOrders.filter(function(o){return o.status==='open';}).length;
  var liveOpen=S.futOrders.filter(function(o){return o.status==='open';}).length;
  if(papOpen>=S.futMaxPos&&liveOpen>=S.futMaxPos)return;

  // ── DETECT CRT SETUP ──────────────────────────────────────────────────────
  var crt=crtDetect(px);
  if(!crt){
    if(futTicks%40===0){
      var prev=S.crtCandles[0],curr=S.crtCurrentCandle;
      if(prev&&curr)log('[CRT T'+futTicks+'] $'+px.toFixed(2)+' prevH=$'+prev.h.toFixed(2)+' prevL=$'+prev.l.toFixed(2)+' tick='+curr.ticks+'/'+S.crtCandleSize+' setups='+S.crtStats.setups,'info');
    }
    return;
  }

  log('CRT SETUP: '+crt.type+' sweep='+crt.sweepDepth+'% TP=$'+crt.tp+' SL=$'+crt.sl+' R:R='+crt.rr+'x','buy');

  // ── AI CONFIRMATION ───────────────────────────────────────────────────────
  var aiOk={confirmed:true,confidence:70,reason:'no-key'};
  if(S.aiKey){
    aiOk=await crtAiConfirm(px,crt);
    if(!aiOk.confirmed||(aiOk.confidence||0)<(S.aiMinConf||65)){
      log('CRT REJECTED by AI (conf='+aiOk.confidence+'%): '+aiOk.reason,'info');
      S.crtLastSignal=Object.assign({},crt,{aiRejected:true,aiReason:aiOk.reason});
      return;
    }
    log('CRT CONFIRMED by AI conf='+aiOk.confidence+'% | '+aiOk.reason,'profit');
  }
  S.crtStats.confirmed++;
  S.crtLastSignal=Object.assign({},crt,{aiConfirmed:true,aiConf:aiOk.confidence});

  // ── ENTER WITH CRT'S EXACT TP/SL ─────────────────────────────────────────
  if(papOpen<S.futMaxPos) enterCRT(px,crt,true);
  if(S.futMode==='live'&&S.apiKey&&S.apiSecret&&liveOpen<S.futMaxPos){
    S.crtStats.entered++;
    enterCRT(px,crt,false);
  }
  S.futLastEntry=now;
}

function enterCRT(px,crt,isPaper){
  // Recovery: reduce size after losses
  var trades=isPaper?(S.futPapTrades||[]):S.futTrades;
  var streak=0; for(var i=0;i<trades.length;i++){if(trades[i].net<0)streak++;else break;}
  var mult=streak>=3?0.5:streak>=2?0.75:1.0;
  if(streak>=2)log('RECOVERY mode x'+mult+' size ('+streak+' losses)','info');
  var margin=(S.futCapital/S.futMaxPos)*mult;
  var lev=S.futLeverage, notional=margin*lev;
  var isLong=crt.direction!=='SHORT';
  var bePx=parseFloat(futBE(px,margin,lev,isLong).toFixed(4));
  var expNet=futFee(px,crt.tp,margin,lev,isLong).net;
  var contracts=Math.max(1,Math.round(notional/px));
  var o={
    id:Date.now()+(isPaper?1:0),status:'open',isPaper,isFutures:true,
    direction:isLong?'LONG':'SHORT',
    entryPx:px,margin,leverage:lev,notional,contracts,
    tp:crt.tp,sl:crt.sl,bePx,beStopMoved:false,
    peakPx:px,peakNet:0,
    crtType:crt.type,crtRR:crt.rr,
    openAt:new Date().toISOString().slice(11,19),
    openedAt:Date.now(),
    reason:crt.reason
  };
  log((isPaper?'CRT-PAPER ':'CRT-LIVE ')+(isLong?'LONG':'SHORT')+' @ $'+px.toFixed(2)+
    ' margin=$'+margin.toFixed(2)+' '+lev+'x=$'+notional.toFixed(2)+
    ' | TP=$'+crt.tp+' (+'+crt.tpPct+'%)'+
    ' SL=$'+crt.sl+' (-'+crt.slPct+'%)'+
    ' R:R='+crt.rr+'x exp=+$'+expNet.toFixed(4),'buy');
  if(isPaper)S.futPapOrders.push(o);
  else{S.futOrders.push(o);futPlaceOrder(isLong?'open_long':'open_short',margin,lev,px);}
}

// ── PRICE FEED ───────────────────────────────────────────────────────────────
let priceTimer=null, multiTimer=null, futTimer=null;
function startFeed(){
  clearInterval(priceTimer);
  priceTimer=setInterval(fetchSpotPrice,1500);
  fetchSpotPrice();
  log('Price feed: '+S.pair+' every 1.5s','info');
}
function stopFeed(){ clearInterval(priceTimer); priceTimer=null; }
function startFutFeed(){
  clearInterval(futTimer);
  futTimer=setInterval(fetchFutPrice,1500);
  fetchFutPrice();
  log('Futures feed: '+S.futPair+' every 1.5s','info');
}
function stopFutFeed(){ clearInterval(futTimer); futTimer=null; }
function startMulti(){ clearInterval(multiTimer); multiTimer=setInterval(fetchMulti,5000); fetchMulti(); }

function fetchSpotPrice(){
  var sym=S.pair.replace('/','');
  var req=https.request({hostname:'api.mexc.com',path:'/api/v3/ticker/price?symbol='+sym,method:'GET',timeout:5000},function(res){
    var d=''; res.on('data',function(c){d+=c;});
    res.on('end',function(){try{var r=JSON.parse(d);var px=parseFloat(r.price||0);if(px>0){S.prices[sym]=px;onSpotTick(px);}}catch(e){}});
  });
  req.on('error',function(){}); req.on('timeout',function(){req.destroy();}); req.end();
}
function fetchFutPrice(){
  var sym=S.futPair;
  var req=https.request({hostname:'contract.mexc.com',path:'/api/v1/contract/ticker?symbol='+sym,method:'GET',timeout:5000},function(res){
    var d=''; res.on('data',function(c){d+=c;});
    res.on('end',function(){
      try{
        var r=JSON.parse(d);
        var px=parseFloat((r.data&&r.data.lastPrice)||0);
        if(px>0){S.prices[sym]=px;onFutTick(px);}
        else{
          // fallback to spot price
          if(S.lastPx>0)onFutTick(S.lastPx);
        }
      }catch(e){if(S.lastPx>0)onFutTick(S.lastPx);}
    });
  });
  req.on('error',function(){if(S.lastPx>0)onFutTick(S.lastPx);});
  req.on('timeout',function(){req.destroy();if(S.lastPx>0)onFutTick(S.lastPx);});
  req.end();
}
function fetchMulti(){
  var req=https.request({hostname:'api.mexc.com',path:'/api/v3/ticker/price',method:'GET',timeout:5000},function(res){
    var d=''; res.on('data',function(c){d+=c;});
    res.on('end',function(){
      try{
        var arr=JSON.parse(d);
        var TOP=['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','ADAUSDT','MATICUSDT'];
        if(Array.isArray(arr))arr.forEach(function(t){if(TOP.includes(t.symbol)){var px=parseFloat(t.price);if(px>0)S.prices[t.symbol]=px;}});
      }catch(e){}
    });
  });
  req.on('error',function(){}); req.on('timeout',function(){req.destroy();}); req.end();
}

// ── MEXC ORDERS ──────────────────────────────────────────────────────────────
function placeSpotOrder(side,qty,pair){
  if(!S.apiKey||!S.apiSecret)return;
  var sym=pair.replace('/','');
  var p={symbol:sym,side:side.toUpperCase(),type:'MARKET',timestamp:Date.now(),recvWindow:5000};
  if(side==='BUY')p.quoteOrderQty=(qty*S.lastPx).toFixed(2); else p.quantity=qty.toFixed(6);
  var qs=Object.entries(p).map(function(e){return e[0]+'='+encodeURIComponent(e[1]);}).join('&');
  var sig=crypto.createHmac('sha256',S.apiSecret).update(qs).digest('hex');
  var req=https.request({hostname:'api.mexc.com',path:'/api/v3/order?'+qs+'&signature='+sig,method:'POST',headers:{'X-MEXC-APIKEY':S.apiKey,'Content-Type':'application/json'}},function(res){
    var d=''; res.on('data',function(c){d+=c;}); res.on('end',function(){try{var r=JSON.parse(d);if(r.orderId)log('SPOT ORDER '+side+' #'+r.orderId,'buy');else log('SPOT ORDER ERR: '+JSON.stringify(r),'err');}catch(e){}});
  });
  req.on('error',function(e){log('Spot order err: '+e.message,'err');}); req.end();
}
function futPlaceOrder(action,margin,lev,px,contractVol){
  if(!S.apiKey||!S.apiSecret)return;
  var isClose=action==='close_long'||action==='close_short';
  var side=action==='open_long'?1:action==='close_long'?2:action==='open_short'?3:4;
  // CLOSE: use exact contract count. OPEN: calculate from margin
  var vol=isClose&&contractVol?contractVol:Math.max(1,Math.round((margin*lev)/px));
  var ts=Date.now().toString();
  var body=JSON.stringify({symbol:S.futPair,price:px,vol:vol,side:side,type:5,openType:2,
    marketCeiling:0,priceProtect:0,reduceOnly:isClose,leverage:lev});
  var sig=crypto.createHmac('sha256',S.apiSecret).update(S.apiKey+ts+body).digest('hex');
  var tag=(isClose?'CLOSE':'OPEN')+' '+action.toUpperCase()+' vol='+vol;
  log('MEXC FUT '+tag+' px=$'+px.toFixed(2),'info');
  var req=https.request({hostname:'contract.mexc.com',path:'/api/v1/private/order/submit',method:'POST',
    headers:{'ApiKey':S.apiKey,'Request-Time':ts,'Signature':sig,'Content-Type':'application/json','Accept':'application/json'},timeout:8000},function(res){
    var d=''; res.on('data',function(c){d+=c;});
    res.on('end',function(){
      try{
        var r=JSON.parse(d);
        if(r.success){
          log('FUT ORDER OK '+tag+' orderId='+r.data,'profit');
          if(!isClose)setTimeout(fetchAndLogFutBalance,3000);
        }else{
          log('FUT ORDER FAIL code='+r.code+': '+r.message,'err');
          log('Position may still be open on MEXC! Check app. vol='+vol+' side='+side,'err');
        }
      }catch(e){log('FUT order parse err: '+d.slice(0,80),'err');}
    });
  });
  req.on('error',function(e){log('FUT order err: '+e.message,'err');});
  req.on('timeout',function(){req.destroy();log('FUT order TIMEOUT — check MEXC app!','err');});
  req.write(body); req.end();
}

function fetchAndLogFutBalance(){
  if(!S.apiKey||!S.apiSecret)return;
  var ts2=Date.now().toString();
  var sig2=crypto.createHmac('sha256',S.apiSecret).update(S.apiKey+ts2+'').digest('hex');
  var r2=https.request({hostname:'contract.mexc.com',path:'/api/v1/private/account/assets',method:'GET',
    headers:{'ApiKey':S.apiKey,'Request-Time':ts2,'Signature':sig2},timeout:6000},function(res2){
    var d2=''; res2.on('data',function(c){d2+=c;});
    res2.on('end',function(){
      try{
        var rb=JSON.parse(d2);
        if(rb.success&&rb.data){
          var arr=Array.isArray(rb.data)?rb.data:[rb.data];
          var u=arr.find(function(a){return a.currency==='USDT';});
          if(u){
            var bal=parseFloat(u.availableBalance||0);
            var eq=parseFloat(u.equity||bal);
            S.futRealBalance=bal;
            log('MEXC Futures wallet: avail=$'+bal.toFixed(4)+' equity=$'+eq.toFixed(4),'profit');
          }
        }
      }catch(e){}
    });
  });
  r2.on('error',function(){}); r2.on('timeout',function(){r2.destroy();}); r2.end();
}

// ── CORS & SEND ───────────────────────────────────────────────────────────────
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type,X-Bot-Pin');
  res.setHeader('Access-Control-Max-Age','86400');
}
function send(res,code,data){ cors(res); res.writeHead(code,{'Content-Type':'application/json'}); res.end(JSON.stringify(data)); }

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server=http.createServer(function(req,res){
  if(req.method==='OPTIONS'){cors(res);res.writeHead(204);res.end();return;}
  var url=req.url.split('?')[0];
  if(url==='/'||url==='/ping'||url==='/health'){send(res,200,{ok:true,uptime:process.uptime().toFixed(0)+'s',time:new Date().toISOString()});return;}
  if(url==='/prices'){send(res,200,{prices:S.prices,ticks,futTicks});return;}
  if(req.headers['x-bot-pin']!==BOT_PIN){send(res,401,{error:'Invalid PIN'});return;}

  if(req.method==='GET'&&url==='/status'){
    var papO=S.papOrders.filter(function(o){return o.status==='open';});
    var livO=S.liveOrders.filter(function(o){return o.status==='open';});
    var futPO=S.futPapOrders.filter(function(o){return o.status==='open';});
    var futLO=S.futOrders.filter(function(o){return o.status==='open';});
    send(res,200,{
      // Spot
      botOn:S.botOn,mode:S.mode,strategy:S.strategy,pair:S.pair,
      capital:S.capital,maxPos:S.maxPos,tpPct:S.tpPct,slPct:S.slPct,
      cooldown:S.cooldown,lastPx:S.lastPx,prices:S.prices,ticks,
      liveProfit:S.liveProfit,todayP:S.todayP,liveT:S.liveT,liveW:S.liveW,liveL:S.liveL,bestT:S.bestT,feesT:S.feesT,
      liveWR:S.liveT>0?Math.round(S.liveW/S.liveT*100):0,
      papProfit:S.papProfit,papT:S.papT,papW:S.papW,papL:S.papL,papBest:S.papBest,papFees:S.papFees,
      papWR:S.papT>0?Math.round(S.papW/S.papT*100):0,
      liveOrders:livO.map(function(o){return Object.assign({},o,{livePnl:feeMath(o.entryPx,S.lastPx,o.amt).net,peakNet:o.peakNet||0});}),
      papOrders: papO.map(function(o){return Object.assign({},o,{livePnl:feeMath(o.entryPx,S.lastPx,o.amt).net,peakNet:o.peakNet||0});}),
      liveTrades:S.liveTrades.slice(0,60),papTrades:S.papTrades.slice(0,60),
      // Futures
      futuresOn:S.futuresOn,futMode:S.futMode,futPair:S.futPair,futLastPx:S.futLastPx,
      futCapital:S.futCapital,futMaxPos:S.futMaxPos,futLeverage:S.futLeverage,
      futProfit:S.futProfit,futT:S.futT,futW:S.futW,futL:S.futL,futBest:S.futBest,futFees:S.futFees,
      futWR:S.futT>0?Math.round(S.futW/S.futT*100):0,
      futPapProfit:S.futPapProfit,futPapT:S.futPapT,futPapW:S.futPapW,futPapL:S.futPapL,
      futPapWR:S.futPapT>0?Math.round(S.futPapW/S.futPapT*100):0,
      futOrders:   futLO.map(function(o){var isL=o.direction!=='SHORT';return Object.assign({},o,{livePnl:futFee(o.entryPx,S.futLastPx||S.lastPx,o.margin,o.leverage,isL).net,peakNet:o.peakNet||0});}),
      futPapOrders:futPO.map(function(o){var isL=o.direction!=='SHORT';return Object.assign({},o,{livePnl:futFee(o.entryPx,S.futLastPx||S.lastPx,o.margin,o.leverage,isL).net,peakNet:o.peakNet||0});}),
      futTrades:S.futTrades.slice(0,60),futPapTrades:S.futPapTrades.slice(0,60),
      // CRT stats
      crtStats:S.crtStats,crtCandleSize:S.crtCandleSize,
      crtLastSignal:S.crtLastSignal,
      crtCandles:S.crtCandles.slice(0,5),
      crtCurrentCandle:S.crtCurrentCandle,
      futTicks,
      // AI
      aiEnabled:!!(S.aiKey),aiMinConf:S.aiMinConf,aiInterval:S.aiInterval,
      aiFutDecision:S.aiFutDecision,aiCallCount:S.aiCallCount,aiTokensUsed:S.aiTokensUsed,aiCost:S.aiCost,
      // Meta
      hasApiKeys:!!(S.apiKey&&S.apiSecret),startedAt:S.startedAt,savedAt:S.savedAt,
      feeRt:RT_FEE*100,futFeeRt:FUT_RT*100,
      log:S.log.slice(0,150)
    });
    return;
  }

  if(req.method==='POST'){
    var body='';
    req.on('data',function(c){body+=c;});
    req.on('end',async function(){
      var d={}; try{d=JSON.parse(body);}catch(e){}

      if(url==='/start'){
        if(S.botOn){send(res,200,{ok:true,msg:'Already running'});return;}
        S.botOn=true;S.liveOrders=[];S.papOrders=[];S.lastEntry=0;
        S.startedAt=new Date().toISOString();PX=[];ticks=0;
        startFeed();
        log('SPOT STARTED '+S.pair+' mode='+S.mode+' $'+S.capital+' TP='+S.tpPct+'% SL='+S.slPct+'%','buy');
        save();send(res,200,{ok:true});return;
      }
      if(url==='/stop'){
        S.botOn=false;S.liveOrders=[];S.papOrders=[];stopFeed();
        log('Spot bot stopped.','info');save();send(res,200,{ok:true});return;
      }
      if(url==='/startfutures'){
        S.futuresOn=true;S.futOrders=[];S.futPapOrders=[];S.futLastEntry=0;
        S.crtCandles=[];S.crtCurrentCandle=null;S.crtLastSignal=null;
        S.crtStats={setups:0,confirmed:0,entered:0};
        futPX=[];futTicks=0;
        if(d.mode)S.futMode=d.mode;
        if(d.pair)S.futPair=d.pair;
        if(d.capital)S.futCapital=parseFloat(d.capital)||20;
        if(d.leverage)S.futLeverage=parseInt(d.leverage)||3;
        if(d.maxPos)S.futMaxPos=parseInt(d.maxPos)||1;
        if(d.candleSize)S.crtCandleSize=parseInt(d.candleSize)||40;
        startFutFeed();
        log('CRT FUTURES STARTED '+S.futPair+' mode='+S.futMode+' $'+S.futCapital+' '+S.futLeverage+'x candleSize='+S.crtCandleSize+'ticks','buy');
        log('Strategy: CRT only. Waiting for first 2 candles (~'+(S.crtCandleSize*2*1.5/60).toFixed(1)+'min)...','info');
        save();send(res,200,{ok:true,candleSize:S.crtCandleSize,estWarmup:(S.crtCandleSize*2*1.5/60).toFixed(1)+'min'});return;
      }
      if(url==='/stopfutures'){
        S.futuresOn=false;S.futOrders=[];S.futPapOrders=[];stopFutFeed();
        log('Futures bot stopped.','info');save();send(res,200,{ok:true});return;
      }
      if(url==='/config'){
        if(d.pair)S.pair=d.pair.replace('/','');
        if(d.mode)S.mode=d.mode;
        if(d.capital)S.capital=parseFloat(d.capital)||20;
        if(d.maxPos)S.maxPos=parseInt(d.maxPos)||1;
        if(d.tpPct)S.tpPct=Math.max(parseFloat(d.tpPct),RT_FEE*100+0.15);
        if(d.slPct)S.slPct=Math.max(parseFloat(d.slPct),0.10);
        if(d.cooldown)S.cooldown=parseInt(d.cooldown)*1000||8000;
        if(d.apiKey&&d.apiKey!=='[saved]')S.apiKey=d.apiKey.trim();
        if(d.apiSecret&&d.apiSecret!=='[saved]')S.apiSecret=d.apiSecret.trim();
        if(d.apiKey&&d.apiSecret&&d.apiKey!=='[saved]')saveKeys(d.apiKey.trim(),d.apiSecret.trim());
        save();log('Config saved: '+S.pair+' tp='+S.tpPct+'% sl='+S.slPct+'%','info');
        send(res,200,{ok:true});return;
      }
      if(url==='/setaikey'){
        if(!d.aiKey){send(res,400,{error:'aiKey required'});return;}
        S.aiKey=d.aiKey.trim();
        if(d.aiMinConf)S.aiMinConf=parseInt(d.aiMinConf)||65;
        if(d.aiInterval)S.aiInterval=parseInt(d.aiInterval)||20;
        S.aiLastCall=0;S.aiFutLastCall=0;S.aiFutDecision=null;
        save();
        log('AI Brain activated — CRT validation mode','buy');
        log('Every CRT setup sent to DeepSeek for confirmation','info');
        send(res,200,{ok:true,aiMinConf:S.aiMinConf,aiInterval:S.aiInterval});return;
      }
      if(url==='/reset'){
        S.liveProfit=0;S.todayP=0;S.liveT=0;S.liveW=0;S.liveL=0;S.bestT=0;S.feesT=0;
        S.papProfit=0;S.papT=0;S.papW=0;S.papL=0;S.papBest=0;S.papFees=0;
        S.liveTrades=[];S.papTrades=[];S.liveOrders=[];S.papOrders=[];
        save();send(res,200,{ok:true});return;
      }
      if(url==='/resetfutures'){
        S.futProfit=0;S.futT=0;S.futW=0;S.futL=0;S.futBest=0;S.futFees=0;
        S.futPapProfit=0;S.futPapT=0;S.futPapW=0;S.futPapL=0;
        S.futTrades=[];S.futPapTrades=[];S.futOrders=[];S.futPapOrders=[];
        S.crtStats={setups:0,confirmed:0,entered:0};
        save();send(res,200,{ok:true});return;
      }
      if(url==='/closetrade'){
        var orders2=d.isPaper?S.papOrders:S.liveOrders;
        var o2=orders2.find(function(o){return String(o.id)===String(d.id)&&o.status==='open';});
        if(!o2){send(res,404,{error:'Not found'});return;}
        var px2=S.lastPx; closeSpotOrder(o2,px2,'MANUAL',!!d.isPaper);
        if(d.isPaper)S.papOrders=S.papOrders.filter(function(o){return o.status==='open';});
        else S.liveOrders=S.liveOrders.filter(function(o){return o.status==='open';});
        save();send(res,200,{ok:true,net:feeMath(o2.entryPx,px2,o2.amt).net});return;
      }
      if(url==='/closefuttrade'){
        var futOrds=d.isPaper?S.futPapOrders:S.futOrders;
        var fo=futOrds.find(function(o){return String(o.id)===String(d.id)&&o.status==='open';});
        if(!fo){send(res,404,{error:'Not found'});return;}
        var fpx=S.futLastPx||S.lastPx;
        fo.contracts=fo.contracts||Math.max(1,Math.round((fo.margin*fo.leverage)/fpx)); closeFutOrder(fo,fpx,'MANUAL',!!d.isPaper);
        if(d.isPaper)S.futPapOrders=S.futPapOrders.filter(function(o){return o.status==='open';});
        else S.futOrders=S.futOrders.filter(function(o){return o.status==='open';});
        save();send(res,200,{ok:true});return;
      }

      // ── SAVE API KEYS ──────────────────────────────────────────────────────
      if(url==='/savekeys'){
        if(!d.apiKey||!d.apiSecret){send(res,400,{error:'apiKey and apiSecret required'});return;}
        S.apiKey=d.apiKey.trim(); S.apiSecret=d.apiSecret.trim();
        saveKeys(S.apiKey,S.apiSecret); save();
        log('API keys saved key='+S.apiKey.length+'chars secret='+S.apiSecret.length+'chars','info');
        var tsT=Date.now().toString(),qsT='timestamp='+tsT+'&recvWindow=5000';
        var sigT=crypto.createHmac('sha256',S.apiSecret).update(qsT).digest('hex');
        var tReq=https.request({hostname:'api.mexc.com',path:'/api/v3/account?'+qsT+'&signature='+sigT,method:'GET',headers:{'X-MEXC-APIKEY':S.apiKey},timeout:6000},function(r2){var d2='';r2.on('data',function(c){d2+=c;});r2.on('end',function(){try{var rx=JSON.parse(d2);if(rx.balances)log('MEXC KEYS VERIFIED! Balances accessible.','profit');else log('Key test: '+JSON.stringify(rx).slice(0,80),'info');}catch(e){}});});
        tReq.on('error',function(){}); tReq.on('timeout',function(){tReq.destroy();}); tReq.end();
        send(res,200,{ok:true,keyLength:S.apiKey.length,secLength:S.apiSecret.length}); return;
      }
      // ── MODE SWITCH ────────────────────────────────────────────────────────
      if(url==='/setlive'){S.mode='live';save();log('Mode LIVE — real orders!','buy');send(res,200,{ok:true,mode:'live'});return;}
      if(url==='/setpaper'){S.mode='paper';save();log('Mode PAPER — simulation.','info');send(res,200,{ok:true,mode:'paper'});return;}
      // ── TEST CONNECTION ────────────────────────────────────────────────────
      if(url==='/testconnection'){
        if(!S.apiKey||!S.apiSecret){send(res,200,{ok:false,error:'No API keys saved'});return;}
        var tsX=Date.now().toString(),qsX='timestamp='+tsX+'&recvWindow=5000';
        var sigX=crypto.createHmac('sha256',S.apiSecret).update(qsX).digest('hex');
        var xReq=https.request({hostname:'api.mexc.com',path:'/api/v3/account?'+qsX+'&signature='+sigX,method:'GET',headers:{'X-MEXC-APIKEY':S.apiKey},timeout:6000},function(rX){var dx='';rX.on('data',function(c){dx+=c;});rX.on('end',function(){try{var rx=JSON.parse(dx);if(rx.balances){var u=rx.balances.find(function(b){return b.asset==='USDT';});send(res,200,{ok:true,balance:u?parseFloat(u.free):0,msg:'Connected!'});}else send(res,200,{ok:false,error:rx.msg||'Check keys'});}catch(e){send(res,200,{ok:false,error:'parse err'});}});});
        xReq.on('error',function(e){send(res,200,{ok:false,error:e.message});});
        xReq.on('timeout',function(){xReq.destroy();send(res,200,{ok:false,error:'timeout'});});
        xReq.end(); return;
      }
      // ── SPOT BALANCE ───────────────────────────────────────────────────────
      if(url==='/balance'){
        if(!S.apiKey||!S.apiSecret){send(res,200,{ok:false,error:'No API keys set'});return;}
        var tsB=Date.now().toString();
        var qsB='timestamp='+tsB+'&recvWindow=5000';
        var sigB=crypto.createHmac('sha256',S.apiSecret).update(qsB).digest('hex');
        var bReq=https.request({
          hostname:'api.mexc.com',
          path:'/api/v3/account?'+qsB+'&signature='+sigB,
          method:'GET',
          headers:{'X-MEXC-APIKEY':S.apiKey,'Content-Type':'application/json'},
          timeout:8000
        },function(rB){
          var dB=''; rB.on('data',function(c){dB+=c;});
          rB.on('end',function(){
            try{
              var rb=JSON.parse(dB);
              if(rb.balances){
                var coins=['USDT','BTC','ETH','BNB','SOL','XRP','DOGE'],result={};
                rb.balances.forEach(function(b){if(coins.includes(b.asset)&&parseFloat(b.free)>0)result[b.asset]=parseFloat(b.free);});
                S.mexcBalance=result; save();
                log('Spot balance: USDT=$'+(result.USDT||0).toFixed(4),'info');
                send(res,200,{ok:true,balance:result});
              }else{
                log('Spot balance err: '+JSON.stringify(rb).slice(0,100),'err');
                send(res,200,{ok:false,error:rb.msg||'API error',code:rb.code,raw:rb});
              }
            }catch(e){send(res,200,{ok:false,error:'Parse error: '+dB.slice(0,80)});}
          });
        });
        bReq.on('error',function(e){send(res,200,{ok:false,error:'Network: '+e.message});});
        bReq.on('timeout',function(){bReq.destroy();send(res,200,{ok:false,error:'Timeout'});});
        bReq.end(); return;
      }
      // ── FUTURES BALANCE ────────────────────────────────────────────────────
      if(url==='/futuresbalance'){
        if(!S.apiKey||!S.apiSecret){send(res,200,{ok:false,error:'No API keys set'});return;}
        var tsFB=Date.now().toString();
        // MEXC futures GET: sign = HMAC(apiKey + timestamp + "")
        var sigFB=crypto.createHmac('sha256',S.apiSecret).update(S.apiKey+tsFB+'').digest('hex');
        var fbReq=https.request({
          hostname:'contract.mexc.com',
          path:'/api/v1/private/account/assets',
          method:'GET',
          headers:{'ApiKey':S.apiKey,'Request-Time':tsFB,'Signature':sigFB,'Content-Type':'application/json','Accept':'application/json'},
          timeout:8000
        },function(rFB){
          var dFB=''; rFB.on('data',function(c){dFB+=c;});
          rFB.on('end',function(){
            try{
              var rfb=JSON.parse(dFB);
              if(rfb.success&&rfb.data){
                var arr=Array.isArray(rfb.data)?rfb.data:[rfb.data];
                var u2=arr.find(function(a){return a.currency==='USDT';});
                var bal=u2?parseFloat(u2.availableBalance||0):0;
                var eq=u2?parseFloat(u2.equity||bal):0;
                S.futRealBalance=bal;
                log('Futures balance: avail=$'+bal.toFixed(4)+' equity=$'+eq.toFixed(4),'info');
                send(res,200,{ok:true,balance:bal,equity:eq,raw:u2||{}});
              }else{
                log('Futures balance err: '+JSON.stringify(rfb).slice(0,100),'err');
                send(res,200,{ok:false,error:rfb.message||rfb.msg||'API error — check futures keys',raw:rfb});
              }
            }catch(e){send(res,200,{ok:false,error:'Parse error: '+dFB.slice(0,80)});}
          });
        });
        fbReq.on('error',function(e){send(res,200,{ok:false,error:'Network: '+e.message});});
        fbReq.on('timeout',function(){fbReq.destroy();send(res,200,{ok:false,error:'Timeout fetching balance'});});
        fbReq.end(); return;
      }
      // ── FUTURES CONFIG ─────────────────────────────────────────────────────
      if(url==='/configfutures'){
        if(d.futPair)    S.futPair    = d.futPair;
        if(d.futMode)    S.futMode    = d.futMode;
        if(d.futCapital) S.futCapital = parseFloat(d.futCapital)||20;
        if(d.futMaxPos)  S.futMaxPos  = parseInt(d.futMaxPos)||1;
        if(d.futLeverage)S.futLeverage= parseInt(d.futLeverage)||3;
        if(d.futTpPct)   S.futTpPct   = parseFloat(d.futTpPct)||0.45;
        if(d.futSlPct)   S.futSlPct   = parseFloat(d.futSlPct)||0.20;
        if(d.futCooldown)S.futCooldown= parseInt(d.futCooldown)*1000||6000;
        if(d.candleSize) S.crtCandleSize=parseInt(d.candleSize)||40;
        save();
        log('Futures CRT config: '+S.futPair+' '+S.futLeverage+'x $'+S.futCapital+' candle='+S.crtCandleSize+'ticks','info');
        send(res,200,{ok:true,futTpPct:S.futTpPct,futSlPct:S.futSlPct,posMargin:S.futCapital/S.futMaxPos,notional:(S.futCapital/S.futMaxPos)*S.futLeverage});
        return;
      }
      // ── AI DECISION ────────────────────────────────────────────────────────
      if(url==='/setcompound'){
        S.compoundEnabled = !!d.enabled;
        if(d.pct !== undefined) S.compoundPct = Math.min(100, Math.max(1, parseInt(d.pct)||100));
        if(!S.compoundEnabled) {
          log('Compounding DISABLED. Capital stays at $'+S.futCapital.toFixed(2),'info');
        } else {
          S.futBaseCapital = S.futCapital; // snapshot base
          log('Compounding ENABLED: reinvesting '+S.compoundPct+'% of each profit','profit');
          log('Base capital: $'+S.futBaseCapital.toFixed(2)+' | Will grow with each win','info');
        }
        save();
        send(res,200,{ok:true,enabled:S.compoundEnabled,pct:S.compoundPct,
          capital:S.futCapital,baseCapital:S.futBaseCapital,totalCompounded:S.futCompounded});
        return;
      }
      if(url==='/resetcompound'){
        S.futCapital = S.futBaseCapital || S.futCapital;
        S.futCompounded = 0;
        log('Compound reset. Capital back to base: $'+S.futCapital.toFixed(2),'info');
        save(); send(res,200,{ok:true,capital:S.futCapital}); return;
      }
      if(url==='/aidecision'){
        if(!S.aiKey){send(res,200,{ok:false,error:'No AI key set. Go to AI Brain tab and save DeepSeek key first.'});return;}
        var diagPx = S.futLastPx||S.lastPx;
        if(diagPx<=0){send(res,200,{ok:false,error:'No price data yet. Start the futures bot first, wait 5 seconds, then try again.'});return;}
        // Build a diagnostic AI call showing market + CRT status
        var rawD=(futPX.length>0?futPX:PX.map(function(p){return p.px||p;})).filter(function(v){return v>0;});
        var nD=rawD.length;
        var r14D=nD>2?calcRSI(rawD,Math.min(14,nD-1)):50;
        var e9D=nD>0?calcEMA(rawD,Math.min(9,nD)):diagPx;
        var e21D=nD>0?calcEMA(rawD,Math.min(21,nD)):diagPx;
        var bbD=nD>=10?calcBB(rawD,Math.min(20,nD)):null;
        var trendD=e9D>e21D*1.0002?'UPTREND':e9D<e21D*0.9998?'DOWNTREND':'SIDEWAYS';
        var candleCount=S.crtCandles?S.crtCandles.length:0;
        var currTick=S.crtCurrentCandle?S.crtCurrentCandle.ticks:0;
        var prevCandle=S.crtCandles&&S.crtCandles[0]?S.crtCandles[0]:null;
        var prompt='';
        prompt+='CRT Futures Bot diagnostic. Analyze current market conditions.\n\n';
        prompt+='MARKET: '+S.futPair+' px=$'+diagPx.toFixed(2)+'\n';
        prompt+='RSI14='+r14D.toFixed(1)+' EMA9=$'+e9D.toFixed(2)+' EMA21=$'+e21D.toFixed(2)+' TREND='+trendD+'\n';
        if(bbD)prompt+='BB low=$'+bbD.lower.toFixed(2)+' mid=$'+bbD.middle.toFixed(2)+' hi=$'+bbD.upper.toFixed(2)+'\n';
        prompt+='CRT: '+candleCount+' candles formed, current candle tick='+currTick+'/'+S.crtCandleSize+'\n';
        if(prevCandle)prompt+='Prev candle: H=$'+prevCandle.h.toFixed(2)+' L=$'+prevCandle.l.toFixed(2)+' range='+(((prevCandle.h-prevCandle.l)/prevCandle.l)*100).toFixed(3)+'%\n';
        prompt+='Bot P&L: fut=$'+S.futProfit.toFixed(4)+' trades='+S.futT+'\n\n';
        prompt+='Answer: 1) Is market ready for CRT setups? 2) What should I watch for? 3) Any active BUY/SHORT bias?\n';
        prompt+='Reply JSON only: {"action":"BUY","confidence":70,"reason":"market context analysis","risk":"low","tp_suggest":0.35,"sl_suggest":0.18}';
        var bodyAI=JSON.stringify({model:'deepseek-chat',messages:[{role:'system',content:'CRT trading analyst. JSON only.'},{role:'user',content:prompt}],max_tokens:150,temperature:0.1,stream:false});
        var tsAI=Date.now().toString();
        S.aiFutLastCall=Date.now(); S.aiCallCount++;
        var aiReq=https.request({hostname:'api.deepseek.com',path:'/v1/chat/completions',method:'POST',
          headers:{'Authorization':'Bearer '+S.aiKey,'Content-Type':'application/json','Content-Length':Buffer.byteLength(bodyAI)},timeout:12000},function(rAI){
          var dAI=''; rAI.on('data',function(c){dAI+=c;});
          rAI.on('end',function(){
            try{
              var resp=JSON.parse(dAI);
              if(resp.error){send(res,200,{ok:false,error:'DeepSeek: '+resp.error.message});return;}
              var txt=resp.choices&&resp.choices[0]&&resp.choices[0].message&&resp.choices[0].message.content||'{}';
              S.aiTokensUsed+=(resp.usage&&resp.usage.total_tokens||0);
              S.aiCost=parseFloat((S.aiTokensUsed/1000000*0.28).toFixed(6));
              var m2=txt.match(/\{[\s\S]*\}/);
              var dec2=m2?JSON.parse(m2[0]):{action:'HOLD',reason:'no response'};
              dec2.ts=new Date().toISOString().slice(11,19); dec2.price=diagPx;
              dec2.crtStatus={candles:candleCount,currentTick:currTick,candleSize:S.crtCandleSize,
                needMore:candleCount<2,warmupPct:Math.min(100,Math.round((candleCount*S.crtCandleSize+currTick)/(S.crtCandleSize*2)*100))};
              S.aiFutDecision=dec2;
              log('AI diagnostic: '+dec2.action+' conf='+(dec2.confidence||0)+'% | '+dec2.reason,'info');
              send(res,200,{ok:true,decision:dec2,futDecision:dec2,crtCandles:candleCount,warmup:candleCount<2});
            }catch(e){send(res,200,{ok:false,error:'AI parse error: '+e.message+' raw: '+dAI.slice(0,80)});}
          });
        });
        aiReq.on('error',function(e){send(res,200,{ok:false,error:'Network error: '+e.message});});
        aiReq.on('timeout',function(){aiReq.destroy();send(res,200,{ok:false,error:'DeepSeek timeout — check your API key and credit balance at platform.deepseek.com'});});
        aiReq.write(bodyAI); aiReq.end(); return;
      }
      // ── RESET PAPER ────────────────────────────────────────────────────────
      if(url==='/resetpaper'){S.papProfit=0;S.papT=0;S.papW=0;S.papL=0;S.papBest=0;S.papFees=0;S.papTrades=[];S.papOrders=[];save();send(res,200,{ok:true});return;}
      if(url==='/syncpositions'){
        log('Manual position sync requested...','info');
        syncMexcPositions(function(n){
          send(res,200,{ok:true,synced:n,livePositions:S.futOrders.filter(function(o){return o.status==='open';}).length});
        });
        return;
      }
      if(url==='/closeallfutures'){
        // Emergency: close ALL open futures positions on MEXC
        var openPos=S.futOrders.filter(function(o){return o.status==='open';});
        var px=S.futLastPx||S.lastPx;
        openPos.forEach(function(o){
          closeFutOrder(o,px,'EMERGENCY',false);
          log('EMERGENCY CLOSE: '+o.direction+' entry=$'+o.entryPx.toFixed(2),'err');
        });
        S.futOrders=S.futOrders.filter(function(o){return o.status==='open';});
        save();
        send(res,200,{ok:true,closed:openPos.length}); return;
      }
      send(res,404,{error:'Not found'});
    });
    return;
  }
  send(res,404,{error:'Not found'});
});

// ── SYNC MEXC POSITIONS ──────────────────────────────────────────────────────
// On startup: fetch real open positions from MEXC and add them to state.
// This prevents "ghost positions" — MEXC has open trades but bot doesn't know.
function syncMexcPositions(cb){
  if(!S.apiKey||!S.apiSecret){if(cb)cb(0);return;}
  var ts=Date.now().toString();
  var sig=crypto.createHmac('sha256',S.apiSecret).update(S.apiKey+ts+'').digest('hex');
  var req=https.request({
    hostname:'contract.mexc.com', path:'/api/v1/private/position/open_positions',
    method:'GET', headers:{'ApiKey':S.apiKey,'Request-Time':ts,'Signature':sig,'Content-Type':'application/json'},
    timeout:8000
  },function(res){
    var d=''; res.on('data',function(c){d+=c;});
    res.on('end',function(){
      try{
        var r=JSON.parse(d);
        if(!r.success||!r.data||!r.data.length){if(cb)cb(0);return;}
        var synced=0;
        r.data.forEach(function(pos){
          if(pos.symbol!==S.futPair)return;
          // Check if we already track this position
          var exists=S.futOrders.some(function(o){return o.mexcId===pos.positionId||o.status==='open';});
          if(exists)return;
          var isLong=pos.positionType===1;
          var entryPx=parseFloat(pos.openAvgPrice||0);
          var margin=parseFloat(pos.margin||S.futCapital/S.futMaxPos);
          var lev=parseInt(pos.leverage||S.futLeverage);
          var notional=margin*lev;
          // Estimate TP/SL from current price
          var curPx=S.futLastPx||entryPx;
          var tp=isLong ? entryPx*(1+S.futTpPct/100) : entryPx*(1-S.futTpPct/100);
          var sl=isLong ? entryPx*(1-S.futSlPct/100) : entryPx*(1+S.futSlPct/100);
          var o={
            id:Date.now()+synced, status:'open', isPaper:false, isFutures:true,
            direction:isLong?'LONG':'SHORT',
            entryPx:entryPx, margin:margin, leverage:lev, notional:notional,
            contracts:parseInt(pos.holdVol||1),
            tp:parseFloat(tp.toFixed(4)), sl:parseFloat(sl.toFixed(4)),
            bePx:parseFloat(futBE(entryPx,margin,lev,isLong).toFixed(4)),
            beStopMoved:false, peakPx:entryPx, peakNet:0,
            crtType:'SYNCED', crtRR:0,
            openAt:new Date().toISOString().slice(11,19),
            mexcId:pos.positionId,
            reason:'SYNCED from MEXC on startup'
          };
          S.futOrders.push(o); synced++;
          log('SYNCED ghost position: '+o.direction+' entry=$'+entryPx.toFixed(2)+' margin=$'+margin.toFixed(2)+' contracts='+o.contracts,'err');
        });
        if(synced>0){
          log('SYNCED '+synced+' MEXC position(s) that bot did not know about!','err');
          log('These positions now have estimated TP/SL. Check MEXC app and close manually if needed.','info');
          save();
        } else {
          log('MEXC position check: no ghost positions found.','info');
        }
        if(cb)cb(synced);
      }catch(e){log('Position sync error: '+e.message,'err');if(cb)cb(0);}
    });
  });
  req.on('error',function(e){log('Position sync network err: '+e.message,'err');if(cb)cb(0);});
  req.on('timeout',function(){req.destroy();if(cb)cb(0);});
  req.end();
}

// ── START ─────────────────────────────────────────────────────────────────────
server.listen(PORT,'0.0.0.0',function(){
  console.log('Server listening on 0.0.0.0:'+PORT);
  load(); loadKeys(); startMulti();
  if(S.botOn||ENV_RUN){
    S.botOn=true; S.liveOrders=[]; S.papOrders=[]; PX=[]; ticks=0;
    log('Auto-resuming spot bot...','info'); startFeed();
  } else { log('Bot ready. Press Start.','info'); }
  if(S.futuresOn){
    // DON'T wipe S.futOrders on restart — keep tracking existing positions!
    // Instead sync with MEXC to find any ghost positions
    S.futPapOrders=[]; futPX=[]; futTicks=0;
    S.crtCandles=[]; S.crtCurrentCandle=null;
    log('Auto-resuming futures CRT bot...','info');
    startFutFeed();
    // After 3s (price feed has started), sync MEXC positions
    setTimeout(function(){
      log('Checking MEXC for open positions not tracked by bot...','info');
      syncMexcPositions(function(n){
        if(n>0) log('ACTION REQUIRED: '+n+' untracked position(s) found. Dashboard now shows them.','err');
      });
    }, 3000);
  }
});
server.on('error',function(e){console.error(e);process.exit(1);});
process.on('SIGTERM',function(){save();process.exit(0);});
process.on('SIGINT', function(){save();process.exit(0);});
