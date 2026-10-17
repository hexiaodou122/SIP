// 每个画布像素都是一格；体型通过重新绘制更多格子表达，不放大单格。
(() => {
  'use strict';
  const SPECIES = {
    clown: {len:16,h:9,minCm:8,maxCm:11,minLen:14,maxLen:18,cruise:26,base:'#ee782c',light:'#ffb25d',dark:'#ba481e',line:'#31251c',tail:'#e97b2c'},
    tang: {len:22,h:13,minCm:15,maxCm:30,minLen:18,maxLen:27,cruise:30,base:'#367ac6',light:'#6ca6e4',dark:'#235198',line:'#162e48',tail:'#efc348'},
    puffer: {len:20,h:15,minCm:10,maxCm:30,minLen:16,maxLen:25,cruise:18,base:'#b39b59',light:'#d9c88a',dark:'#e4d9b2',line:'#454639',tail:'#a79860'},
    sunfish: {len:42,h:39,minCm:100,maxCm:300,minLen:34,maxLen:50,cruise:13,base:'#819b9d',light:'#b6c7bf',dark:'#526e7b',line:'#304957',tail:'#68828b'},
    angler: {len:25,h:17,minCm:10,maxCm:40,minLen:19,maxLen:30,cruise:15,base:'#705948',light:'#9a7b59',dark:'#443d3d',line:'#222f38',tail:'#766146'},
  };
  const TINTS=[0,.16,.3], FLAPS=[0,1,0,-1], cache=new Map();
  function build(name,cm,flap,portrait=false) {
    const sp=SPECIES[name], ratio=Math.max(0,Math.min(1,(cm-sp.minCm)/(sp.maxCm-sp.minCm)));
    const len=portrait?({clown:13,tang:16,puffer:14,sunfish:14,angler:17}[name]):Math.round(sp.minLen+(sp.maxLen-sp.minLen)*ratio), h=Math.round(len*sp.h/sp.len);
    const tail=name==='sunfish'?3:Math.max(3,Math.round(len*.22));
    const extra=name==='sunfish'?Math.round(h*.42):name==='angler'?(portrait?6:10):4;
    const W=len+tail+5,H=h+extra*2+4,x0=tail+2,cy=Math.floor(H/2),half=h/2;
    const grid=Array.from({length:H},()=>Array(W).fill(null));
    const dot=(x,y,c)=>{if(grid[y]&&x>=0&&x<W)grid[y][x]=c;};
    function profile(s) { if(name==='sunfish')return Math.sqrt(Math.max(.05,1-Math.pow((s-.46)/.58,2)));return s<.63?.35+.65*Math.sin(s/.63*Math.PI/2):Math.sqrt(Math.max(.1,1-Math.pow((s-.63)/.41,2))); }
    for(let x=0;x<len;x++) {
      const s=(x+.5)/len,hh=half*profile(s);
      for(let y=Math.ceil(cy-hh);y<=Math.floor(cy+hh);y++) {
        const rel=(y-cy)/hh; let col=rel<-.35?sp.light:rel>.4?sp.dark:sp.base;
        if(name==='clown') {
          const b=[.18,.49,.82].map(v=>Math.abs(s-v));
          if(b.some(v=>v<.055))col='#f8efda';else if(b.some(v=>v<.095))col=sp.line;
        }
        if(name==='tang'&&s>.08&&s<.72&&rel>-.65&&rel<.18-Math.abs(s-.36)*1.8)col='#172f52';
        if(name==='puffer'&&rel<.3&&(x*7+y*11)%19<3)col='#665d3e';
        if(name==='sunfish'&&(x*3+y*7)%31<2)col=rel<0?'#9cb0aa':'#6a858d';
        if(name==='angler'&&(x*5+y*7)%29<2)col='#ab875d';
        dot(x0+x,y,col);
      }
    }
    // 尾鳍或翻车鱼的短、波浪状伪尾鳍。
    for(let k=1;k<=tail;k++) for(let y=-Math.ceil(half*.6);y<=Math.ceil(half*.6);y++) {
      if(name==='sunfish') {if(Math.abs(y)<half*.86)dot(x0-k,cy+y+(k===tail?Math.round(Math.sin(y)*1):0),sp.tail);}
      else if(Math.abs(y-flap*k*.3)<1+k*.68)dot(x0-k,cy+y,sp.tail);
    }
    if(name==='sunfish') {
      for(let k=0;k<extra;k++) for(let q=0;q<Math.max(2,Math.round(len*.2-k*.4));q++) {
        dot(x0+Math.round(len*.42)+q-Math.round(k*.25),cy-Math.round(half*.94)-k,sp.dark);
        dot(x0+Math.round(len*.48)+q-Math.round(k*.2),cy+Math.round(half*.91)+k,sp.dark);
      }
    } else if(name!=='puffer') {
      for(let x=Math.round(len*.23);x<len*.65;x++) {
        const top=cy-Math.floor(half*profile(x/len));
        dot(x0+x,top-1,sp.dark); if(x>len*.35)dot(x0+x,top-2,sp.dark);
      }
    }
    // 胸鳍、鳃与小眼睛，没有卡通眼白。
    const gx=x0+Math.round(len*.69);
    for(let y=0;y<Math.max(2,Math.round(h*.25));y++)dot(gx,cy+y,sp.dark);
    for(let x=0;x<Math.max(2,Math.round(len*.14));x++)dot(gx-x,cy+2+Math.floor(x*.4)+flap,sp.tail);
    dot(x0+Math.round(len*.86),cy-Math.round(h*.18),'#111e27');
    dot(x0+len-1,cy+1,sp.line);
    let lure=null;
    if(name==='angler') {
      // 大斜口和交错细牙；灯须弯向嘴上方。
      for(let x=Math.round(len*.72);x<len;x++) {
        const cut=Math.round((x/len-.72)*h*.75);
        for(let y=cy-cut;y<=cy+cut+1;y++)dot(x0+x,y,'#182b35');
        if(x%2===0&&cut>0){dot(x0+x,cy-cut,'#dbcba0');dot(x0+x,cy+cut,'#dbcba0');}
      }
      const start=x0+Math.round(len*.55),end=x0+len-1,top=cy-Math.round(half)-7;
      for(let x=start;x<=end;x++) {
        const t=(x-start)/(end-start),y=Math.round(top+Math.pow(t-.6,2)*13);
        dot(x,y,'#a99365'); if(x===end)lure={x,y:y+1};
      }
      dot(lure.x,lure.y,'#e7fac4');dot(lure.x-1,lure.y,'#c1ecb5');dot(lure.x,lure.y+1,'#e7fac4');
    }
    const out=grid.map(row=>row.slice());
    for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(!grid[y][x]&&[[x-1,y],[x+1,y],[x,y-1],[x,y+1]].some(([a,b])=>grid[b]?.[a]))out[y][x]=sp.line;
    const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;canvas.lure=lure;
    const ctx=canvas.getContext('2d');for(let y=0;y<H;y++)for(let x=0;x<W;x++)if(out[y][x]){ctx.fillStyle=out[y][x];ctx.fillRect(x,y,1,1);}return canvas;
  }
  function tinted(src,t) {if(!t)return src;const c=document.createElement('canvas');c.width=src.width;c.height=src.height;c.lure=src.lure;const g=c.getContext('2d');g.drawImage(src,0,0);g.globalCompositeOperation='source-atop';g.fillStyle=`rgba(30,96,140,${t})`;g.fillRect(0,0,c.width,c.height);return c;}
  function frames(name,cm) {const sp=SPECIES[name];if(!sp)throw new Error(`Unknown fish: ${name}`);cm=Number.isFinite(cm)?cm:(sp.minCm+sp.maxCm)/2;const key=`${name}:${cm.toFixed(1)}`;if(!cache.has(key)){const originals=FLAPS.map(f=>build(name,cm,f));cache.set(key,TINTS.map(t=>originals.map(c=>tinted(c,t))));}return cache.get(key);}
  // 图鉴重新按较少格子绘制肖像；仍是一格 3px，不缩放水里的鱼。
  const portraits={};
  function portrait(name){return portraits[name]||(portraits[name]=build(name,SPECIES[name].minCm,0,true));}
  window.SipSprites={SPECIES,frames,portrait,TINT_LEVELS:TINTS.length};
})();
