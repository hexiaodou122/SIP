(() => {
  const api = window.sip || { send: (c, d) => console.log(c, d) };
  const cards = [...document.querySelectorAll('.card')];
  const custom = document.getElementById('custom');
  let chosen = cards[0];

  cards.forEach((card) => card.addEventListener('click', () => {
    chosen = card;
    cards.forEach((c) => c.classList.toggle('on', c === card));
    custom.classList.toggle('show', card.hasAttribute('data-custom'));
  }));

  document.getElementById('go').addEventListener('click', () => {
    let goalMl, sipMl;
    if (chosen.hasAttribute('data-custom')) {
      goalMl = Number(document.getElementById('goal').value) || 1500;
      sipMl = Number(document.getElementById('sip').value) || 20;
    } else {
      goalMl = Number(chosen.dataset.goal);
      sipMl = Number(chosen.dataset.sip);
    }
    api.send('onboarding-done', { goalMl, sipMl });
  });
})();

// Original grid lettering and a small sea, using the same 3 px pixel size.
(() => {
  const PX=window.SipConstants.PX;
  document.documentElement.style.setProperty('--pixel',`${PX}px`);
  const g=document.getElementById('welcome-art').getContext('2d');
  const letters=['01111/10000/10000/01110/00001/00001/11110','11111/00100/00100/00100/00100/00100/11111','11110/10001/10001/11110/10000/10000/10000'];
  g.fillStyle='#c9e9e1';g.fillRect(0,0,164,42);
  g.fillStyle='#f5d982';g.fillRect(14,8,8,8);g.fillRect(16,6,4,12);g.fillRect(12,10,12,4);
  g.fillStyle='#f8fff0';g.fillRect(124,9,20,3);g.fillRect(128,6,9,3);g.fillRect(30,20,14,2);g.fillRect(34,18,6,2);
  g.fillStyle='#295e6b';
  letters.forEach((shape,i)=>shape.split('/').forEach((row,y)=>[...row].forEach((v,x)=>{if(v==='1')g.fillRect(54+i*20+x*3,3+y*3,3,3)})));
  for(let x=0;x<164;x++){const top=32+Math.round(Math.sin(x*.09)*1.5);g.fillStyle='#64d3c5';g.fillRect(x,top,1,2);g.fillStyle='#31a9bc';g.fillRect(x,top+2,1,42-top-2);}
  g.fillStyle='#e4f7e8';[[16,32],[42,30],[119,30],[146,32]].forEach(([x,y])=>g.fillRect(x,y,3,1));
})();
