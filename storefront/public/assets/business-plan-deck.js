/* Fixed-size plan scene; presentation only. Selection links retain their original URLs. */
(function () {
  'use strict';
  const scene = document.querySelector('[data-plan-selector]');
  if (!scene) return;
  const deck = scene.querySelector('.business-plan-deck');
  const cards = Array.from(deck.children);
  const controls = scene.querySelector('[data-plan-controls]');
  let current = 0, frame = 0;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('eden-a11y-motion');
  function makeButton(label, text) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.setAttribute('aria-label', label); return b;
  }
  const prev = makeButton('המסלול הקודם', '→'), next = makeButton('המסלול הבא', '←');
  prev.className = next.className = 'business-plan-arrow';
  const choices = document.createElement('div'); choices.className = 'business-plan-choices'; choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'בחירת מסלול להצגה');
  const buttons = cards.map((card, i) => {
    const b = makeButton('הצגת מסלול ' + card.dataset.planName, card.dataset.planName);
    b.setAttribute('aria-controls', card.id); b.addEventListener('click', () => go(i)); choices.append(b); return b;
  });
  controls.append(prev, choices, next); controls.hidden = false;
  function sync(i) {
    current = i;
    cards.forEach((card, j) => {
      card.classList.toggle('is-plan-current', j === i);
      card.classList.toggle('is-plan-before', j < i);
      card.classList.toggle('is-plan-after', j > i);
    });
    buttons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
    prev.disabled = i === 0; next.disabled = i === cards.length - 1;
  }
  function go(i) {
    i = Math.max(0, Math.min(cards.length - 1, i));
    // Center from untransformed layout so card rotation does not affect navigation.
    const offset = cards[i].offsetLeft + cards[i].offsetWidth / 2 - deck.scrollLeft - deck.clientWidth / 2;
    deck.scrollBy({left: offset, behavior: reduced() ? 'auto' : 'smooth'});
    scene.scrollIntoView({block: 'start', behavior: reduced() ? 'auto' : 'smooth'});
  }
  prev.addEventListener('click', () => go(current - 1)); next.addEventListener('click', () => go(current + 1));
  deck.addEventListener('keydown', event => {
    if (event.target !== deck) return;
    const i = event.key === 'ArrowLeft' ? current + 1 : event.key === 'ArrowRight' ? current - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1 : null;
    if (i === null) return;
    event.preventDefault(); go(i);
  });
  deck.addEventListener('scroll', () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const center = deck.getBoundingClientRect().left + deck.clientWidth / 2;
      const distances = cards.map(card => Math.abs(card.getBoundingClientRect().left + card.getBoundingClientRect().width / 2 - center));
      sync(distances.indexOf(Math.min(...distances)));
    });
  }, {passive:true});
  deck.addEventListener('focusin', event => {
    const i = cards.findIndex(card => card.contains(event.target));
    if (i >= 0 && i !== current) go(i);
  });
  document.querySelectorAll('a[href="#starter-offers"]').forEach(a => a.addEventListener('click', () => go(0)));
  document.querySelectorAll('a[href="#business-plans"]').forEach(a => a.addEventListener('click', () => go(2)));
  sync(0);
  requestAnimationFrame(() => {
    if (location.hash === '#business-plans' || location.hash === '#starter-offers') {
      go(location.hash === '#business-plans' ? 2 : 0);
    }
  });
})();
