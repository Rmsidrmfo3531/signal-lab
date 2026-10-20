// Test-only fake REST and websocket feeds, never imported by the regular app.
import './mock_runtime.mjs';
class FakeWebSocket extends EventTarget {
  static OPEN=1;
  constructor(url){super();this.url=String(url);this.readyState=0;this.timer=[];
    this.defer(()=>{this.readyState=1;this.dispatchEvent(new Event('open'));
      if(this.url.includes('miniTicker'))this.emitTicker();
    },10);
  }
  defer(callback,ms){const t=setTimeout(()=>{if(this.readyState===1||this.readyState===0)callback()},ms);this.timer.push(t)}
  emit(message){const e=new Event('message');Object.defineProperty(e,'data',{value:JSON.stringify(message)});this.dispatchEvent(e)}
  emitTicker(){const ticks=[{s:'BTCUSDT',c:'81000',st:1},{s:'ETHUSDT',c:'40500',st:1}];this.emit({data:ticks});this.defer(()=>this.emitTicker(),1000)}
  send(text){let m={};try{m=JSON.parse(text)}catch{}
    if(m.method==='SUBSCRIBE'){
       this.defer(()=>this.emit({result:null,id:m.id}),25);
       if(m.params?.some(x=>x==='btcusdt@kline_1h')){
         this.defer(()=>this.emit({data:{e:'kline',s:'BTCUSDT',st:1,k:{x:false,i:'1h'}}}),80);
         this.defer(()=>this.emit({data:{e:'kline',s:'BTCUSDT',st:1,k:{x:true,i:'1h'}}}),180);
       }
    }
  }
  close(){if(this.readyState===3)return;this.readyState=3;for(const t of this.timer)clearTimeout(t);this.dispatchEvent(new Event('close'))}
}
globalThis.WebSocket=FakeWebSocket;
