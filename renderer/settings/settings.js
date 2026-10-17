(async () => {
  const api = window.sip || {
    send: (c, d) => console.log(c, d),
    invoke: async () => ({ settings: { goalMl: 1500, sipMl: 20, cupMl: 250, sound: false, launchAtLogin: false } }),
  };
  const { settings } = await api.invoke('get-settings');

  const cards = [...document.querySelectorAll('.card')];
  const custom = document.getElementById('custom');
  const goal = document.getElementById('goal');
  const sip = document.getElementById('sip');
  const sound = document.getElementById('sound');
  const login = document.getElementById('login');

  const preset = cards.find((c) =>
    Number(c.dataset.goal) === settings.goalMl && Number(c.dataset.sip) === settings.sipMl);
  select(preset || cards[2]);
  goal.value = settings.goalMl;
  sip.value = settings.sipMl;
  sound.checked = settings.sound;
  login.checked = settings.launchAtLogin;

  function select(card) {
    cards.forEach((c) => c.classList.toggle('on', c === card));
    custom.classList.toggle('show', card.hasAttribute('data-custom'));
  }

  cards.forEach((card) => card.addEventListener('click', () => {
    select(card);
    if (!card.hasAttribute('data-custom')) {
      goal.value = card.dataset.goal;
      sip.value = card.dataset.sip;
      save();
    }
  }));

  function save() {
    const g = Number(goal.value);
    const s = Number(sip.value);
    const patch = { sound: sound.checked, launchAtLogin: login.checked };
    if (g >= 300 && g <= 6000) patch.goalMl = g;
    if (s >= 5 && s <= 200) patch.sipMl = s;
    api.send('save-settings', patch);
  }

  [goal, sip].forEach((el) => el.addEventListener('change', save));
  [sound, login].forEach((el) => el.addEventListener('change', save));
})();
