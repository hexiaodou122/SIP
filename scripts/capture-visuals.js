// Isolated renderer acceptance captures; never opens or writes the user's Sip data.
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('fs'),path=require('path');
const root=path.join(__dirname,'..');
fs.mkdirSync(path.join(root,'artifacts'),{recursive:true});
app.setPath('userData',path.join('/tmp','sip-render-check'));
const catalog=require('../renderer/fish/fish.json');
const fish={};
for(const id of ['clown','tang','puffer']) fish[id]={firstSeen:'2026-10-17',count:1,maxCm:{clown:10.4,tang:25.8,puffer:24.6}[id]};
let state={dev:true,settings:{goalMl:1500,sipMl:20,sound:false},totalMl:750,hidden:false,collection:{fish},fishCatalog:catalog,geometry:{fullRatio:require('../renderer/shared/constants').WATER_FULL_RATIO,baseRatio:require('../renderer/shared/constants').WATER_BASE_RATIO}};
ipcMain.handle('water-ready',()=>state);
ipcMain.handle('get-collection',()=>({collection:state.collection,fishCatalog:catalog}));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function capture(win,name){await delay(150);fs.writeFileSync(path.join(root,'artifacts',name),(await win.webContents.capturePage()).toPNG());}
app.whenReady().then(async()=>{
 app.dock?.hide();
 const errors=[];
 const win=new BrowserWindow({width:1440,height:900,show:false,frame:false,webPreferences:{preload:path.join(root,'main/preload.js'),backgroundThrottling:false,offscreen:true}});
 win.webContents.on('console-message',(_e,level,message)=>{if(level>=2) errors.push(message);});
 await win.loadFile(path.join(root,'renderer/water/index.html'));
 await win.webContents.executeJavaScript("document.body.style.background='#e2ddd1'");
 const sprites = await win.webContents.executeJavaScript(`Object.entries(SipSprites.SPECIES).map(([id,s])=>{const small=SipSprites.frames(id,s.minCm)[0][0],big=SipSprites.frames(id,s.maxCm)[0][0];return {id,small:small.width,big:big.width,lure:big.lure};})`);
 if(sprites.length!==5 || sprites.some(s=>s.big<=s.small) || !sprites.find(s=>s.id==='angler').lure)throw Error('Species sizing or angler lure failed');
 if(process.env.SIP_SPRITE_CHECK==='1'){console.log(JSON.stringify({sprites}));app.quit();return;}

 if(process.env.SIP_PANELS_CHECK==='1') {
   const panels=[];
   for(const [file,width,height,name] of [['onboarding',560,740,'welcome-light.png'],['fish',940,750,'collection-light.png']]) {
     const panel=new BrowserWindow({width,height,show:false,frame:false,webPreferences:{preload:path.join(root,'main/preload.js'),offscreen:true,backgroundThrottling:false}});
     panel.webContents.on('console-message',(_e,level,message)=>{if(level>=2)errors.push(message)});
     await panel.loadFile(path.join(root,'renderer',file,'index.html'));await delay(500);
     await capture(panel,name);
     if(file==='onboarding')await panel.webContents.executeJavaScript(`document.querySelector('[data-custom]').click()`);
     if(file==='fish') {
       const all={fish:{...state.collection.fish,sunfish:{firstSeen:'2026-10-17',maxCm:220,count:1},angler:{firstSeen:'2026-10-17',maxCm:24,count:1}}};
       panel.webContents.send('state',{collection:all});await delay(150);
     }
     const fit=await panel.webContents.executeJavaScript(`({height:innerHeight,scroll:document.documentElement.scrollHeight,bottom:Math.max(...[...document.querySelectorAll('button,article')].map(e=>e.getBoundingClientRect().bottom))})`);
     panels.push({file,...fit});
   }
   console.log(JSON.stringify({panels,errors}));
   if(errors.length || panels.some(p=>p.scroll>p.height || p.bottom>p.height))throw Error('Panel content clipped');
   app.quit();return;
 }
 if(process.env.SIP_WELCOME_CHECK==='1') {
   state.totalMl=0;state.collection={fish:{}};win.webContents.send('state',state);await delay(2500);
   const empty=await win.webContents.executeJavaScript('window.__sipInspect()');
   if(Math.abs((empty.height-empty.surfaceY)/empty.height-.06)>.002 || empty.fish.length)throw Error('Base water mismatch');
   fs.writeFileSync(path.join(root,'artifacts','base-water.png'),(await win.webContents.capturePage({x:0,y:810,width:1440,height:90})).toPNG());
   state.totalMl=1500;win.webContents.send('state',state);await delay(2500);
   const full=await win.webContents.executeJavaScript('window.__sipInspect()');
   if(Math.abs((full.height-full.surfaceY)/full.height-.4)>.002)throw Error('Full water mismatch');
   const intro=new BrowserWindow({width:560,height:740,show:false,frame:false,webPreferences:{preload:path.join(root,'main/preload.js'),offscreen:true,backgroundThrottling:false}});
   await intro.loadFile(path.join(root,'renderer/onboarding/index.html'));await delay(400);
   fs.writeFileSync(path.join(root,'artifacts','welcome.png'),(await intro.webContents.capturePage()).toPNG());
   const fit=await intro.webContents.executeJavaScript(`document.querySelector('[data-custom]').click();({height:innerHeight,scroll:document.documentElement.scrollHeight,button:document.getElementById('go').getBoundingClientRect().bottom})`);
   if(fit.scroll>fit.height || fit.button>fit.height)throw Error('Custom welcome clipped');
   let choice=null;ipcMain.once('onboarding-done',(_e,d)=>choice=d);
   await intro.webContents.executeJavaScript(`document.querySelector('[data-goal="1700"]').click();document.getElementById('go').click()`);await delay(200);
   if(choice?.goalMl!==1700 || choice?.sipMl!==25)throw Error('Goal selection failed');
   console.log(JSON.stringify({empty,full,fit,choice,errors}));app.quit();return;
 }
 if(process.env.SIP_DEPTH_CHECK==='1') {
   state.totalMl=1500;
   state.collection.fish.angler={firstSeen:'2026-10-17',count:1,maxCm:24.2};
   win.webContents.send('state',state);
   await delay(15000);
   const samples=[];
   for(let i=0;i<6;i++) {
     const sample=await win.webContents.executeJavaScript('window.__sipInspect()');
     const y=id=>sample.fish.find(f=>f.id===id).y;
     if(!(y('clown')+30<y('tang') && y('tang')+30<y('angler')))throw Error('Habitat layers overlap');
     samples.push({clown:y('clown'),tang:y('tang'),angler:y('angler')});
     win.webContents.send('cursor',{x:sample.fish[0].x,y:sample.fish[0].y});
     await delay(600);
   }
   fs.writeFileSync(path.join(root,'artifacts','habitat-layers.png'),(await win.webContents.capturePage({x:0,y:594,width:1440,height:306})).toPNG());
   console.log(JSON.stringify({samples,errors}));app.quit();return;
 }
 await delay(14000);
 console.log('50%',await win.webContents.executeJavaScript('window.__sipInspect()'));
 await capture(win,'water-50.png');
 fs.writeFileSync(path.join(root,'artifacts','water-50-detail.png'),(await win.webContents.capturePage({x:0,y:735,width:1440,height:165})).toPNG());
 state={...state,totalMl:1500};
 win.webContents.send('state',state);
 await delay(2500);
 win.webContents.send('fish-arrive',{id:'sunfish',cm:220});
 state.collection.fish.sunfish={firstSeen:'2026-10-17',count:1,maxCm:220,lastCm:220};
 win.webContents.send('state',state);
 await delay(6500);
 console.log('arrival',await win.webContents.executeJavaScript('window.__sipInspect()'));
 await capture(win,'water-100-arrival.png');
 // A dedicated close crop makes the common 3 px grid inspectable.
 fs.writeFileSync(path.join(root,'artifacts','water-detail.png'),(await win.webContents.capturePage({x:0,y:594,width:1440,height:306})).toPNG());
 // Verify deep fish stay out at 50%, and evaporation waits for exit.
 state.collection.fish.angler={firstSeen:'2026-10-17',count:1,maxCm:32};
 state.totalMl=750;win.webContents.send('state',state);await delay(13000);
 const half=await win.webContents.executeJavaScript('window.__sipInspect()');
 if(half.fish.some(f=>['sunfish','angler'].includes(f.id)))throw Error('Deep fish remained at half water');
 win.webContents.send('evaporate',{fromLevel:.5});state.totalMl=0;win.webContents.send('state',state);
 await delay(7000);
 const empty=await win.webContents.executeJavaScript('window.__sipInspect()');
 if(empty.fish.length || empty.level>.01)throw Error('Evaporation did not empty water');
 delete state.collection.fish.sunfish;delete state.collection.fish.angler;
 const guide=new BrowserWindow({width:940,height:750,show:false,frame:false,webPreferences:{preload:path.join(root,'main/preload.js'),backgroundThrottling:false,offscreen:true}});
 guide.webContents.on('console-message',(_e,level,message)=>{if(level>=2) errors.push(message);});
 await guide.loadFile(path.join(root,'renderer/fish/index.html'));
 await delay(1000);await capture(guide,'collection-three.png');
 const layout=await guide.webContents.executeJavaScript('({height:innerHeight,scroll:document.documentElement.scrollHeight,cards:document.querySelectorAll("article").length})');
 if(errors.length || layout.scroll>layout.height || layout.cards!==5)throw Error('Renderer errors or clipped collection layout');
 console.log(JSON.stringify({errors,layout}));
 app.quit();
}).catch(e=>{console.error(e);app.exit(1)});
