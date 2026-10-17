// Smoke-test the built application with isolated data, then stop only that test process.
const {spawn}=require('node:child_process');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const executable=process.argv[2]||path.join(root,'dist/mac-arm64/喝水养鱼.app/Contents/MacOS/喝水养鱼');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function evaluate(target,expression){
 const ws=new WebSocket(target.webSocketDebuggerUrl);
 return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{ws.close();reject(Error('CDP timeout'));},8000);
  ws.onopen=()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));
  ws.onerror=()=>{clearTimeout(timer);reject(Error('CDP connection failed'));};
  ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.id!==1)return;clearTimeout(timer);ws.close();if(r.error||r.result.exceptionDetails)reject(Error(JSON.stringify(r)));else resolve(r.result.result.value);};
 });
}
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'sip-package-'));
 const server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));
 const child=spawn(executable,[`--remote-debugging-port=${port}`],{env:{...process.env,SIP_DATA_DIR:temp,SIP_DEV:'0'},stdio:['ignore','pipe','pipe']});
 let logs='';child.stdout.on('data',d=>logs+=d);child.stderr.on('data',d=>logs+=d);
 const pages=async()=>fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());
 try{
  let targets=[];
  for(let i=0;i<60;i++){try{targets=await pages();if(targets.some(t=>t.url.includes('/onboarding/')))break;}catch{}await wait(250);}
  const intro=targets.find(t=>t.url.includes('/onboarding/'));assert.ok(intro,'Packaged onboarding did not open');
  for(let i=0;i<40;i++){if(await evaluate(intro,'!!document.querySelector("h1")'))break;await wait(150);}
  assert.equal(await evaluate(intro,'document.querySelector("h1").textContent'),'喝水养鱼');
  await evaluate(intro,'document.getElementById("go").click()');await wait(600);
  const data=JSON.parse(fs.readFileSync(path.join(temp,'sip-data.json')));assert.equal(data.settings.goalMl,1500);
  targets=await pages();const cup=targets.find(t=>t.url.includes('/cup/'));assert.ok(cup);
  await evaluate(cup,'window.sip.send("open-collection")');await wait(500);
  targets=await pages();const guide=targets.find(t=>t.url.includes('/fish/'));assert.ok(guide);
  for(let i=0;i<40;i++){if(await evaluate(guide,'document.querySelectorAll("article").length===5'))break;await wait(150);}
  const cards=await evaluate(guide,'document.querySelectorAll("article").length');assert.equal(cards,5);
  const water=targets.find(t=>t.url.includes('/water/'));assert.ok(water);
  const state=await evaluate(water,'window.sip.invoke("water-ready")');assert.equal(state.geometry.baseRatio,.06);assert.equal(state.geometry.fullRatio,.4);
  const resources=path.resolve(executable,'../../Resources');assert.ok(fs.existsSync(path.join(resources,'bin/sip-mouse')));
  assert.ok(!logs.includes('没有鼠标小助手'),'Packaged helper missing');
  console.log(JSON.stringify({packagedStart:true,onboarding:true,goalMl:data.settings.goalMl,collectionCards:cards,geometry:state.geometry,helperBundled:true}));
 }finally{
  child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),wait(3000)]);
  if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');
  fs.rmSync(temp,{recursive:true,force:true});
 }
})().catch(e=>{console.error(e);process.exitCode=1});
