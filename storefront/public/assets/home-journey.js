/* Compact informational tabs only. Booking and service-area logic is unchanged. */
(function () {
  'use strict';
  const hub = document.getElementById('home-info');
  if (!hub) return;
  const tabs = Array.from(hub.querySelectorAll('[data-info]'));
  const panels = tabs.map(tab => document.getElementById(tab.getAttribute('aria-controls')));
  function select(index, focus) {
    tabs.forEach((tab, i) => {
      tab.setAttribute('aria-selected', String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
    if (focus) tabs[index].focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(index, false));
    tab.addEventListener('keydown', event => {
      let next = index;
      if (event.key === 'ArrowLeft') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowRight') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault(); select(next, true);
    });
  });
  function revealAnchor() {
    const id = location.hash.slice(1);
    const target = id && document.getElementById(id);
    if (!target || !hub.contains(target)) return;
    const index = panels.findIndex(panel => panel === target || panel.contains(target));
    if (index >= 0) select(index, false);
    let ancestor = target;
    while (ancestor) {
      if (ancestor.tagName === 'DETAILS') ancestor.open = true;
      ancestor = ancestor.parentElement;
    }
    requestAnimationFrame(() => target.scrollIntoView({ behavior: 'auto', block: 'start' }));
  }
  select(0, false);
  hub.classList.add('is-enhanced');
  window.addEventListener('hashchange', revealAnchor);
  revealAnchor();
})();
