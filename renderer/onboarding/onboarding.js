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
