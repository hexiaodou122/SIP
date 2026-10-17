// Small habitat illustrations, drawn directly on the shared pixel grid.
(() => {
  function paint(g,w,h,habitat='浅水',muted=false){
    const colors=muted?['#b7d7d2','#a1c7c9','#86aebd']:habitat==='深海'?['#65a9bb','#508fac','#3b7099']:habitat==='中层'?['#8bd6d2','#69bbc6','#489aaa']:['#b1e9d9','#80d6cf','#59b7c2'];
    g.fillStyle=colors[0];g.fillRect(0,0,w,h);
    for(let x=0;x<w;x++){
      const edge=Math.round(h*.5+Math.sin(x*.13)*1.3);g.fillStyle=colors[1];g.fillRect(x,edge,1,h-edge);
      const bottom=Math.round(h*.81+Math.sin(x*.17+2)*1.4);g.fillStyle=colors[2];g.fillRect(x,bottom,1,h-bottom);
    }
    // A stepped shaft and drifting flecks, without smooth gradients.
    g.fillStyle=muted?'#c4ded5':'#c7eedc';g.globalAlpha=.35;
    for(let y=0;y<h;y++)g.fillRect(Math.round(w*.28+y*.4),y,4,1);g.globalAlpha=1;
    g.fillStyle=muted?'#dae8dc':'#e4f5d9';[[.13,.28],[.58,.2],[.77,.5],[.91,.25]].forEach(([x,y])=>g.fillRect(Math.round(x*w),Math.round(y*h),1,1));
    // Sand shelf and sea grass anchor the picture without obscuring the fish.
    g.fillStyle=muted?'#c3d1b8':'#e5dbac';g.fillRect(0,h-2,w,2);
    g.fillStyle=muted?'#83a9a0':'#4f9a8b';
    for(const x of [6,10,w-9,w-14]){const tall=x%2?5:7;g.fillRect(x,h-2-tall,1,tall);g.fillRect(x-1,h-4,1,2);g.fillRect(x+1,h-tall,1,2);}
    if(!muted){g.fillStyle='#eaa27c';g.fillRect(w-23,h-6,2,4);g.fillRect(w-25,h-7,2,2);g.fillRect(w-20,h-8,1,4);g.fillRect(w-23,h-4,4,1);}
  }
  window.SipSeascape={paint};
})();
