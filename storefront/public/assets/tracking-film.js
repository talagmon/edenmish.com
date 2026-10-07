/* Decorative tracking-entry film only. No tracking/API state. */
(function () {
  'use strict';
  const film = document.getElementById('tracking-film');
  const control = document.getElementById('tracking-motion');
  if (!film || !control) return;
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let manual = false;
  let visible = true;
  let failed = false;
  function sync() {
    const reduced = preference.matches || document.documentElement.classList.contains('eden-a11y-motion');
    const stopped = reduced || manual || !visible || document.hidden || failed;
    control.hidden = reduced || failed;
    control.setAttribute('aria-pressed', String(manual));
    control.textContent = manual ? 'הפעלת תנועה' : 'עצירת תנועה';
    if (stopped) {
      film.pause();
      if (reduced || failed) film.classList.remove('is-ready');
      return;
    }
    if (!film.hasAttribute('src')) { film.src = film.dataset.src; film.load(); }
    film.play().then(() => film.classList.add('is-ready')).catch(() => {
      manual = true; control.textContent = 'הפעלת תנועה'; control.setAttribute('aria-pressed', 'true');
    });
  }
  control.addEventListener('click', () => { manual = !manual; sync(); });
  preference.addEventListener('change', sync);
  document.addEventListener('visibilitychange', sync);
  new MutationObserver(sync).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  film.addEventListener('error', () => { failed = true; sync(); });
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); }, { threshold: 0.1 }).observe(film.parentElement);
  } else sync();
})();
