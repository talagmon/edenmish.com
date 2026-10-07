/* Presentation only: reveal account sections without touching account state. */
(() => {
  const root = document.querySelector('.business-dashboard');
  if (!root) return;
  function reveal(hash, focus = false) {
    const target = document.getElementById(hash.slice(1));
    if (!target || !target.closest('#dashboard')) return;
    if (target.matches('details')) target.open = true;
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('eden-a11y-motion');
    target.scrollIntoView({ behavior: reduceMotion ? 'instant' : 'smooth', block: 'start' });
    if (focus) (target.matches('details') ? target.querySelector('summary') : target).focus({ preventScroll: true });
  }
  root.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || !link.closest('#dashboard, #account-toolbar') || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const hash = link.getAttribute('href');
    if (!document.getElementById(hash.slice(1))) return;
    event.preventDefault();
    history.replaceState(null, '', hash);
    reveal(hash, true);
  });
  window.addEventListener('hashchange', () => reveal(location.hash));

  // Enhance the existing server-driven cards in place. Their top-up buttons and
  // disabled states remain owned by renderPlans(), including after refreshes.
  const scene = root.querySelector('.account-plan-scene');
  if (!scene) return;
  const deck = scene.querySelector('.account-plan-deck');
  const controls = scene.querySelector('.account-plan-controls');
  const position = scene.querySelector('.account-plan-position');
  const programs = root.querySelector('#programs');
  let cards = [], choices = [], selectedId = '', current = 0, frame = 0;
  let deckOpen = programs.open;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('eden-a11y-motion');
  function button(label, text) {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = text; node.setAttribute('aria-label', label);
    return node;
  }
  const previous = button('המסלול הקודם', '→');
  const next = button('המסלול הבא', '←');
  previous.className = next.className = 'account-plan-arrow';
  const choiceGroup = document.createElement('div');
  choiceGroup.className = 'account-plan-choices';
  choiceGroup.setAttribute('role', 'group');
  choiceGroup.setAttribute('aria-label', 'בחירת מסלול להצגה');
  controls.append(previous, choiceGroup, next);
  function sync(index) {
    current = index; selectedId = cards[index].dataset.planCard;
    cards.forEach((card, i) => {
      card.classList.toggle('is-deck-current', i === index);
      card.classList.toggle('is-deck-before', i < index);
      card.classList.toggle('is-deck-after', i > index);
    });
    choices.forEach((choice, i) => choice.setAttribute('aria-pressed', String(i === index)));
    previous.disabled = index === 0; next.disabled = index === cards.length - 1;
    position.textContent = 'מסלול ' + (index + 1) + ' מתוך ' + cards.length + ' · ' + cards[index].querySelector('.plan-name').textContent;
    if (programs.open && choiceGroup.clientWidth) {
      const choice = choices[index];
      choiceGroup.scrollBy({left: choice.offsetLeft + choice.offsetWidth / 2 - choiceGroup.scrollLeft - choiceGroup.clientWidth / 2, behavior: 'instant'});
    }
  }
  function center(index, animate = true) {
    if (!cards.length) return;
    index = Math.max(0, Math.min(cards.length - 1, index));
    sync(index);
    if (!programs.open || !deck.clientWidth) return;
    const card = cards[index];
    const offset = card.offsetLeft + card.offsetWidth / 2 - deck.scrollLeft - deck.clientWidth / 2;
    deck.scrollBy({left: offset, behavior: animate && !reduced() ? 'smooth' : 'instant'});
  }
  function enhance() {
    const focused = document.activeElement;
    cards = Array.from(deck.querySelectorAll('[data-plan-card]'));
    if (!cards.length) return;
    cards.forEach(card => {
      card.id = 'account-plan-' + card.dataset.planCard;
      card.querySelector('.plan-art-wrap').dataset.label = card.querySelector('.plan-name').textContent.split(' · ')[0];
      const body = card.querySelector('.plan-body');
      if (!body.querySelector('.account-plan-copy')) {
        const copy = document.createElement('div'); copy.className = 'account-plan-copy';
        Array.from(body.children).filter(child => !child.classList.contains('topup')).forEach(child => copy.append(child));
        body.prepend(copy);
      }
    });
    const chosen = cards.findIndex(card => card.dataset.planCard === selectedId);
    const preferred = cards.findIndex(card => card.classList.contains('selected'));
    const active = cards.findIndex(card => card.classList.contains('current'));
    const index = chosen >= 0 ? chosen : preferred >= 0 ? preferred : active >= 0 ? active : 0;
    // Reuse controls when a balance refresh recreates the same five cards, so
    // keyboard focus is not lost while the customer browses the deck.
    const ids = cards.map(card => card.dataset.planCard).join(',');
    if (choiceGroup.dataset.plans !== ids) {
      choiceGroup.replaceChildren(); choiceGroup.dataset.plans = ids;
      choices = cards.map((card, i) => {
        const name = card.querySelector('.plan-name').textContent;
        const label = name.split(' · ')[0];
        const choice = button('הצגת מסלול ' + name, label);
        choice.setAttribute('aria-controls', card.id);
        choice.addEventListener('click', () => center(i));
        choiceGroup.append(choice); return choice;
      });
    }
    controls.hidden = false;
    scene.classList.add('is-deck-ready');
    center(index, false);
    if (focused && !focused.isConnected) choices[index].focus({preventScroll: true});
  }
  previous.addEventListener('click', () => center(current - 1));
  next.addEventListener('click', () => center(current + 1));
  deck.addEventListener('keydown', event => {
    if (event.target !== deck) return;
    const index = event.key === 'ArrowLeft' ? current + 1 : event.key === 'ArrowRight' ? current - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1 : null;
    if (index !== null) { event.preventDefault(); center(index); }
  });
  deck.addEventListener('scroll', () => {
    if (frame || !cards.length || !programs.open || !deckOpen) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const middle = deck.getBoundingClientRect().left + deck.clientWidth / 2;
      const distances = cards.map(card => Math.abs(card.getBoundingClientRect().left + card.getBoundingClientRect().width / 2 - middle));
      sync(distances.indexOf(Math.min(...distances)));
    });
  }, {passive: true});
  deck.addEventListener('focusin', event => {
    const index = cards.findIndex(card => card.contains(event.target));
    if (index >= 0 && index !== current) center(index);
  });
  programs.addEventListener('toggle', () => {
    // Opening a details element can emit a scroll before its toggle event. Keep
    // that restored position from replacing the account's preferred plan.
    deckOpen = programs.open;
    cancelAnimationFrame(frame); frame = 0;
    if (deckOpen) center(current, false);
  });
  const observer = new MutationObserver(enhance);
  ['entry-plan-cards', 'plan-cards'].forEach(id => observer.observe(document.getElementById(id), {childList: true}));
  new ResizeObserver(() => { if (cards.length) center(current, false); }).observe(deck);
  enhance();
})();
