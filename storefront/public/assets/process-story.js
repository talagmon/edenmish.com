/* Native swipe stories. Presentation only; no order, payment or account state. */
(function () {
  'use strict';
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.classList.contains('eden-a11y-motion');
  document.querySelectorAll('[data-process-story]').forEach((story, storyIndex) => {
    const deck = story.querySelector('.process-deck');
    const cards = Array.from(deck.querySelectorAll('.process-card'));
    const controls = story.querySelector('[data-process-controls]');
    if (!cards.length || !controls) return;
    let current = 0, frame = 0;
    const button = (label, content) => {
      const el = document.createElement('button');
      el.type = 'button'; el.setAttribute('aria-label', label); el.textContent = content;
      return el;
    };
    const previous = button('השלב הקודם בסיפור', '→');
    const next = button('השלב הבא בסיפור', '←');
    const steps = document.createElement('div'); steps.className = 'process-step-buttons';
    steps.setAttribute('role', 'group'); steps.setAttribute('aria-label', 'בחירת שלב בסיפור');
    const buttons = cards.map((card, i) => {
      card.id ||= 'process-' + storyIndex + '-' + i;
      const el = button('שלב ' + (i + 1) + ': ' + card.dataset.storyLabel, (i + 1) + ' · ' + card.dataset.storyLabel);
      el.setAttribute('aria-controls', card.id);
      el.addEventListener('click', () => go(i)); steps.appendChild(el); return el;
    });
    previous.className = next.className = 'process-arrow';
    controls.append(previous, steps, next); controls.hidden = false;
    function sync(index) {
      current = index;
      cards.forEach((card, i) => card.classList.toggle('is-story-current', i === index));
      buttons.forEach((el, i) => el.setAttribute('aria-pressed', String(i === index)));
      previous.disabled = index === 0; next.disabled = index === cards.length - 1;
    }
    function go(index) {
      const i = Math.max(0, Math.min(cards.length - 1, index));
      const offset = cards[i].getBoundingClientRect().right - deck.getBoundingClientRect().right;
      deck.scrollBy({ left: offset, behavior: reduced() ? 'auto' : 'smooth' });
    }
    previous.addEventListener('click', () => go(current - 1));
    next.addEventListener('click', () => go(current + 1));
    deck.addEventListener('keydown', event => {
      if (event.target !== deck) return;
      const i = event.key === 'ArrowLeft' ? current + 1 : event.key === 'ArrowRight' ? current - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? cards.length - 1 : null;
      if (i === null) return;
      event.preventDefault(); event.stopPropagation(); go(i);
    });
    deck.addEventListener('scroll', () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const edge = deck.getBoundingClientRect().right;
        const offsets = cards.map(card => Math.abs(card.getBoundingClientRect().right - edge));
        sync(offsets.indexOf(Math.min(...offsets)));
      });
    }, { passive: true });
    sync(0);
  });
})();
