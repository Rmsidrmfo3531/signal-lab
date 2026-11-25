// Zero-dependency Canvas 2D interactive candlestick chart for real-account trading.
// Supports OHLCV candles, volume histogram, EMA20/50, open position entry/liq lines,
// open order lines (Limit/TP/SL), draft order preview lines, crosshair, zoom/pan, and click-to-trade.

const KST_MS=9*3600000;
const fin=v=>v!==null&&v!==''&&Number.isFinite(Number(v));

function fmtPx(v,tick=null){
 const n=Number(v);
 if(!Number.isFinite(n)||n<=0)return '—';
 if(tick&&Number(tick)>0){
  const s=String(tick);
  const dec=s.includes('e-')?Number(s.split('e-')[1]):(s.split('.')[1]?.length||0);
  return n.toFixed(Math.min(8,dec));
 }
 return n>=1000?n.toFixed(1):n>=1?n.toFixed(3):String(+n.toPrecision(5));
}

function fmtVol(v){
 const n=Number(v);
 if(!Number.isFinite(n))return '—';
 if(n>=1e9)return (n/1e9).toFixed(2)+'B';
 if(n>=1e6)return (n/1e6).toFixed(2)+'M';
 if(n>=1e3)return (n/1e3).toFixed(1)+'K';
 return n.toFixed(1);
}

function fmtKstTime(ms,interval){
 const d=new Date(Number(ms)+KST_MS);
 const mm=String(d.getUTCMonth()+1).padStart(2,'0');
 const dd=String(d.getUTCDate()).padStart(2,'0');
 const hh=String(d.getUTCHours()).padStart(2,'0');
 const mi=String(d.getUTCMinutes()).padStart(2,'0');
 if(interval==='1d')return `${mm}/${dd}`;
 return `${mm}/${dd} ${hh}:${mi}`;
}

function calcEma(values,period){
 const out=new Array(values.length).fill(null);
 if(values.length<period)return out;
 const k=2/(period+1);
 let sum=0;
 for(let i=0;i<period;i++)sum+=values[i];
 let prev=sum/period;
 out[period-1]=prev;
 for(let i=period;i<values.length;i++){
  prev=values[i]*k+prev*(1-k);
  out[i]=prev;
 }
 return out;
}

export function roundToTick(price,tick){
 const p=Number(price),t=Number(tick);
 if(!Number.isFinite(p)||p<=0)return null;
 if(!Number.isFinite(t)||t<=0)return Number(p.toPrecision(6));
 const s=String(tick);
 const dec=s.includes('e-')?Number(s.split('e-')[1]):(s.split('.')[1]?.length||0);
 return Number((Math.round(p/t)*t).toFixed(Math.min(8,dec)));
}

export function createRealTradeChart(canvas,{onSelectPrice=()=>{}}={}){
 const state={
  candles:[], // [time, open, high, low, close, vol]
  interval:'15m',
  tickSize:null,
  livePrice:null,
  positions:[], // [{direction, avg, size, unrealized, roePct, liquidation, origin}]
  orders:[], // [{type, side, positionSide, price, stopPrice, origQty}]
  draft:{orderType:'MARKET',limitPrice:null,tpPrice:null,slPrice:null},
  showEma:true,
  visibleCount:80,
  rightOffset:0, // bars shifted left from latest candle
  hover:null, // {x, y}
  selectedPrice:null,
  dragging:false,
  dragStartX:0,
  dragStartOffset:0,
  dragMoved:false,
  layout:null,
 };

 const dpr=()=>Math.min(2,window.devicePixelRatio||1);

 function getSlice(){
  const n=state.candles.length;
  if(!n)return {start:0,end:0,bars:[]};
  const count=Math.max(20,Math.min(n,state.visibleCount));
  const maxOff=Math.max(0,n-count);
  state.rightOffset=Math.max(0,Math.min(maxOff,Math.round(state.rightOffset)));
  const end=n-state.rightOffset;
  const start=Math.max(0,end-count);
  return {start,end,bars:state.candles.slice(start,end)};
 }

 function draw(){
  if(!canvas||typeof canvas.getContext!=='function')return;
  const rect=canvas.getBoundingClientRect();
  const W=Math.max(280,Math.floor(rect.width||canvas.clientWidth||600));
  const H=Math.max(220,Math.floor(rect.height||canvas.clientHeight||360));
  const ratio=dpr();
  if(canvas.width!==Math.floor(W*ratio)||canvas.height!==Math.floor(H*ratio)){
   canvas.width=Math.floor(W*ratio);
   canvas.height=Math.floor(H*ratio);
  }
  const ctx=canvas.getContext('2d');
  ctx.setTransform(ratio,0,0,ratio,0,0);

  // Background
  ctx.fillStyle='#07101b';
  ctx.fillRect(0,0,W,H);

  const {start,bars}=getSlice();
  if(!bars.length){
   ctx.fillStyle='#7f93ad';
   ctx.font='12px system-ui, -apple-system, sans-serif';
   ctx.textAlign='center';
   ctx.fillText('차트 데이터를 불러오는 중입니다…',W/2,H/2);
   state.layout=null;
   return;
  }

  const padL=8,padR=74,padT=28,padB=24;
  const plotW=Math.max(80,W-padL-padR);
  const volH=Math.max(28,Math.floor((H-padT-padB)*0.16));
  const priceH=Math.max(100,H-padT-padB-volH-6);
  const volTop=padT+priceH+6;

  // Price bounds (include candles + nearby active position entry / livePrice / selectedPrice)
  let lo=Infinity,hi=-Infinity,maxVol=0;
  for(const b of bars){
   if(b[3]<lo)lo=b[3];
   if(b[2]>hi)hi=b[2];
   if(b[5]>maxVol)maxVol=b[5];
  }
  if(fin(state.livePrice)){
   const lp=Number(state.livePrice);
   if(lp>0){lo=Math.min(lo,lp);hi=Math.max(hi,lp)}
  }
  const baseSpan=Math.max(hi-lo,hi*0.002||1e-6);
  // Gently expand bounds to keep open position entry / open orders visible if within ±60% of range
  const expandIfNear=v=>{
   const n=Number(v);
   if(!Number.isFinite(n)||n<=0)return;
   if(n>=lo-baseSpan*0.6&&n<=hi+baseSpan*0.6){lo=Math.min(lo,n);hi=Math.max(hi,n)}
  };
  for(const p of state.positions)expandIfNear(p.avg);
  for(const o of state.orders)expandIfNear(o.stopPrice||o.price);
  if(state.draft.orderType==='LIMIT')expandIfNear(state.draft.limitPrice);
  expandIfNear(state.draft.tpPrice);
  expandIfNear(state.draft.slPrice);

  const span=Math.max(hi-lo,hi*0.002||1e-6);
  const minP=lo-span*0.08,maxP=hi+span*0.08;
  const yOf=p=>padT+(maxP-p)/(maxP-minP)*priceH;
  const pOf=y=>maxP-((y-padT)/priceH)*(maxP-minP);
  const slotW=plotW/Math.max(1,bars.length);
  const xOf=i=>padL+(i+0.5)*slotW;

  state.layout={W,H,padL,padR,padT,padB,plotW,priceH,volTop,volH,minP,maxP,yOf,pOf,slotW,xOf,start,bars};

  // Grid lines & right price axis
  const gridN=5;
  ctx.strokeStyle='#122236';
  ctx.lineWidth=1;
  ctx.font='10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign='left';
  ctx.textBaseline='middle';
  for(let i=0;i<=gridN;i++){
   const p=minP+(maxP-minP)*(i/gridN);
   const y=Math.round(yOf(p))+0.5;
   ctx.beginPath();ctx.moveTo(padL,y);ctx.lineTo(W-padR,y);ctx.stroke();
   ctx.fillStyle='#788fa9';
   ctx.fillText(fmtPx(p,state.tickSize),W-padR+5,y);
  }
  // Vertical time grid
  const stepX=Math.max(1,Math.floor(bars.length/6));
  ctx.textAlign='center';
  ctx.textBaseline='top';
  for(let i=0;i<bars.length;i+=stepX){
   const x=Math.round(xOf(i))+0.5;
   ctx.strokeStyle='#0e1b2b';
   ctx.beginPath();ctx.moveTo(x,padT);ctx.lineTo(x,H-padB);ctx.stroke();
   ctx.fillStyle='#6c829d';
   ctx.fillText(fmtKstTime(bars[i][0],state.interval),x,H-padB+6);
  }
  // Right axis separator
  ctx.strokeStyle='#1a2e46';
  ctx.beginPath();ctx.moveTo(W-padR+0.5,padT);ctx.lineTo(W-padR+0.5,H-padB);ctx.stroke();

  // Volume bars
  const bodyW=Math.max(1.5,Math.min(12,slotW*0.66));
  for(let i=0;i<bars.length;i++){
   const [,o,,,c,v]=bars[i];
   const up=c>=o;
   const x=xOf(i);
   const vh=maxVol>0?(v/maxVol)*volH:0;
   ctx.fillStyle=up?'rgba(38,196,143,0.28)':'rgba(241,94,119,0.28)';
   ctx.fillRect(x-bodyW/2,volTop+volH-vh,bodyW,Math.max(1,vh));
  }

  // Candlesticks
  for(let i=0;i<bars.length;i++){
   const [,o,h,l,c]=bars[i];
   const up=c>=o;
   const col=up?'#26c48f':'#f15e77';
   const x=Math.round(xOf(i))+0.5;
   const yh=yOf(h),yl=yOf(l),yo=yOf(o),yc=yOf(c);
   ctx.strokeStyle=col;
   ctx.lineWidth=1;
   ctx.beginPath();ctx.moveTo(x,yh);ctx.lineTo(x,yl);ctx.stroke();
   ctx.fillStyle=col;
   const top=Math.min(yo,yc),bh=Math.max(1.5,Math.abs(yc-yo));
   ctx.fillRect(x-bodyW/2,top,bodyW,bh);
  }

  // EMA20 / EMA50 overlays
  if(state.showEma&&state.candles.length>=20){
   const closes=state.candles.map(b=>b[4]);
   const drawEma=(arr,color)=>{
    ctx.strokeStyle=color;ctx.lineWidth=1.2;ctx.beginPath();
    let started=false;
    for(let i=0;i<bars.length;i++){
     const v=arr[start+i];
     if(v==null)continue;
     const x=xOf(i),y=yOf(v);
     if(!started){ctx.moveTo(x,y);started=true}else ctx.lineTo(x,y);
    }
    if(started)ctx.stroke();
   };
   drawEma(calcEma(closes,20),'rgba(246,185,76,0.85)');
   if(state.candles.length>=50)drawEma(calcEma(closes,50),'rgba(92,160,255,0.85)');
  }

  // Helper to draw a labeled horizontal price line (position entry, open order, draft, live price)
  const drawPriceLine=(price,{color,bg,text,dashed=false,rightTag=true,leftPill=true})=>{
   const n=Number(price);
   if(!Number.isFinite(n)||n<=0)return;
   const y=yOf(n);
   if(y<padT-2||y>padT+priceH+2)return;
   ctx.save();
   ctx.strokeStyle=color;
   ctx.lineWidth=dashed?1:1.5;
   if(dashed)ctx.setLineDash([4,4]);
   ctx.beginPath();ctx.moveTo(padL,Math.round(y)+0.5);ctx.lineTo(W-padR,Math.round(y)+0.5);ctx.stroke();
   ctx.setLineDash([]);
   ctx.font='bold 10.5px ui-monospace, SFMono-Regular, Menlo, sans-serif';
   if(leftPill&&text){
    const tw=ctx.measureText(text).width+12;
    ctx.fillStyle=bg||color;
    ctx.fillRect(padL+4,y-9,tw,18);
    ctx.strokeStyle=color;
    ctx.lineWidth=1;
    ctx.strokeRect(padL+4.5,y-8.5,tw-1,17);
    ctx.fillStyle='#f4f8ff';
    ctx.textAlign='left';ctx.textBaseline='middle';
    ctx.fillText(text,padL+10,y);
   }
   if(rightTag){
    const lbl=fmtPx(n,state.tickSize);
    ctx.fillStyle=color;
    ctx.fillRect(W-padR+1,y-9,padR-2,18);
    ctx.fillStyle='#06101b';
    ctx.textAlign='left';ctx.textBaseline='middle';
    ctx.fillText(lbl,W-padR+5,y);
   }
   ctx.restore();
  };

  // Draft order preview lines
  if(state.draft.orderType==='LIMIT'&&fin(state.draft.limitPrice)){
   drawPriceLine(state.draft.limitPrice,{color:'#5aa2ff',bg:'rgba(24,58,99,0.92)',text:`예정 지정가 ${fmtPx(state.draft.limitPrice,state.tickSize)}`,dashed:true});
  }
  if(fin(state.draft.tpPrice)){
   drawPriceLine(state.draft.tpPrice,{color:'#33d19e',bg:'rgba(14,66,51,0.92)',text:`예정 TP ${fmtPx(state.draft.tpPrice,state.tickSize)}`,dashed:true});
  }
  if(fin(state.draft.slPrice)){
   drawPriceLine(state.draft.slPrice,{color:'#ff6e87',bg:'rgba(84,22,36,0.92)',text:`예정 SL ${fmtPx(state.draft.slPrice,state.tickSize)}`,dashed:true});
  }

  // Active BingX open orders on this symbol
  for(const o of state.orders){
   const px=o.stopPrice||o.price;
   const isTp=String(o.type).includes('TAKE_PROFIT');
   const isSl=String(o.type).includes('STOP');
   const col=isTp?'#26c48f':isSl?'#f15e77':'#4fa3ff';
   const bg=isTp?'rgba(15,66,51,0.94)':isSl?'rgba(84,22,36,0.94)':'rgba(19,49,84,0.94)';
   const lbl=isTp?`TP ${o.origQty}`:isSl?`SL ${o.origQty}`:`지정가 ${o.side==='BUY'?'매수':'매도'} ${o.origQty}`;
   drawPriceLine(px,{color:col,bg,text:lbl,dashed:true});
  }

  // Open positions on this symbol (entry price + PnL badge + liquidation line)
  for(const p of state.positions){
   const isLong=p.direction==='LONG';
   const col=isLong?'#28d69a':'#ff6682';
   const bg=isLong?'rgba(13,78,56,0.96)':'rgba(98,22,39,0.96)';
   const pnlStr=fin(p.unrealized)?` ${Number(p.unrealized)>=0?'+':'-'}$${Math.abs(Number(p.unrealized)).toFixed(2)}`:'';
   const roeStr=fin(p.roePct)?` (${Number(p.roePct)>=0?'+':'-'}${Math.abs(Number(p.roePct)).toFixed(1)}%)`:'';
   const tag=`${p.origin==='copy'?'[카피] ':''}${isLong?'롱 진입':'숏 진입'} ${fmtPx(p.avg,state.tickSize)}${pnlStr}${roeStr}`;
   drawPriceLine(p.avg,{color:col,bg,text:tag,dashed:false});
   if(fin(p.liquidation)&&Number(p.liquidation)>0){
    drawPriceLine(p.liquidation,{color:'#f6a94c',bg:'rgba(82,48,12,0.92)',text:`청산가 ${fmtPx(p.liquidation,state.tickSize)}`,dashed:true,rightTag:false});
   }
  }

  // Selected click-to-trade price line
  if(fin(state.selectedPrice)){
   drawPriceLine(state.selectedPrice,{color:'#f6c34c',bg:'rgba(88,62,12,0.96)',text:`선택가 ${fmtPx(state.selectedPrice,state.tickSize)}`,dashed:true});
  }

  // Live current price line
  const lastBar=bars[bars.length-1];
  const curPx=fin(state.livePrice)?Number(state.livePrice):lastBar[4];
  const curUp=curPx>=lastBar[1];
  drawPriceLine(curPx,{color:curUp?'#26c48f':'#f15e77',dashed:true,leftPill:false,rightTag:true});

  // Crosshair & top OHLCV legend
  let legendBar=lastBar;
  if(state.hover&&state.hover.x>=padL&&state.hover.x<=W-padR&&state.hover.y>=padT&&state.hover.y<=H-padB){
   const idx=Math.max(0,Math.min(bars.length-1,Math.floor((state.hover.x-padL)/slotW)));
   legendBar=bars[idx];
   const hx=Math.round(xOf(idx))+0.5;
   const hy=Math.round(state.hover.y)+0.5;
   ctx.save();
   ctx.strokeStyle='rgba(170,196,226,0.38)';
   ctx.lineWidth=1;
   ctx.setLineDash([3,3]);
   ctx.beginPath();ctx.moveTo(hx,padT);ctx.lineTo(hx,H-padB);ctx.stroke();
   if(hy<=padT+priceH){
    ctx.beginPath();ctx.moveTo(padL,hy);ctx.lineTo(W-padR,hy);ctx.stroke();
    const hp=pOf(hy);
    ctx.setLineDash([]);
    ctx.fillStyle='#2a4464';
    ctx.fillRect(W-padR+1,hy-9,padR-2,18);
    ctx.fillStyle='#eef6ff';
    ctx.font='10.5px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign='left';ctx.textBaseline='middle';
    ctx.fillText(fmtPx(hp,state.tickSize),W-padR+5,hy);
   }
   const tLbl=fmtKstTime(legendBar[0],state.interval);
   ctx.setLineDash([]);
   const tw=ctx.measureText(tLbl).width+10;
   const tx=Math.max(padL,Math.min(W-padR-tw,hx-tw/2));
   ctx.fillStyle='#2a4464';
   ctx.fillRect(tx,H-padB+2,tw,18);
   ctx.fillStyle='#eef6ff';
   ctx.textAlign='center';ctx.textBaseline='middle';
   ctx.fillText(tLbl,tx+tw/2,H-padB+11);
   ctx.restore();
  }

  // Top-left OHLCV legend
  const [lt,lo0,lh0,ll0,lc0,lv0]=legendBar;
  const chg=lo0>0?(lc0-lo0)/lo0*100:0;
  ctx.font='11px ui-monospace, SFMono-Regular, Menlo, sans-serif';
  ctx.textAlign='left';ctx.textBaseline='middle';
  const upL=lc0>=lo0;
  ctx.fillStyle='#90a6bf';
  ctx.fillText(`${fmtKstTime(lt,state.interval)}`,padL+4,14);
  ctx.fillStyle=upL?'#37d39c':'#f56c86';
  ctx.fillText(`시 ${fmtPx(lo0,state.tickSize)}  고 ${fmtPx(lh0,state.tickSize)}  저 ${fmtPx(ll0,state.tickSize)}  종 ${fmtPx(lc0,state.tickSize)} (${chg>=0?'+':''}${chg.toFixed(2)}%)  거래량 ${fmtVol(lv0)}`,padL+92,14);
 }

 // Pointer & wheel interactions
 const onMouseMove=e=>{
  const r=canvas.getBoundingClientRect();
  const x=e.clientX-r.left,y=e.clientY-r.top;
  if(state.dragging&&state.layout){
   const dx=x-state.dragStartX;
   if(Math.abs(dx)>4)state.dragMoved=true;
   state.rightOffset=state.dragStartOffset+Math.round(dx/Math.max(2,state.layout.slotW));
   draw();
   return;
  }
  state.hover={x,y};
  draw();
 };
 const onMouseDown=e=>{
  if(e.button!==0)return;
  const r=canvas.getBoundingClientRect();
  state.dragging=true;state.dragMoved=false;
  state.dragStartX=e.clientX-r.left;
  state.dragStartOffset=state.rightOffset;
 };
 const onMouseUp=e=>{
  if(!state.dragging)return;
  const moved=state.dragMoved;
  state.dragging=false;state.dragMoved=false;
  if(moved||!state.layout)return;
  const r=canvas.getBoundingClientRect();
  const x=e.clientX-r.left,y=e.clientY-r.top;
  const L=state.layout;
  if(x>=L.padL&&x<=L.W-L.padR&&y>=L.padT&&y<=L.padT+L.priceH){
   const px=roundToTick(L.pOf(y),state.tickSize);
   if(px>0){state.selectedPrice=px;draw();onSelectPrice(px)}
  }
 };
 const onMouseLeave=()=>{state.hover=null;state.dragging=false;draw()};
 const onWheel=e=>{
  if(!state.candles.length)return;
  e.preventDefault();
  const factor=e.deltaY>0?1.15:0.86;
  state.visibleCount=Math.max(24,Math.min(Math.max(24,state.candles.length),Math.round(state.visibleCount*factor)));
  draw();
 };

 let touchStartX=0,touchStartY=0,touchStartOffset=0,touchMoved=false;
 const onTouchStart=e=>{
  if(!e.touches||e.touches.length!==1)return;
  const t=e.touches[0],pt=canvasPoint(t);
  touchStartX=t.clientX;touchStartY=t.clientY;touchStartOffset=state.rightOffset;touchMoved=false;
  state.hover=pt;
 };
 const onTouchMove=e=>{
  if(!e.touches||e.touches.length!==1||!state.candles.length)return;
  const t=e.touches[0],dx=t.clientX-touchStartX,dy=t.clientY-touchStartY;
  if(Math.abs(dx)>6&&Math.abs(dx)>=Math.abs(dy)){
   touchMoved=true;
   e.preventDefault();
   const shift=Math.round((dx/Math.max(200,state.chartW||600))*state.visibleCount);
   const maxOff=Math.max(0,state.candles.length-10);
   state.rightOffset=Math.max(0,Math.min(maxOff,touchStartOffset+shift));
   draw();
  }
 };
 const onTouchEnd=e=>{
  if(!touchMoved&&e.changedTouches&&e.changedTouches.length===1){
   const pt=canvasPoint(e.changedTouches[0]);
   const px=yToPrice(pt.y);
   if(px>0){state.selectedPrice=px;draw();onSelectPrice(px)}
  }
  state.hover=null;touchMoved=false;
 };

 if(canvas&&typeof canvas.addEventListener==='function'){
  canvas.addEventListener('mousemove',onMouseMove);
  canvas.addEventListener('mousedown',onMouseDown);
  window.addEventListener('mouseup',onMouseUp);
  canvas.addEventListener('mouseleave',onMouseLeave);
  canvas.addEventListener('wheel',onWheel,{passive:false});
  canvas.addEventListener('touchstart',onTouchStart,{passive:true});
  canvas.addEventListener('touchmove',onTouchMove,{passive:false});
  canvas.addEventListener('touchend',onTouchEnd,{passive:true});
 }

 const ro=typeof ResizeObserver!=='undefined'&&canvas?new ResizeObserver(()=>draw()):null;
 ro?.observe(canvas);

 return {
  setData({candles,interval,tickSize,livePrice,positions,orders,draft,showEma,selectedPrice}={}){
   if(Array.isArray(candles)){
    const changedInterval=interval&&interval!==state.interval;
    state.candles=candles;
    if(changedInterval)state.rightOffset=0;
   }
   if(interval)state.interval=interval;
   if(tickSize!==undefined)state.tickSize=tickSize;
   if(livePrice!==undefined)state.livePrice=livePrice;
   if(Array.isArray(positions))state.positions=positions;
   if(Array.isArray(orders))state.orders=orders;
   if(draft)state.draft={...state.draft,...draft};
   if(typeof showEma==='boolean')state.showEma=showEma;
   if(selectedPrice!==undefined)state.selectedPrice=selectedPrice;
   draw();
  },
  resetPan(){state.rightOffset=0;draw()},
  clearSelection(){state.selectedPrice=null;draw()},
  redraw:draw,
  destroy(){
   ro?.disconnect();
   if(canvas&&typeof canvas.removeEventListener==='function'){
    canvas.removeEventListener('mousemove',onMouseMove);
    canvas.removeEventListener('mousedown',onMouseDown);
    window.removeEventListener('mouseup',onMouseUp);
    canvas.removeEventListener('mouseleave',onMouseLeave);
    canvas.removeEventListener('wheel',onWheel);
    canvas.removeEventListener('touchstart',onTouchStart);
    canvas.removeEventListener('touchmove',onTouchMove);
    canvas.removeEventListener('touchend',onTouchEnd);
   }
  },
 };
}
