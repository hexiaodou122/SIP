const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const {createRequire}=require('node:module');
const realRequire=createRequire(path.join(__dirname,'../main/main.js'));
function harness(){
 const handlers={},events=[],timers=new Map();let timerId=0;let cursor={x:1030,y:80},bounds={x:1000,y:40,width:120,height:120};
 const contents={send:(...args)=>events.push(args)};
 const cup={webContents:contents,isDestroyed:()=>false,getBounds:()=>bounds,setBounds:b=>{bounds=b},setIgnoreMouseEvents(){}};
 const store={DEFAULT_SETTINGS:{goalMl:1500,sipMl:20},dayKey:(d=new Date(2026,9,17,12))=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,save:()=>{},totalMl:t=>t.entries.reduce((a,e)=>a+e.ml,0),rollover:(d,key)=>{d.history.push(d.today);d.today={dayKey:key,entries:[],hidden:false}}};
 const electron={app:{getPath:()=>'/tmp/sip-test',setPath(){},requestSingleInstanceLock:()=>true,whenReady:()=>({then(){}}),on(){}},screen:{getCursorScreenPoint:()=>cursor,getPrimaryDisplay:()=>({bounds:{x:0,y:0,width:1440,height:900},workArea:{x:0,y:25,width:1440,height:815}})},ipcMain:{handle(){},on:(ch,fn)=>handlers[ch]=fn}};
 const context={require:n=>n==='electron'?electron:n==='./store'?store:realRequire(n),process:{env:{SIP_DEV:'1'},argv:[]},console,__dirname:path.join(__dirname,'../main'),setInterval(){},setTimeout(fn){timers.set(++timerId,fn);return timerId},clearTimeout(id){timers.delete(id)}};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../main/main.js'),'utf8')+`\nglobalThis.probe={setupIpc,poll,seedThreeDays,init(c,w){cupWin=c;waterWin=w;waterReady=true;cupShown=true;cupBusy=true;lastSpout={x:6,y:42};data={settings:{goalMl:1500,sipMl:20},today:{dayKey:'2026-10-17',entries:[],hidden:false},history:[],collection:emptyCollection()};},getData:()=>data,getDrag:()=>cupDrag,onMouse,prepareDesktop(){cupShown=false;cupBusy=false;},getMouse:()=>mouse};`,context);
 context.probe.init(cup,{webContents:contents,isDestroyed:()=>false});context.probe.setupIpc();
 return {flush(){const pending=[...timers.values()];timers.clear();pending.forEach(fn=>fn())},p:context.probe,handlers,contents,events,move:p=>cursor=p,bounds:()=>bounds};
}
test('holding cup preserves grab offset, moves water spout, and release stops dragging',()=>{
 const h=harness();h.handlers['cup-drag-start']({sender:h.contents});h.move({x:730,y:380});h.p.poll();
 assert.equal(h.bounds().x,699);assert.equal(h.bounds().y,339);
 const stream=h.events.find(e=>e[0]==='stream-move');assert.equal(stream[1].from.x,705);assert.equal(stream[1].from.y,381);
 h.handlers['cup-drag-end']({sender:h.contents});h.move({x:100,y:100});h.p.poll();assert.equal(h.bounds().x,699);assert.equal(h.p.getDrag(),null);
});
test('three-day demo uses award rules, ends today full, and contains three distinct fish',()=>{
 const h=harness();h.p.seedThreeDays();const d=h.p.getData();assert.equal(Object.keys(d.collection.fish).length,3);assert.ok(d.collection.fish.clown);assert.equal(d.today.dayKey,'2026-10-17');assert.equal(d.today.entries[0].ml,1500);assert.equal(d.history.length,2);assert.equal(d.collection.fullAwardedFor,d.today.dayKey);
});

test('ordinary desktop single/double clicks, holds and drags never summon a cup',()=>{
 for(const flag of [undefined,false]){
  const h=harness();h.p.prepareDesktop();
  for(let click=0;click<2;click++){
   h.p.onMouse({t:'down',x:200,y:200,desk:true,summon:flag});h.flush();
   h.p.onMouse({t:'drag',x:220,y:220,desk:true});h.p.onMouse({t:'up',x:220,y:220});
  }
  assert.equal(h.events.filter(e=>e[0]==='cup-show').length,0);
  assert.equal(h.p.getMouse().down,null);
 }
});
test('Option desktop click summons, hold pours and release stops; icon drags cancel',()=>{
 const h=harness();h.p.prepareDesktop();
 h.p.onMouse({t:'down',x:200,y:200,desk:true,summon:true});
 h.p.onMouse({t:'up',x:200,y:200});h.flush();
 assert.equal(h.events.filter(e=>e[0]==='cup-show').length,1);
 assert.equal(h.events.find(e=>e[0]==='cup-show')[1].pour,false);
 h.p.prepareDesktop();h.events.length=0;
 h.p.onMouse({t:'down',x:200,y:200,desk:true,summon:true});h.flush();
 assert.equal(h.events.find(e=>e[0]==='cup-show')[1].pour,true);
 h.p.onMouse({t:'up',x:200,y:200});assert.ok(h.events.some(e=>e[0]==='cup-release'));
 h.p.prepareDesktop();h.events.length=0;
 h.p.onMouse({t:'down',x:200,y:200,desk:true,summon:true});
 h.p.onMouse({t:'drag',x:220,y:220,desk:true});h.flush();h.p.onMouse({t:'up',x:220,y:220});
 assert.equal(h.events.filter(e=>e[0]==='cup-show').length,0);
 h.p.onMouse({t:'down',x:200,y:200,desk:false,summon:true});h.flush();
 assert.equal(h.events.filter(e=>e[0]==='cup-show').length,0);
});
