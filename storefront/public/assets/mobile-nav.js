// Keeps the public navigation identical on every page and builds its mobile menu.
(function () {
  var headerEl = document.querySelector('body > header.fixed') || document.querySelector('body > nav.fixed');
  if (!headerEl) return;
  var bar = headerEl.querySelector('div, nav');
  var desk = bar && bar.querySelector('[class*="md:flex"]');
  if (!desk) return;

  var navItems = [
    { key: 'home', label: 'בית', href: '/' },
    { key: 'services', label: 'שירותים', href: '/booking.html' },
    { key: 'tracking', label: 'מעקב משלוחים', href: '/track.html' },
    { key: 'business', label: 'לעסקים', href: '/business' },
    { key: 'about', label: 'אודות', href: '/about.html' }
  ];

  function activeKey(pathname) {
    var path = (pathname || '/').replace(/\/+$/, '') || '/';
    if (path === '/' || path === '/index.html') return 'home';
    if (path === '/booking' || path === '/booking.html') return 'services';
    if (path === '/track' || path === '/track.html') return 'tracking';
    if (path === '/business' || path === '/business.html' || path === '/business-account' || path === '/business-account.html') return 'business';
    if (path === '/about' || path === '/about.html') return 'about';
    return '';
  }

  var currentKey = activeKey(window.location.pathname);

  function buildLink(item, mobile) {
    var link = document.createElement('a');
    link.className = mobile ? 'site-nav-link eden-mobile-nav__link' : 'site-nav-link';
    link.href = item.href;
    link.textContent = item.label;
    link.dataset.navKey = item.key;
    if (item.key === currentKey) {
      link.classList.add('site-nav-link--active');
      link.setAttribute('aria-current', 'page');
    }
    return link;
  }

  desk.classList.add('site-nav');
  desk.setAttribute('aria-label', 'ניווט ראשי');
  desk.replaceChildren.apply(desk, navItems.map(function (item) { return buildLink(item, false); }));
  bar.classList.add('eden-nav-bar');

  var brand = bar.querySelector('a[href="/"]');
  var cta = Array.prototype.find.call(bar.children, function (child) {
    return child.tagName === 'A' && child !== brand && !desk.contains(child);
  });
  if (cta) {
    cta.className = 'site-nav-cta';
    cta.href = '/booking.html';
    cta.textContent = 'שלחו עכשיו';
  }

  var burger = document.createElement('button');
  burger.type = 'button';
  burger.className = 'eden-nav-toggle';
  burger.setAttribute('aria-label', 'תפריט');
  burger.setAttribute('aria-expanded', 'false');
  burger.setAttribute('aria-controls', 'eden-mobile-nav');
  burger.innerHTML = '<span class="material-symbols-outlined" aria-hidden="true">menu</span>';
  if (cta) bar.insertBefore(burger, cta); else bar.appendChild(burger);

  var panel = document.createElement('nav');
  panel.id = 'eden-mobile-nav';
  panel.className = 'eden-mobile-nav';
  panel.setAttribute('aria-label', 'ניווט ראשי במובייל');
  panel.hidden = true;
  navItems.forEach(function (item) { panel.appendChild(buildLink(item, true)); });
  headerEl.parentNode.insertBefore(panel, headerEl.nextSibling);

  function setMenu(open) {
    panel.hidden = !open;
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    burger.querySelector('.material-symbols-outlined').textContent = open ? 'close' : 'menu';
  }

  burger.addEventListener('click', function (e) {
    e.preventDefault();
    setMenu(panel.hidden);
  });
  panel.addEventListener('click', function (e) {
    if (e.target.closest('a')) setMenu(false);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.hidden) {
      setMenu(false);
      burger.focus();
    }
  });
})();

// Footer: wire policy links to the legal pages + add missing legal links and business details.
(function () {
  var footer = document.querySelector('footer');
  if (!footer) return;
  footer.querySelectorAll('a').forEach(function (a) {
    var t = (a.textContent || '').trim();
    if (t === 'אודותינו' || t === 'צור קשר') a.setAttribute('href', '/about.html');
    else if (t === 'תקנון' || t === 'תקנון ותנאי שימוש' || t === 'תנאי שימוש') a.setAttribute('href', '/terms.html');
    else if (t === 'מדיניות פרטיות') a.setAttribute('href', '/privacy.html');
    else if (t === 'נגישות' || t === 'הצהרת נגישות') a.setAttribute('href', '/accessibility.html');
  });
  var links = footer.querySelectorAll('a');
  var hasRefund = Array.prototype.some.call(links, function (a) { return (a.textContent || '').trim() === 'מדיניות ביטול'; });
  if (!hasRefund) {
    var privacy = Array.prototype.find.call(links, function (a) { return (a.textContent || '').trim() === 'מדיניות פרטיות'; });
    if (privacy) { var r = privacy.cloneNode(true); r.textContent = 'מדיניות ביטול'; r.setAttribute('href', '/refund.html'); privacy.parentNode.insertBefore(r, privacy.nextSibling); }
  }
  var linksAfterCancellationPolicy = footer.querySelectorAll('a');
  var hasCancellationForm = Array.prototype.some.call(linksAfterCancellationPolicy, function (a) { return (a.textContent || '').trim() === 'ביטול עסקה'; });
  if (!hasCancellationForm) {
    var refundPolicy = Array.prototype.find.call(linksAfterCancellationPolicy, function (a) { return (a.textContent || '').trim() === 'מדיניות ביטול'; });
    if (refundPolicy) { var cancellation = refundPolicy.cloneNode(true); cancellation.textContent = 'ביטול עסקה'; cancellation.setAttribute('href', '/cancel.html'); refundPolicy.parentNode.insertBefore(cancellation, refundPolicy.nextSibling); }
  }
  var linksAfterRefund = footer.querySelectorAll('a');
  var hasBusiness = Array.prototype.some.call(linksAfterRefund, function (a) { return (a.textContent || '').trim() === 'לעסקים'; });
  if (!hasBusiness) {
    var aboutForBusiness = Array.prototype.find.call(linksAfterRefund, function (a) { return (a.textContent || '').trim() === 'אודות'; });
    if (aboutForBusiness) { var business = aboutForBusiness.cloneNode(true); business.textContent = 'לעסקים'; business.setAttribute('href', '/business'); aboutForBusiness.parentNode.insertBefore(business, aboutForBusiness.nextSibling); }
  }
  var linksAfterBusiness = footer.querySelectorAll('a');
  var hasAccessibility = Array.prototype.some.call(linksAfterBusiness, function (a) { return (a.textContent || '').trim() === 'נגישות'; });
  if (!hasAccessibility) {
    var refund = Array.prototype.find.call(linksAfterBusiness, function (a) { return (a.textContent || '').trim() === 'מדיניות ביטול'; });
    var privacyForAccessibility = Array.prototype.find.call(linksAfterBusiness, function (a) { return (a.textContent || '').trim() === 'מדיניות פרטיות'; });
    var anchor = refund || privacyForAccessibility;
    if (anchor) { var accessibility = anchor.cloneNode(true); accessibility.textContent = 'נגישות'; accessibility.setAttribute('href', '/accessibility.html'); anchor.parentNode.insertBefore(accessibility, anchor.nextSibling); }
  }
  if (!/עוסק פטור/.test(footer.textContent)) {
    var line = document.createElement('p');
    line.className = 'text-center text-label-sm text-on-surface-variant opacity-70 pt-stack-sm';
    line.textContent = 'עדן אריאלי · עוסק פטור (מס׳ 211568928) · כל המחירים באתר סופיים ואינם כוללים מע״מ (עוסק פטור)';
    footer.appendChild(line);
  }
})();
