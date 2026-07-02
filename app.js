/* ═══════════════════════════════════════════════════════════
   GUSERA · SATS — Self-Aware Trend System (web port)
   Port dari Pine Script v6 "Self-Aware Trend System [GUSERA]"
   Semua komputasi berjalan client-side di browser.
   ═══════════════════════════════════════════════════════════ */

const CONST = {
  MAX_HISTORY_SIGS: 100,
  BYPASS_SCORE: 12.0, MULT_SMOOTH_ALPHA: 0.15,
  // True max score ceilings for scoreBreakdown(): momScore(17)+erScore(17)+rsiScore(17)
  // +structScore(16)+breakScore(16) = 83, plus vScore which is either up to 17 (real volume)
  // or a fixed 12 (BYPASS_SCORE, no volume data — e.g. most forex/gold pairs).
  MAX_SCORE_WITH_VOLUME: 100, MAX_SCORE_NO_VOLUME: 95,
};

/* No default API key is shipped. Twelve Data keys are personal/rate-limited per account,
   so embedding one here would mean every user of this file shares (and can view-source)
   the same quota. Each user enters their own key, which is stored only in their browser's
   localStorage (see persistApiKey/restoreApiKey below) — or they can use Mode CSV, which
   needs no key at all. */
const DEFAULT_API_KEY = '';

let state = {
  apiKey:DEFAULT_API_KEY, symbol:'XAU/USD', interval:'15min', outputSize:300,
  refreshMs:30000, notif:true, sound:true,
  preset:'Auto', tpMode:'Dynamic', qualityStrength:0.4,
  useAsym:true, useCharFlip:true, useEffAtr:true, useBreakeven:false,
  timer:null, candles:[], lastBarTime:null, notifPermission:false,
  csvMode:false,
};

let lastResult = null; // most recent computeEngine() output, kept for CSV export

/* ── small numeric helpers (port of Pine util fns) ─────────── */
const clamp = (x,lo,hi)=>Math.min(hi,Math.max(lo,x));
const safeDiv = (a,b,fb)=> (b===0||!isFinite(b)) ? fb : a/b;
function mapClamp(x, inLo, inHi, outLo, outHi){
  if(inHi===inLo) return outLo;
  let t = (x-inLo)/(inHi-inLo);
  t = clamp(t,0,1);
  return outLo + t*(outHi-outLo);
}
const mapClampInv = mapClamp; // same linear interpolation, direction encoded by outLo/outHi order

function presetParams(preset, tfMinutes){
  let resolved = preset;
  if(preset==='Auto') resolved = tfMinutes<=5 ? 'Scalping' : (tfMinutes<=240 ? 'Default' : 'Swing');
  const table = {
    Scalping:{atrLen:10, baseMult:1.5, erLen:14, rsiLen:9,  slMult:1.0},
    Default: {atrLen:14, baseMult:2.0, erLen:20, rsiLen:14, slMult:1.5},
    Swing:   {atrLen:21, baseMult:2.5, erLen:30, rsiLen:21, slMult:2.0},
  };
  return {resolved, ...table[resolved]};
}
function tfToMinutes(iv){
  const map = {'1min':1,'5min':5,'15min':15,'30min':30,'1h':60,'4h':240,'1day':1440};
  return map[iv] || 15;
}

/* ── indicator series builders ──────────────────────────────── */
function trueRangeArr(c){
  const tr=[];
  for(let i=0;i<c.length;i++){
    if(i===0){ tr.push(c[i].high-c[i].low); continue; }
    tr.push(Math.max(c[i].high-c[i].low, Math.abs(c[i].high-c[i-1].close), Math.abs(c[i].low-c[i-1].close)));
  }
  return tr;
}
function rma(arr, len){ // Wilder smoothing
  const out=new Array(arr.length).fill(NaN);
  let sum=0;
  for(let i=0;i<arr.length;i++){
    if(i<len){ sum+=arr[i]; out[i] = i===len-1 ? sum/len : (i===0?arr[0]:out[i-1]); }
    else{ out[i] = (out[i-1]*(len-1) + arr[i]) / len; }
  }
  return out;
}
function smaArr(arr, len){
  const out = new Array(arr.length).fill(NaN);
  let sum=0;
  for(let i=0;i<arr.length;i++){
    sum += arr[i];
    if(i>=len) sum -= arr[i-len];
    out[i] = i>=len-1 ? sum/len : arr.slice(0,i+1).reduce((a,b)=>a+b,0)/(i+1);
  }
  return out;
}
function efficiencyRatioArr(closes, len){
  const out = new Array(closes.length).fill(0.3);
  for(let i=0;i<closes.length;i++){
    if(i<len){ out[i]=0.3; continue; }
    const dir = Math.abs(closes[i]-closes[i-len]);
    let vol=0;
    for(let k=i-len+1;k<=i;k++) vol += Math.abs(closes[k]-closes[k-1]);
    out[i] = clamp(safeDiv(dir,vol,0.3),0,1);
  }
  return out;
}
function rsiArr(closes, len){
  const out = new Array(closes.length).fill(50);
  let avgGain=0, avgLoss=0;
  for(let i=1;i<closes.length;i++){
    const diff = closes[i]-closes[i-1];
    const gain = Math.max(diff,0), loss = Math.max(-diff,0);
    if(i<=len){
      avgGain += gain/len; avgLoss += loss/len;
      out[i] = i===len ? computeRsi(avgGain,avgLoss) : 50;
    } else {
      avgGain = (avgGain*(len-1)+gain)/len;
      avgLoss = (avgLoss*(len-1)+loss)/len;
      out[i] = computeRsi(avgGain,avgLoss);
    }
  }
  function computeRsi(g,l){ if(l===0) return 100; const rs=g/l; return 100-100/(1+rs); }
  return out;
}
function rollingHighest(arr,len){ return arr.map((_,i)=>{ const s=Math.max(0,i-len+1); return Math.max(...arr.slice(s,i+1)); }); }
function rollingLowest(arr,len){ return arr.map((_,i)=>{ const s=Math.max(0,i-len+1); return Math.min(...arr.slice(s,i+1)); }); }

function pivotHighArr(highs, lp){
  const out = new Array(highs.length).fill(null);
  for(let i=lp;i<highs.length-lp;i++){
    let isPivot=true, v=highs[i];
    for(let k=i-lp;k<=i+lp;k++){ if(k!==i && highs[k]>=v){ isPivot=false; break; } }
    if(isPivot) out[i]=v;
  }
  return out;
}
function pivotLowArr(lows, lp){
  const out = new Array(lows.length).fill(null);
  for(let i=lp;i<lows.length-lp;i++){
    let isPivot=true, v=lows[i];
    for(let k=i-lp;k<=i+lp;k++){ if(k!==i && lows[k]<=v){ isPivot=false; break; } }
    if(isPivot) out[i]=v;
  }
  return out;
}

/* ── full engine: recompute everything from candle history ─── */
function computeEngine(candles, cfg){
  const n = candles.length;
  const closes = candles.map(c=>c.close), highs=candles.map(c=>c.high), lows=candles.map(c=>c.low);
  const hasVolume = candles.some(c=>c.volume>0);
  const momLen=10, structLen=20; // shared lookback lengths, used consistently below

  const tr = trueRangeArr(candles);
  const rawAtr = rma(tr, cfg.atrLen);
  const atrBaseline = smaArr(rawAtr, 100);
  const volRatio = rawAtr.map((v,i)=> safeDiv(v, atrBaseline[i]||v, 1));
  const er = efficiencyRatioArr(closes, cfg.erLen);
  const effAtr = rawAtr.map((v,i)=> cfg.useEffAtr ? v*(0.5+0.5*er[i]) : v);

  const structHi = rollingHighest(highs, structLen), structLo = rollingLowest(lows, structLen);
  const rsiVals = rsiArr(closes, cfg.rsiLen);

  // volume z (fallback to volRatio proxy when no real volume)
  const volZ = new Array(n).fill(0);
  if(hasVolume){
    const vols = candles.map(c=>c.volume);
    for(let i=0;i<n;i++){
      const s=Math.max(0,i-structLen+1); const w=vols.slice(s,i+1);
      const mean=w.reduce((a,b)=>a+b,0)/w.length;
      const sd=Math.sqrt(w.reduce((a,b)=>a+(b-mean)*(b-mean),0)/w.length)||1;
      volZ[i]=(vols[i]-mean)/sd;
    }
  }

  const tqi=new Array(n), tqiEr=new Array(n), tqiVol=new Array(n), tqiStruct=new Array(n), tqiMom=new Array(n);
  for(let i=0;i<n;i++){
    tqiEr[i]=clamp(er[i],0,1);
    tqiVol[i]= hasVolume ? mapClamp(volZ[i],-1,2,0,1) : mapClamp(volRatio[i],0.6,1.8,0,1);
    const range = structHi[i]-structLo[i];
    const pos = safeDiv(closes[i]-structLo[i], range, 0.5);
    tqiStruct[i]=clamp(Math.abs(pos-0.5)*2,0,1);
    if(i<momLen){ tqiMom[i]=0.5; }
    else{
      const windowChange = closes[i]-closes[i-momLen];
      let aligned=0;
      for(let k=0;k<momLen;k++){
        const barChange = closes[i-k]-closes[i-k-1];
        if((windowChange>0&&barChange>0)||(windowChange<0&&barChange<0)) aligned++;
      }
      tqiMom[i]=aligned/momLen;
    }
    const wSum = 0.35+0.20+0.25+0.20;
    tqi[i]=clamp((tqiEr[i]*0.35+tqiVol[i]*0.20+tqiStruct[i]*0.25+tqiMom[i]*0.20)/wSum,0,1);
  }

  // adaptive multipliers
  const activeMultSm=new Array(n), passiveMultSm=new Array(n);
  const baseMult=cfg.baseMult, adaptStrength=0.5, qualityStrength=cfg.qualityStrength, qualityCurve=1.5, asymStrength=0.5;
  for(let i=0;i<n;i++){
    const legacyAdaptFactor = 1 + adaptStrength*(0.5-er[i]);
    const qualityDeviation = Math.pow(1-tqi[i], qualityCurve);
    const tqiMult = 1-qualityStrength + qualityStrength*(0.6+0.8*qualityDeviation);
    const symMult = baseMult*legacyAdaptFactor*tqiMult;
    let activeRaw=symMult, passiveRaw=symMult;
    if(cfg.useAsym){
      activeRaw = symMult*(1-asymStrength*tqi[i]*0.3);
      passiveRaw = symMult*(1+asymStrength*tqi[i]*0.4);
    }
    activeMultSm[i] = i===0 ? activeRaw : activeMultSm[i-1]*(1-CONST.MULT_SMOOTH_ALPHA)+activeRaw*CONST.MULT_SMOOTH_ALPHA;
    passiveMultSm[i] = i===0 ? passiveRaw : passiveMultSm[i-1]*(1-CONST.MULT_SMOOTH_ALPHA)+passiveRaw*CONST.MULT_SMOOTH_ALPHA;
  }

  // adaptive supertrend
  const lowerBand=new Array(n), upperBand=new Array(n), stTrend=new Array(n), stLine=new Array(n);
  let trendStartBar=0;
  for(let i=0;i<n;i++){
    const prevTrend = i===0 ? 1 : stTrend[i-1];
    const lowerMult = prevTrend===1?activeMultSm[i]:passiveMultSm[i];
    const upperMult = prevTrend===1?passiveMultSm[i]:activeMultSm[i];
    const lowerRaw = closes[i]-lowerMult*effAtr[i];
    const upperRaw = closes[i]+upperMult*effAtr[i];
    lowerBand[i] = i===0 ? lowerRaw : (closes[i-1]>lowerBand[i-1] ? Math.max(lowerRaw,lowerBand[i-1]) : lowerRaw);
    upperBand[i] = i===0 ? upperRaw : (closes[i-1]<upperBand[i-1] ? Math.min(upperRaw,upperBand[i-1]) : upperRaw);

    const priceFlipUp = i>0 && prevTrend===-1 && closes[i]>upperBand[i-1];
    const priceFlipDown = i>0 && prevTrend===1 && closes[i]<lowerBand[i-1];
    const trendAge = i-trendStartBar;
    const prevTqi = i===0?0.5:tqi[i-1];
    // Character-flip: trend-quality collapse (prevTqi high -> tqi low) after the trend has
    // matured (trendAge>=5). In the original Pine script this was additionally gated by
    // close</>source, which is always false when source==close (as it is in this port) —
    // that made the toggle a no-op. Here we implement the intended behaviour directly:
    // a genuine quality-collapse reverses the trend even before price breaks the ST band.
    const charFlipCond = cfg.useCharFlip && prevTqi>0.55 && tqi[i]<0.25 && trendAge>=5;
    const charFlipDown = charFlipCond && prevTrend===1;
    const charFlipUp = charFlipCond && prevTrend===-1;
    const finalUp = priceFlipUp||charFlipUp, finalDown = priceFlipDown||charFlipDown;
    stTrend[i] = i===0 ? 1 : (finalUp?1:(finalDown?-1:prevTrend));
    if(i>0 && stTrend[i]!==prevTrend) trendStartBar=i;
    stLine[i] = stTrend[i]===1?lowerBand[i]:upperBand[i];
  }

  // dynamic TP scale + score breakdown + trades
  const fixedTp=[1.0,2.0,3.0];
  const pivHigh = pivotHighArr(highs,3), pivLow = pivotLowArr(lows,3);
  let lastPivH=null, lastPivL=null;

  function scoreBreakdown(i,isBuy){
    const dirMove = isBuy ? closes[i-3]-closes[i] : closes[i]-closes[i-3];
    const momScore = mapClamp(safeDiv(dirMove,effAtr[i],0), 0.3,2.0, 0,17);
    const erScore = mapClamp(er[i],0.15,0.7,0,17);
    const vScore = hasVolume ? mapClamp(volZ[i],0,3,0,17) : CONST.BYPASS_SCORE;
    const lb = Math.max(0,i-structLen+1);
    const rsiWindow = rsiVals.slice(lb,i+1);
    const rsiDepth = isBuy ? Math.max(0, 30-Math.min(...rsiWindow)) : Math.max(0, Math.max(...rsiWindow)-70);
    const rsiScore = mapClamp(rsiDepth,0,15,0,17);
    const pivDist = isBuy && lastPivL!=null ? Math.abs(closes[i]-lastPivL) : (!isBuy && lastPivH!=null ? Math.abs(lastPivH-closes[i]) : 0);
    const structScore = mapClampInv(safeDiv(pivDist,effAtr[i],0),0,1.5,16,6);
    const breakDepth = isBuy ? Math.max(0, upperBand[i-1]-closes[i-1]) : Math.max(0, closes[i-1]-lowerBand[i-1]);
    const breakScore = mapClamp(safeDiv(breakDepth,effAtr[i],0),0,1.0,0,16);
    return {momScore,erScore,vScore,rsiScore,structScore,breakScore, total: momScore+erScore+vScore+rsiScore+structScore+breakScore};
  }

  const signals=[];
  let tradeDir=0, tradeEntry=NaN, tradeSl=NaN, tradeTp=[NaN,NaN,NaN], tradeTpR=[NaN,NaN,NaN], hit=[false,false,false], entryBar=0, entryIdx=null;
  const rBuffer=[];
  let curWinStreak=0, curLossStreak=0, maxWinStreak=0, maxLossStreak=0, allCount=0, allSumR=0;

  for(let i=0;i<n;i++){
    if(pivHigh[i]!=null) lastPivH=pivHigh[i];
    if(pivLow[i]!=null) lastPivL=pivLow[i];

    const flipUp = i>0 && stTrend[i]===1 && stTrend[i-1]===-1;
    const flipDown = i>0 && stTrend[i]===-1 && stTrend[i-1]===1;

    // dynamic TP scale
    let dynScale=1;
    if(cfg.tpMode==='Dynamic'){
      const scaleFromTqi = mapClamp(tqi[i],0,1,0.5,2.0);
      const scaleFromVol = mapClamp(volRatio[i],0.5,1.8,0.5,2.0);
      dynScale = clamp(0.6*scaleFromTqi+0.4*scaleFromVol, 0.5, 2.0);
    }
    const floor1=0.5;
    const floor2 = floor1*(fixedTp[1]/Math.max(fixedTp[0],0.01));
    const floor3 = floor1*(fixedTp[2]/Math.max(fixedTp[0],0.01));
    let eff = fixedTp.map((r,idx)=> cfg.tpMode==='Dynamic' ? clamp(r*dynScale, [floor1,floor2,floor3][idx], 8.0) : r);
    const sorted = [...eff].sort((a,b)=>a-b);
    const liveTpR = sorted;

    if(i>=3 && flipUp && tradeDir<=0){
      const slBase = lastPivL!=null ? lastPivL : lows[i];
      const rawSl = slBase - cfg.slMult*effAtr[i];
      const minSl = closes[i]-cfg.slMult*effAtr[i];
      const tSl = Math.min(rawSl,minSl);
      const risk = closes[i]-tSl;
      const sb = scoreBreakdown(i,true);
      tradeDir=1; tradeEntry=closes[i]; tradeSl=tSl;
      tradeTp=[closes[i]+risk*liveTpR[0], closes[i]+risk*liveTpR[1], closes[i]+risk*liveTpR[2]];
      tradeTpR=[...liveTpR]; hit=[false,false,false]; entryBar=i; entryIdx=signals.length;
      signals.push({i, time:candles[i].time, side:'BUY', price:closes[i], score:sb.total, tqi:tqi[i],
        sl:tSl, tp1:tradeTp[0], tp2:tradeTp[1], tp3:tradeTp[2], tpR:[...tradeTpR], mode:cfg.tpMode,
        status:'OPEN', hit:[false,false,false], realizedR:null});
    } else if(i>=3 && flipDown && tradeDir>=0){
      const slBase = lastPivH!=null ? lastPivH : highs[i];
      const rawSl = slBase + cfg.slMult*effAtr[i];
      const minSl = closes[i]+cfg.slMult*effAtr[i];
      const tSl = Math.max(rawSl,minSl);
      const risk = tSl-closes[i];
      const sb = scoreBreakdown(i,false);
      tradeDir=-1; tradeEntry=closes[i]; tradeSl=tSl;
      tradeTp=[closes[i]-risk*liveTpR[0], closes[i]-risk*liveTpR[1], closes[i]-risk*liveTpR[2]];
      tradeTpR=[...liveTpR]; hit=[false,false,false]; entryBar=i; entryIdx=signals.length;
      signals.push({i, time:candles[i].time, side:'SELL', price:closes[i], score:sb.total, tqi:tqi[i],
        sl:tSl, tp1:tradeTp[0], tp2:tradeTp[1], tp3:tradeTp[2], tpR:[...tradeTpR], mode:cfg.tpMode,
        status:'OPEN', hit:[false,false,false], realizedR:null});
    }

    // hit detection for the currently open trade
    if(tradeDir!==0 && i>entryBar){
      const sig = signals[entryIdx];
      const tp1r = tradeDir===1?highs[i]>=tradeTp[0]:lows[i]<=tradeTp[0];
      const tp2r = tradeDir===1?highs[i]>=tradeTp[1]:lows[i]<=tradeTp[1];
      const tp3r = tradeDir===1?highs[i]>=tradeTp[2]:lows[i]<=tradeTp[2];
      // Optional breakeven-stop: once TP1 has been hit, move the stop for the remaining
      // position to entry (0R) instead of leaving it at the original stop. Without this,
      // realized-R for a TP1-then-reversal trade always books the full -1R on the untouched
      // legs, which is more pessimistic than how most traders actually manage the position.
      const useBe = cfg.useBreakeven && hit[0];
      const effectiveSl = useBe ? tradeEntry : tradeSl;
      const slHit = tradeDir===1?lows[i]<=effectiveSl:highs[i]>=effectiveSl;
      const beExit = slHit && useBe;
      const age = i-entryBar, timeoutHit = age>=100;
      if(tp1r && !hit[0]){ hit[0]=true; sig.hit[0]=true; }
      if(tp2r && !hit[1]){ hit[1]=true; sig.hit[1]=true; }
      if(tp3r && !hit[2]){ hit[2]=true; sig.hit[2]=true; }
      if(tp3r || slHit || timeoutHit){
        // equal-thirds simplified realized R model. Legs not yet hit book -1R (full stop loss),
        // except when exiting via the breakeven-stop above, where they book 0R instead.
        const missedLegValue = beExit ? 0 : -1;
        let legs=[hit[0]?tradeTpR[0]:missedLegValue, hit[1]?tradeTpR[1]:missedLegValue, hit[2]?tradeTpR[2]:missedLegValue];
        if(timeoutHit && !slHit && !tp3r){
          const unreal = tradeDir===1 ? (closes[i]-tradeEntry)/(tradeEntry-tradeSl) : (tradeEntry-closes[i])/(tradeSl-tradeEntry);
          legs = legs.map((v,idx)=> hit[idx] ? v : clamp(unreal,-1,tradeTpR[2]));
        }
        const realizedR = clamp(legs.reduce((a,b)=>a+b,0)/3, -1, tradeTpR[2]);
        sig.realizedR = realizedR;
        sig.status = beExit ? 'BE' : (slHit ? 'SL' : (tp3r ? 'TP3' : 'TIMEOUT'));
        rBuffer.push(realizedR);
        if(rBuffer.length>CONST.MAX_HISTORY_SIGS) rBuffer.shift();
        allCount++; allSumR+=realizedR; // all-time totals, kept separate from the 100-trade window
        if(realizedR>0){ curWinStreak++; curLossStreak=0; maxWinStreak=Math.max(maxWinStreak,curWinStreak); }
        else { curLossStreak++; curWinStreak=0; maxLossStreak=Math.max(maxLossStreak,curLossStreak); }
        tradeDir=0; entryIdx=null;
      }
    }
  }

  const last = n-1;
  const maxScoreRef = hasVolume ? CONST.MAX_SCORE_WITH_VOLUME : CONST.MAX_SCORE_NO_VOLUME;
  return {
    n, closes, highs, lows, hasVolume, maxScoreRef,
    tqi, tqiEr, tqiVol, tqiStruct, tqiMom, er, volRatio, rsiVals,
    stTrend, stLine, lowerBand, upperBand,
    signals, openTrade: tradeDir!==0 ? {dir:tradeDir, entry:tradeEntry, sl:tradeSl, tp:tradeTp, tpR:tradeTpR, hit, mode:cfg.tpMode, sig:signals[entryIdx]} : null,
    stats:{
      // windowed (last MAX_HISTORY_SIGS trades) — matches what's shown in Riwayat Sinyal / CSV
      count: rBuffer.length,
      sumR: rBuffer.reduce((a,b)=>a+b,0),
      winRate: rBuffer.length? rBuffer.filter(r=>r>0).length/rBuffer.length*100 : null,
      avgR: rBuffer.length? rBuffer.reduce((a,b)=>a+b,0)/rBuffer.length : null,
      // all-time (unbounded) — kept separately, not mixed into the windowed metrics above
      allTimeCount: allCount, allTimeSumR: allSumR,
      allTimeAvgR: allCount? allSumR/allCount : null,
      curWinStreak, curLossStreak, maxWinStreak, maxLossStreak},
    last,
  };
}

/* ═══════════════════════════════════════════════════════════
   DATA FETCH
   ═══════════════════════════════════════════════════════════ */
async function fetchCandles(){
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(state.symbol)}&interval=${state.interval}&outputsize=${state.outputSize}&apikey=${encodeURIComponent(state.apiKey)}`;
  const res = await fetch(url);
  const json = await res.json();
  if(json.status==='error' || json.code){ throw new Error(json.message || 'API error'); }
  if(!json.values) throw new Error('Format data tidak dikenal dari API.');
  const candles = json.values.map(v=>({
    time: v.datetime, open:parseFloat(v.open), high:parseFloat(v.high), low:parseFloat(v.low),
    close:parseFloat(v.close), volume: parseFloat(v.volume||0)
  })).reverse();
  return candles;
}

function parseCsv(text){
  return text.trim().split('\n').filter(l=>l.trim()).map(line=>{
    const [time,open,high,low,close,volume] = line.split(',').map(s=>s.trim());
    return {time, open:parseFloat(open), high:parseFloat(high), low:parseFloat(low), close:parseFloat(close), volume:parseFloat(volume||0)};
  });
}

/* ═══════════════════════════════════════════════════════════
   RENDER
   ═══════════════════════════════════════════════════════════ */
function setStatus(msg, kind){
  const el = document.getElementById('statusMsg');
  if(!msg){ el.className='statusMsg'; return; }
  el.textContent = msg; el.className = 'statusMsg show '+(kind||'');
}
function setModalStatus(msg, kind){
  const el = document.getElementById('modalStatus');
  if(!msg){ el.className='statusMsg'; return; }
  el.textContent = msg; el.className='statusMsg show '+(kind||'');
}
function setConn(kind, text){
  const dot = document.getElementById('connDot');
  dot.className = 'dot '+(kind||'');
  document.getElementById('connText').textContent = text;
}

function fmtPrice(v){ return isFinite(v) ? v.toFixed(2) : '—'; }

function drawGauge(tqi){
  const cv = document.getElementById('gaugeCanvas');
  const ctx = cv.getContext('2d');
  const w=cv.width, h=cv.height, cx=w/2, cy=h/2, r=w/2-8;
  ctx.clearRect(0,0,w,h);
  const start=Math.PI*0.75, end=Math.PI*2.25;
  ctx.lineWidth=8; ctx.lineCap='round';
  ctx.strokeStyle='#1c2027';
  ctx.beginPath(); ctx.arc(cx,cy,r,start,end); ctx.stroke();
  if(tqi!=null){
    const val = clamp(tqi,0,1);
    const grad = ctx.createLinearGradient(0,0,w,0);
    grad.addColorStop(0,'#FF5C5C'); grad.addColorStop(.5,'#C89B3C'); grad.addColorStop(1,'#2FD9C4');
    ctx.strokeStyle=grad;
    ctx.beginPath(); ctx.arc(cx,cy,r,start,start+(end-start)*val); ctx.stroke();
  }
}

function drawChart(res, candles){
  const canvas = document.getElementById('chartCanvas');
  const wrap = document.getElementById('chartWrap');
  const dpr = window.devicePixelRatio||1;
  canvas.width = wrap.clientWidth*dpr; canvas.height = wrap.clientHeight*dpr;
  canvas.style.width = wrap.clientWidth+'px'; canvas.style.height = wrap.clientHeight+'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr,dpr);
  const W = wrap.clientWidth, H = wrap.clientHeight;
  ctx.clearRect(0,0,W,H);

  const N = Math.min(140, candles.length);
  const startIdx = candles.length-N;
  const slice = candles.slice(startIdx);
  const stLineSlice = res.stLine.slice(startIdx);
  const stTrendSlice = res.stTrend.slice(startIdx);

  let lo=Infinity, hi=-Infinity;
  slice.forEach((c,idx)=>{ lo=Math.min(lo,c.low,stLineSlice[idx]); hi=Math.max(hi,c.high,stLineSlice[idx]); });
  if(res.openTrade){ [res.openTrade.sl, ...res.openTrade.tp].forEach(v=>{ lo=Math.min(lo,v); hi=Math.max(hi,v); }); }
  const pad=(hi-lo)*0.08 || 1; lo-=pad; hi+=pad;

  const marginL=6, marginR=54, marginTop=8, marginBottom=20;
  const plotW = W-marginL-marginR, plotH = H-marginTop-marginBottom;
  const x = i => marginL + (i/(N-1===0?1:N-1))*plotW;
  const y = v => marginTop + (1-(v-lo)/(hi-lo))*plotH;

  // grid + axis labels
  ctx.strokeStyle = '#1a1e24'; ctx.fillStyle='#565C64'; ctx.font='10px IBM Plex Mono'; ctx.lineWidth=1;
  for(let g=0; g<=4; g++){
    const v = lo + (hi-lo)*g/4;
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(marginL,yy); ctx.lineTo(W-marginR,yy); ctx.stroke();
    ctx.fillText(v.toFixed(2), W-marginR+6, yy+3);
  }

  // candles
  const cw = Math.max(2, plotW/N*0.6);
  slice.forEach((c,i)=>{
    const xi = x(i);
    const up = c.close>=c.open;
    ctx.strokeStyle = up?'#2FD9C4':'#FF5C5C';
    ctx.fillStyle = up?'#2FD9C4':'#FF5C5C';
    ctx.beginPath(); ctx.moveTo(xi,y(c.high)); ctx.lineTo(xi,y(c.low)); ctx.stroke();
    const oy=y(c.open), cy2=y(c.close);
    ctx.fillRect(xi-cw/2, Math.min(oy,cy2), cw, Math.max(1,Math.abs(cy2-oy)));
  });

  // supertrend line, colored by trend + tqi brightness
  for(let i=1;i<slice.length;i++){
    const bull = stTrendSlice[i]===1;
    ctx.strokeStyle = bull ? '#2FD9C4' : '#FF5C5C';
    ctx.globalAlpha = 0.85;
    ctx.lineWidth=2;
    ctx.beginPath(); ctx.moveTo(x(i-1), y(stLineSlice[i-1])); ctx.lineTo(x(i), y(stLineSlice[i])); ctx.stroke();
  }
  ctx.globalAlpha=1;

  // active trade levels
  if(res.openTrade){
    const ot = res.openTrade;
    const lines = [[ot.sl,'#FF1744','SL'], [ot.tp[0],'#00E676','TP1'], [ot.tp[1],'#00E676','TP2'], [ot.tp[2],'#00E676','TP3'], [ot.entry,'#8b9098','ENTRY']];
    lines.forEach(([v,color,label])=>{
      const yy=y(v);
      ctx.strokeStyle=color; ctx.setLineDash([4,3]); ctx.lineWidth=1;
      ctx.beginPath(); ctx.moveTo(marginL,yy); ctx.lineTo(W-marginR,yy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle=color; ctx.font='9px IBM Plex Mono';
      ctx.fillText(label, marginL+2, yy-2);
    });
  }

  // buy/sell markers
  res.signals.forEach(sig=>{
    if(sig.i<startIdx) return;
    const idx = sig.i-startIdx;
    const xi=x(idx);
    ctx.fillStyle = sig.side==='BUY' ? '#2FD9C4' : '#FF5C5C';
    ctx.beginPath();
    if(sig.side==='BUY'){ ctx.moveTo(xi-5,y(slice[idx].low)+14); ctx.lineTo(xi+5,y(slice[idx].low)+14); ctx.lineTo(xi,y(slice[idx].low)+4); }
    else{ ctx.moveTo(xi-5,y(slice[idx].high)-14); ctx.lineTo(xi+5,y(slice[idx].high)-14); ctx.lineTo(xi,y(slice[idx].high)-4); }
    ctx.closePath(); ctx.fill();
  });
}

function renderAll(res, candles){
  const last = res.last;
  const lastClose = res.closes[last];
  const prevClose = res.closes[last-1] ?? lastClose;
  const priceEl = document.getElementById('priceNow');
  priceEl.textContent = fmtPrice(lastClose);
  priceEl.className = 'priceNow '+(lastClose>=prevClose?'up':'down');
  document.getElementById('priceSub').textContent = `${state.symbol} · ${state.interval} · update ${new Date().toLocaleTimeString('id-ID')}`;

  const trendTag = document.getElementById('trendTag');
  const bull = res.stTrend[last]===1;
  trendTag.textContent = bull ? '▲ BULLISH' : '▼ BEARISH';
  trendTag.className = 'trendTag '+(bull?'bull':'bear');

  // gauge
  const tqiNow = res.tqi[last];
  document.getElementById('tqiVal').textContent = tqiNow.toFixed(2);
  document.getElementById('tqiRegime').textContent = tqiNow>0.6?'Trend kuat':tqiNow>0.35?'Netral':'Choppy';
  drawGauge(tqiNow);
  const factors = [['fEr','fErV',res.tqiEr[last]],['fVol','fVolV',res.tqiVol[last]],['fStruct','fStructV',res.tqiStruct[last]],['fMom','fMomV',res.tqiMom[last]]];
  factors.forEach(([barId,valId,v])=>{
    document.getElementById(barId).style.width = (clamp(v,0,1)*100).toFixed(0)+'%';
    document.getElementById(valId).textContent = v.toFixed(2);
  });

  // trade card
  const ot = res.openTrade;
  const posStatus = document.getElementById('posStatus');
  if(ot){
    posStatus.textContent = ot.dir===1?'BUY':'SELL';
    posStatus.className = 'statusPill '+(ot.dir===1?'buy':'sell');
    document.getElementById('tEntry').textContent = fmtPrice(ot.entry);
    document.getElementById('tSl').textContent = fmtPrice(ot.sl);
    document.getElementById('tTp1').textContent = fmtPrice(ot.tp[0]) + (ot.hit[0]?' ✓':'');
    document.getElementById('tTp2').textContent = fmtPrice(ot.tp[1]) + (ot.hit[1]?' ✓':'');
    document.getElementById('tTp3').textContent = fmtPrice(ot.tp[2]) + (ot.hit[2]?' ✓':'');
    document.getElementById('tTp1').className = 'v'+(ot.hit[0]?' hit':'');
    document.getElementById('tTp2').className = 'v'+(ot.hit[1]?' hit':'');
    document.getElementById('tTp3').className = 'v'+(ot.hit[2]?' hit':'');
    document.getElementById('tMode').textContent = ot.mode;
    document.getElementById('tScore').textContent = ot.sig ? ot.sig.score.toFixed(1)+' /'+res.maxScoreRef : '—';
  } else {
    posStatus.textContent='FLAT'; posStatus.className='statusPill flat';
    ['tEntry','tSl','tTp1','tTp2','tTp3','tMode','tScore'].forEach(id=>{ document.getElementById(id).textContent='—'; document.getElementById(id).className='v'; });
  }

  // stats
  const st = res.stats;
  // Win rate & Avg R both use the same windowed sample (last MAX_HISTORY_SIGS trades) as
  // the Riwayat Sinyal table/CSV, so the numerator/denominator always agree.
  document.getElementById('sWinRate').textContent = st.winRate!=null ? st.winRate.toFixed(0)+'%' : '—';
  document.getElementById('sWinRate').className = 'v '+(st.winRate>50?'pos':st.winRate!=null&&st.winRate<=50?'neg':'');
  document.getElementById('sWinRate').title = `Berdasarkan ${st.count} trade terakhir (maks ${CONST.MAX_HISTORY_SIGS}). All-time: ${st.allTimeCount} trade.`;
  document.getElementById('sAvgR').textContent = st.avgR!=null ? st.avgR.toFixed(2)+'R' : '—';
  document.getElementById('sAvgR').className = 'v '+(st.avgR>0?'pos':st.avgR!=null&&st.avgR<=0?'neg':'');
  document.getElementById('sAvgR').title = st.allTimeAvgR!=null ? `All-time avg R (${st.allTimeCount} trade): ${st.allTimeAvgR.toFixed(2)}R` : '';
  document.getElementById('sCount').textContent = st.count;
  document.getElementById('sCount').title = `Jendela statistik: ${st.count} trade terakhir · All-time: ${st.allTimeCount} trade`;
  document.getElementById('sStreak').textContent = st.curWinStreak>0 ? st.curWinStreak+'W' : (st.curLossStreak>0? st.curLossStreak+'L':'—');
  document.getElementById('sStreak').title = `Rekor: ${st.maxWinStreak}W beruntun / ${st.maxLossStreak}L beruntun`;

  // log
  renderLog(res.signals);
  drawChart(res, candles);
}

function historyRows(signals){
  const closed = signals.filter(s=>s.status!=='OPEN').slice(-CONST.MAX_HISTORY_SIGS).reverse();
  const open = signals.filter(s=>s.status==='OPEN');
  return [...open.reverse(), ...closed];
}

function renderLog(signals){
  const body = document.getElementById('logBody');
  const rows = historyRows(signals);
  document.getElementById('logCount').textContent = Math.min(signals.length,CONST.MAX_HISTORY_SIGS)+' / '+signals.length+' sinyal';
  document.getElementById('logEmpty').style.display = rows.length? 'none':'block';
  body.innerHTML = rows.map(s=>{
    const rTxt = s.realizedR!=null ? (s.realizedR>=0?'+':'')+s.realizedR.toFixed(2)+'R' : '—';
    const rCls = s.realizedR!=null ? (s.realizedR>=0?'pos':'neg') : '';
    return `<tr>
      <td>${s.time}</td>
      <td><span class="sideBadge ${s.side==='BUY'?'buy':'sell'}">${s.side}</span></td>
      <td>${fmtPrice(s.price)}</td>
      <td>${s.score.toFixed(1)}</td>
      <td>${s.tqi.toFixed(2)}</td>
      <td>${fmtPrice(s.sl)}</td>
      <td>${fmtPrice(s.tp1)}${s.hit[0]?' ✓':''}</td>
      <td>${fmtPrice(s.tp2)}${s.hit[1]?' ✓':''}</td>
      <td>${fmtPrice(s.tp3)}${s.hit[2]?' ✓':''}</td>
      <td>${s.status}</td>
      <td class="rval ${rCls}">${rTxt}</td>
    </tr>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════
   ALERTS
   ═══════════════════════════════════════════════════════════ */
function beep(){
  try{
    const ctxA = new (window.AudioContext||window.webkitAudioContext)();
    const o = ctxA.createOscillator(), g = ctxA.createGain();
    o.type='sine'; o.frequency.value=880; g.gain.value=0.08;
    o.connect(g); g.connect(ctxA.destination);
    o.start(); o.stop(ctxA.currentTime+0.18);
  }catch(e){}
}
function notify(sig){
  if(state.sound) beep();
  if(state.notif && state.notifPermission){
    try{
      new Notification(`GUSERA SATS — ${sig.side} ${state.symbol}`, {
        body: `Harga ${fmtPrice(sig.price)} · Skor ${sig.score.toFixed(0)}/${lastResult?lastResult.maxScoreRef:CONST.MAX_SCORE_WITH_VOLUME} · SL ${fmtPrice(sig.sl)} · TP1 ${fmtPrice(sig.tp1)}`,
      });
    }catch(e){}
  }
}

/* ═══════════════════════════════════════════════════════════
   MAIN LOOP
   ═══════════════════════════════════════════════════════════ */
let prevSignalCount = 0;

async function runCycle(){
  try{
    setConn('', 'Mengambil data…');
    const candles = await fetchCandles();
    state.candles = candles;
    processAndRender(candles);
    setConn('live','Live · '+new Date().toLocaleTimeString('id-ID'));
    setStatus('');
  }catch(err){
    setConn('err','Gagal ambil data');
    setStatus('Fetch gagal: '+err.message+' — cek API key, atau pakai mode CSV di Pengaturan.', 'err');
  }
}

function processAndRender(candles){
  if(candles.length<60){ setStatus('Data terlalu sedikit ('+candles.length+' candle). Perbesar outputsize atau cek symbol/interval.', 'err'); return; }
  const tfMinutes = tfToMinutes(state.interval);
  const pp = presetParams(state.preset, tfMinutes);
  const cfg = {
    atrLen: pp.atrLen, baseMult: pp.baseMult, erLen: pp.erLen, rsiLen: pp.rsiLen, slMult: pp.slMult,
    tpMode: state.tpMode, qualityStrength: state.qualityStrength,
    useAsym: state.useAsym, useCharFlip: state.useCharFlip, useEffAtr: state.useEffAtr,
    useBreakeven: state.useBreakeven,
  };
  const res = computeEngine(candles, cfg);
  lastResult = res; // set before notify() so it always reflects the current cycle's maxScoreRef
  if(res.signals.length>prevSignalCount){
    const newSigs = res.signals.slice(prevSignalCount);
    newSigs.forEach(s=>notify(s));
  }
  prevSignalCount = res.signals.length;
  renderAll(res, candles);
}

function startLoop(){
  if(state.timer) clearInterval(state.timer);
  runCycle();
  state.timer = setInterval(runCycle, state.refreshMs);
}
function stopLoop(){ if(state.timer){ clearInterval(state.timer); state.timer=null; } }

/* ═══════════════════════════════════════════════════════════
   UI WIRING
   ═══════════════════════════════════════════════════════════ */
const overlay = document.getElementById('overlay');
document.getElementById('settingsBtn').onclick = ()=> overlay.classList.add('open');
document.getElementById('closeModalBtn').onclick = ()=> overlay.classList.remove('open');

document.querySelectorAll('.tabBtn').forEach(btn=>{
  btn.onclick = ()=>{
    document.querySelectorAll('.tabBtn').forEach(b=>b.classList.remove('active'));
    document.querySelectorAll('.tabPane').forEach(p=>p.classList.remove('active'));
    btn.classList.add('active');
    document.querySelector(`.tabPane[data-pane="${btn.dataset.tab}"]`).classList.add('active');
  };
});

function collectSettingsFromForm(){
  state.apiKey = document.getElementById('apiKeyInput').value.trim();
  state.refreshMs = parseInt(document.getElementById('refreshSel').value,10);
  state.outputSize = clamp(parseInt(document.getElementById('outputSizeInput').value,10)||300,100,500);
  state.preset = document.getElementById('presetSel').value;
  state.tpMode = document.getElementById('tpModeSel').value;
  state.qualityStrength = clamp(parseFloat(document.getElementById('qualityStrengthInput').value)||0.4,0,1);
  state.useAsym = document.getElementById('asymToggle').checked;
  state.useCharFlip = document.getElementById('charFlipToggle').checked;
  state.useEffAtr = document.getElementById('effAtrToggle').checked;
  state.useBreakeven = document.getElementById('breakevenToggle').checked;
  state.notif = document.getElementById('notifToggle').checked;
  state.sound = document.getElementById('soundToggle').checked;
  state.symbol = document.getElementById('symbolSel').value;
  state.interval = document.getElementById('tfSel').value;
}

const LS_KEY = 'gusera_sats_api_key';
function persistApiKey(){
  try{
    if(state.apiKey) localStorage.setItem(LS_KEY, state.apiKey);
  }catch(e){ /* Safari private mode / storage disabled — ignore */ }
}
function restoreApiKey(){
  let saved = null;
  try{ saved = localStorage.getItem(LS_KEY); }catch(e){}
  const key = saved || DEFAULT_API_KEY;
  document.getElementById('apiKeyInput').value = key;
  state.apiKey = key;
}

document.getElementById('saveStartBtn').onclick = async ()=>{
  collectSettingsFromForm();
  if(!state.apiKey){ setModalStatus('Isi API key Twelve Data dulu, atau gunakan tab Mode CSV.', 'err'); return; }
  persistApiKey();
  setModalStatus('Pengaturan disimpan.', 'ok');
  overlay.classList.remove('open');
  prevSignalCount = 0;
  startLoop();
};

document.getElementById('csvLoadBtn').onclick = ()=>{
  const text = document.getElementById('csvInput').value;
  if(!text.trim()){ setModalStatus('Tempel data CSV dulu.', 'err'); return; }
  try{
    const candles = parseCsv(text);
    stopLoop();
    state.csvMode = true;
    collectSettingsFromForm();
    prevSignalCount = 0;
    processAndRender(candles);
    setConn('', 'Mode CSV (statis, tanpa auto-refresh)');
    setModalStatus('Data CSV dimuat: '+candles.length+' candle.', 'ok');
    overlay.classList.remove('open');
  }catch(e){ setModalStatus('Gagal parse CSV: '+e.message, 'err'); }
};

document.getElementById('startBtn').onclick = async ()=>{
  collectSettingsFromForm();
  if(!state.apiKey){ overlay.classList.add('open'); setModalStatus('Isi API key dulu untuk mulai live, atau pakai Mode CSV.', 'err'); return; }
  if(state.notif && 'Notification' in window){
    try{ const p = await Notification.requestPermission(); state.notifPermission = p==='granted'; }catch(e){}
  }
  prevSignalCount = 0;
  startLoop();
};

document.getElementById('symbolSel').onchange = ()=>{ state.symbol = document.getElementById('symbolSel').value; if(state.timer) startLoop(); };
document.getElementById('tfSel').onchange = ()=>{ state.interval = document.getElementById('tfSel').value; if(state.timer) startLoop(); };

let resizeT=null;
window.addEventListener('resize', ()=>{
  clearTimeout(resizeT);
  resizeT = setTimeout(()=>{
    if(lastResult && state.candles.length) drawChart(lastResult, state.candles);
  }, 120);
});
// iOS Safari fires orientationchange separately/earlier than resize in some versions
window.addEventListener('orientationchange', ()=>{
  setTimeout(()=>{ if(lastResult && state.candles.length) drawChart(lastResult, state.candles); }, 250);
});
function currentCfg(){
  const tfMinutes = tfToMinutes(state.interval);
  const pp = presetParams(state.preset, tfMinutes);
  return { atrLen: pp.atrLen, baseMult: pp.baseMult, erLen: pp.erLen, rsiLen: pp.rsiLen, slMult: pp.slMult,
    tpMode: state.tpMode, qualityStrength: state.qualityStrength, useAsym: state.useAsym, useCharFlip: state.useCharFlip, useEffAtr: state.useEffAtr };
}

/* ═══════════════════════════════════════════════════════════
   TOAST
   ═══════════════════════════════════════════════════════════ */
let toastT=null;
function toast(msg){
  const el = document.getElementById('toast');
  if(!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(()=> el.classList.remove('show'), 2600);
}

/* ═══════════════════════════════════════════════════════════
   DOWNLOAD RIWAYAT (CSV, maks 100 baris)
   ═══════════════════════════════════════════════════════════ */
function csvEscape(v){
  const s = String(v);
  return /[",\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s;
}
function downloadHistoryCsv(){
  if(!lastResult || !lastResult.signals || !lastResult.signals.length){
    toast('Belum ada riwayat sinyal untuk diunduh.');
    return;
  }
  const rows = historyRows(lastResult.signals).slice().reverse(); // chronological, oldest→newest
  const header = ['Waktu','Simbol','Timeframe','Sisi','Harga','Skor','Purity','SL','TP1','TP1_Hit','TP2','TP2_Hit','TP3','TP3_Hit','Status','RealizedR'];
  const lines = [header.join(',')];
  rows.forEach(s=>{
    lines.push([
      s.time, state.symbol, state.interval, s.side, fmtPrice(s.price), s.score.toFixed(1), s.tqi.toFixed(2),
      fmtPrice(s.sl), fmtPrice(s.tp1), s.hit[0]?'YES':'NO', fmtPrice(s.tp2), s.hit[1]?'YES':'NO',
      fmtPrice(s.tp3), s.hit[2]?'YES':'NO', s.status, s.realizedR!=null?s.realizedR.toFixed(2):''
    ].map(csvEscape).join(','));
  });
  const csv = '\uFEFF'+lines.join('\r\n'); // BOM so Excel/Numbers on iOS read it correctly
  const blob = new Blob([csv], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  a.href = url;
  a.download = `gusera-sats-riwayat_${state.symbol.replace('/','')}_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
  toast('Riwayat diunduh ('+rows.length+' baris).');
}

/* ═══════════════════════════════════════════════════════════
   RESET
   ═══════════════════════════════════════════════════════════ */
function resetUI(){
  document.getElementById('priceNow').textContent = '—';
  document.getElementById('priceNow').className = 'priceNow';
  document.getElementById('priceSub').textContent = 'Klik Mulai untuk memuat data';
  const trendTag = document.getElementById('trendTag');
  trendTag.textContent = 'MENUNGGU DATA';
  trendTag.className = 'trendTag';
  trendTag.style.background = '#1c2027'; trendTag.style.color = 'var(--text-dim)'; trendTag.style.border = '1px solid var(--border)';
  setStatus('');
  document.getElementById('tqiVal').textContent = '—';
  document.getElementById('tqiRegime').textContent = '—';
  drawGauge(null);
  ['fEr','fVol','fStruct','fMom'].forEach(id=> document.getElementById(id).style.width='0%');
  ['fErV','fVolV','fStructV','fMomV'].forEach(id=> document.getElementById(id).textContent='—');
  document.getElementById('posStatus').textContent='FLAT';
  document.getElementById('posStatus').className='statusPill flat';
  ['tEntry','tSl','tTp1','tTp2','tTp3','tMode','tScore'].forEach(id=>{ document.getElementById(id).textContent='—'; document.getElementById(id).className='v'; });
  document.getElementById('sWinRate').textContent='—'; document.getElementById('sWinRate').className='v';
  document.getElementById('sAvgR').textContent='—'; document.getElementById('sAvgR').className='v';
  document.getElementById('sCount').textContent='—';
  document.getElementById('sStreak').textContent='—';
  document.getElementById('logBody').innerHTML='';
  document.getElementById('logCount').textContent='0 sinyal';
  document.getElementById('logEmpty').style.display='block';
  const canvas = document.getElementById('chartCanvas');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  setConn('', 'Belum terhubung');
}

function resetApp(){
  stopLoop();
  state.candles = [];
  state.csvMode = false;
  prevSignalCount = 0;
  lastResult = null;
  resetUI();
  toast('Data & riwayat direset.');
}

document.getElementById('downloadHistoryBtn').onclick = downloadHistoryCsv;
document.getElementById('resetBtn').onclick = ()=>{
  const ok = window.confirm('Reset akan menghentikan live update dan menghapus seluruh riwayat sinyal serta chart saat ini. Pengaturan & API key tetap tersimpan. Lanjutkan?');
  if(ok) resetApp();
};

/* ═══════════════════════════════════════════════════════════
   iOS SAFARI: unlock AudioContext on first user gesture
   (autoplay/audio policies block sound until a tap happens)
   ═══════════════════════════════════════════════════════════ */
let audioUnlocked = false;
function unlockAudioOnce(){
  if(audioUnlocked) return;
  audioUnlocked = true;
  try{
    const ctxA = new (window.AudioContext||window.webkitAudioContext)();
    if(ctxA.state === 'suspended') ctxA.resume();
    ctxA.close();
  }catch(e){}
  window.removeEventListener('touchend', unlockAudioOnce);
  window.removeEventListener('click', unlockAudioOnce);
}
window.addEventListener('touchend', unlockAudioOnce, {once:true});
window.addEventListener('click', unlockAudioOnce, {once:true});

// init
drawGauge(null);
restoreApiKey();
