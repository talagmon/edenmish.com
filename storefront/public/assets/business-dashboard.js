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
})();
