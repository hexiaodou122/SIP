(async () => {
  'use strict';
  const PX=window.SipConstants.PX;
  document.documentElement.style.setProperty('--pixel',`${PX}px`);
  let catalog=[],collection={fish:{}};
  const root=document.getElementById('cards');
  function text(tag,className,value){const e=document.createElement(tag);e.className=className;e.textContent=value;return e;}
  function render(){
    root.replaceChildren();
    for(const fish of catalog){
      const record=collection.fish?.[fish.id],card=document.createElement('article');card.className=`card${record?'':' locked'}`;
      const scene=document.createElement('div');scene.className='scene';
      // Each card has its own small habitat, with the same grid as its portrait.
      const sprite=window.SipSprites.portrait(fish.id),canvas=document.createElement('canvas');
      canvas.width=94;canvas.height=29;
      canvas.style.width=`${canvas.width*PX}px`;canvas.style.height=`${canvas.height*PX}px`;
      const g=canvas.getContext('2d');window.SipSeascape.paint(g,canvas.width,canvas.height,fish.habitat,!record);
      const portrait=document.createElement('canvas');portrait.width=sprite.width;portrait.height=sprite.height;
      const pg=portrait.getContext('2d');pg.drawImage(sprite,0,0);
      if(!record){pg.globalCompositeOperation='source-in';pg.fillStyle='#183c49';pg.fillRect(0,0,portrait.width,portrait.height);}
      g.drawImage(portrait,Math.floor((canvas.width-sprite.width)/2),Math.floor((canvas.height-sprite.height)/2));
      scene.append(canvas);card.append(scene);
      card.append(text('span','habitat',fish.habitat));card.append(text('h2','',record?fish.name:'尚未遇见'));card.append(text('p','english',record?fish.english:'UNKNOWN'));
      card.append(text('p','description',record?fish.description:'喝满一天，也许会遇见它'));
      if(record){const facts=document.createElement('div');facts.className='facts';for(const [label,value] of [['第一次遇见',record.firstSeen],['最大的一条',`${Number(record.maxCm).toFixed(1)} cm`],['遇见过',`${record.count} 次`]]){facts.append(text('span','',label),text('b','',value));}card.append(facts);}root.append(card);
    }
  }
  if(window.sip){const data=await window.sip.invoke('get-collection');catalog=data.fishCatalog;collection=data.collection;render();window.sip.on('state',data=>{if(data.collection){collection=data.collection;render();}});}
  else {catalog=await fetch('fish.json').then(r=>r.json());render();}
})();
