/* Presentation only. No order, audience eligibility, payment or account state. */
(function () {
  'use strict';
  const root = document.querySelector('.delivery-journey');
  if (!root) return;
  const scroller = root.querySelector('.journey-scroller');
  const stops = Array.from(root.querySelectorAll('.journey-stop'));
  const buttons = Array.from(root.querySelectorAll('[data-stop]'));
  const controls = root.querySelector('.journey-controls');
  const film = document.getElementById('journey-film');
  const motion = document.getElementById('journey-motion');
  const gateway = root.querySelector('.journey-gateway');
  const story = document.getElementById('journey-story-dialog');
  const switcher = root.querySelector('.journey-audience-switch');
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  let current = 0, paused = false, visible = true, frame = 0, entered = !gateway;
  const reduced = () => preference.matches || document.documentElement.classList.contains('eden-a11y-motion');
  function syncFilm() {
    const stop = paused || reduced() || !visible || document.hidden || story?.open;
    motion.textContent = stop ? 'הפעלת תנועה' : 'עצירת תנועה';
    motion.setAttribute('aria-pressed', String(stop));
    motion.hidden = reduced();
    if (stop) { film.pause(); return; }
    if (!film.hasAttribute('src')) { film.src = film.dataset.src; film.load(); }
    film.play().catch(() => { paused = true; motion.textContent = 'הפעלת תנועה'; motion.setAttribute('aria-pressed', 'true'); });
  }
  function update() {
    frame = 0;
    const i = Math.max(0, Math.min(stops.length - 1, Math.round(scroller.scrollTop / scroller.clientHeight)));
    const changed = current !== i;
    current = i; root.dataset.scene = String(i);
    if (changed) buttons[i].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    stops.forEach((stop, index) => { stop.classList.toggle('is-current', i === index); stop.inert = !entered || i !== index; });
    buttons.forEach((button, index) => { if (i === index) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current'); });
    document.getElementById('journey-scroll-hint').lastChild.textContent = ` ${i + 1} / ${stops.length} · ${i === stops.length - 1 ? 'אפשר לחזור לכל תחנה' : 'גללו לתחנה הבאה'}`;
  }
  function go(i, smooth = true) {
    if (smooth) root.scrollIntoView({ block: 'start', behavior: 'auto' });
    scroller.scrollTo({ top: stops[i].offsetTop, behavior: smooth && !reduced() ? 'smooth' : 'auto' });
  }
  buttons.forEach((button, index) => button.addEventListener('click', () => go(index)));
  scroller.addEventListener('scroll', () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
  scroller.addEventListener('keydown', event => {
    if (event.target !== scroller || event.altKey || event.ctrlKey || event.metaKey) return;
    const delta = ['ArrowDown', 'PageDown'].includes(event.key) ? 1 : ['ArrowUp', 'PageUp'].includes(event.key) ? -1 : 0;
    if (delta) { event.preventDefault(); go(Math.max(0, Math.min(stops.length - 1, current + delta))); }
  });
  motion.addEventListener('click', () => { paused = !paused; syncFilm(); });
  preference.addEventListener('change', syncFilm);
  document.addEventListener('visibilitychange', syncFilm);
  new MutationObserver(syncFilm).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  new IntersectionObserver(entries => { visible = entries[0].isIntersecting; syncFilm(); }, { threshold: .1 }).observe(root);
  new ResizeObserver(() => { go(current, false); }).observe(scroller);
  root.classList.add('is-pinned');
  document.body.classList.add('journey-active');
  buttons.forEach((button, index) => button.setAttribute('aria-controls', stops[index].id));
  controls.hidden = false;
  if (gateway) {
    gateway.hidden = false; root.classList.add('gateway-on');
    root.querySelectorAll('[data-audience]').forEach(button => button.addEventListener('click', () => {
      const business = button.dataset.audience === 'business';
      const title = document.getElementById('journey-title');
      title.innerHTML = business ? 'המשלוחים של העסק.<br><span>בידיים של עדן.</span>' : 'המשלוח שלכם.<br><span>בידיים של עדן.</span>';
      const link = document.getElementById('journey-send').querySelector('.journey-button');
      link.href = business ? '/business.html' : '/booking.html';
      link.firstChild.textContent = business ? 'מסלולים לעסק שלכם ' : 'בדיקת מחיר והזמנה ';
      document.getElementById('journey-areas').querySelector('.journey-button').href = business ? '/business-account.html' : '/booking.html';
      document.getElementById('journey-track').querySelector('.journey-button').href = business ? '/business-account.html' : '/track.html';
      document.getElementById('journey-track').querySelector('.journey-button').firstChild.textContent = business ? 'לחשבון העסקי שלכם ' : 'עקבו אחרי משלוח ';
      root.querySelector('[data-final-order]').href = business ? '/business.html' : '/booking.html';
      root.querySelector('[data-final-order]').firstChild.textContent = business ? 'מסלולים לעסק שלכם ' : 'התחילו משלוח חדש ';
      switcher.textContent = business ? 'מסלול עסקי · החלפה' : 'מסלול פרטי · החלפה';
      entered = true; root.classList.remove('gateway-on'); gateway.hidden = true; controls.hidden = false; switcher.hidden = false;
      go(0, false); root.scrollIntoView({ block: 'start', behavior: 'auto' }); update(); scroller.focus({ preventScroll: true });
    }));
    switcher.addEventListener('click', () => {
      entered = false; gateway.hidden = false; root.classList.add('gateway-on'); controls.hidden = false; switcher.hidden = true;
      update(); gateway.querySelector('button').focus({ preventScroll: true });
    });
  }
  function openStory() {
    if (!story.open) story.showModal();
    syncFilm();
  }
  root.querySelector('[data-open-story]').addEventListener('click', openStory);
  story.addEventListener('close', () => {
    syncFilm();
    root.querySelector('[data-open-story]').focus({ preventScroll: true });
  });
  function revealAnchor() {
    const id = location.hash.slice(1);
    const aliases = { 'home-info': 'journey-how', 'info-how': 'journey-how', 'info-about': 'journey-eden', 'behind-the-scenes': 'journey-more' };
    const index = stops.findIndex(stop => stop.id === (aliases[id] || id));
    if (index < 0) return;
    entered = true; gateway.hidden = true; root.classList.remove('gateway-on'); switcher.hidden = false;
    go(index, false); update();
    scroller.focus({ preventScroll: true });
    if (id === 'behind-the-scenes') openStory();
  }
  root.querySelectorAll('a[href="/#behind-the-scenes"]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); openStory(); }));
  window.addEventListener('hashchange', revealAnchor);
  update();
  revealAnchor();
})();
