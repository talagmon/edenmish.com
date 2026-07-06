// Lock viewport: block pinch-zoom for an app-like fixed layout (iOS Safari ignores
// user-scalable=no, so we also intercept gesturestart + multi-touch).
document.addEventListener('gesturestart', function (e) { e.preventDefault(); }, { passive: false });
document.addEventListener('touchmove', function (e) { if (e.touches && e.touches.length > 1) e.preventDefault(); }, { passive: false });

// Auto-builds a mobile hamburger menu from each page's existing desktop nav.
(function () {
  var headerEl = document.querySelector('header') || document.querySelector('nav.fixed');
  if (!headerEl) return;
  var bar = headerEl.querySelector('div, nav');
  var desk = bar && bar.querySelector('[class*="md:flex"]');
  if (!desk) return;
  var links = [];
  desk.querySelectorAll('a').forEach(function (a) { links.push(a.outerHTML); });
  if (!links.length) return;

  var burger = document.createElement('button');
  burger.type = 'button';
  burger.className = 'md:hidden p-2 text-on-surface hover:text-primary transition-colors';
  burger.setAttribute('aria-label', 'תפריט');
  burger.innerHTML = '<span class="material-symbols-outlined">menu</span>';
  var last = bar.children[bar.children.length - 1];
  if (last) bar.insertBefore(burger, last); else bar.appendChild(burger);

  var panel = document.createElement('nav');
  panel.className = 'md:hidden hidden glass-bg backdrop-blur-xl border-b border-glass-border px-gutter-mobile py-stack-md flex flex-col gap-stack-md';
  panel.innerHTML = links.join('');
  headerEl.parentNode.insertBefore(panel, headerEl.nextSibling);

  burger.addEventListener('click', function (e) { e.preventDefault(); panel.classList.toggle('hidden'); });
  panel.addEventListener('click', function (e) { if (e.target.closest('a')) panel.classList.add('hidden'); });
})();

// Footer: wire policy links to the legal pages + add the עוסק פטור / final-price line.
(function () {
  var footer = document.querySelector('footer');
  if (!footer) return;
  footer.querySelectorAll('a').forEach(function (a) {
    var t = (a.textContent || '').trim();
    if (t === 'אודותינו' || t === 'צור קשר') a.setAttribute('href', '/about.html');
    else if (t === 'תקנון' || t === 'תקנון ותנאי שימוש' || t === 'תנאי שימוש') a.setAttribute('href', '/terms.html');
    else if (t === 'מדיניות פרטיות') a.setAttribute('href', '/privacy.html');
  });
  var links = footer.querySelectorAll('a');
  var hasRefund = Array.prototype.some.call(links, function (a) { return (a.textContent || '').trim() === 'מדיניות ביטול'; });
  if (!hasRefund) {
    var privacy = Array.prototype.find.call(links, function (a) { return (a.textContent || '').trim() === 'מדיניות פרטיות'; });
    if (privacy) { var r = privacy.cloneNode(true); r.textContent = 'מדיניות ביטול'; r.setAttribute('href', '/refund.html'); privacy.parentNode.insertBefore(r, privacy.nextSibling); }
  }
  if (!/עוסק פטור/.test(footer.textContent)) {
    var line = document.createElement('p');
    line.className = 'text-center text-label-sm text-on-surface-variant opacity-70 pt-stack-sm';
    line.textContent = 'עדן אריאלי · עוסק פטור (מס׳ 211568928) · כל המחירים באתר סופיים ואינם כוללים מע״מ (עוסק פטור)';
    footer.appendChild(line);
  }
})();
