// Auto-builds a mobile hamburger menu from each page's existing desktop nav.
(function () {
  var headerEl = document.querySelector('header') || document.querySelector('nav.fixed');
  if (!headerEl) return;
  var bar = headerEl.querySelector('div, nav');
  var desk = bar && bar.querySelector('[class*="md:flex"]');
  if (!desk) return;
  var hasBusiness = Array.prototype.some.call(desk.querySelectorAll('a'), function (a) { return (a.textContent || '').trim() === 'לעסקים'; });
  if (!hasBusiness) {
    var aboutLink = Array.prototype.find.call(desk.querySelectorAll('a'), function (a) { return (a.textContent || '').trim() === 'אודות'; });
    if (aboutLink) {
      var businessLink = aboutLink.cloneNode(true);
      businessLink.textContent = 'לעסקים';
      businessLink.setAttribute('href', '/business');
      desk.insertBefore(businessLink, aboutLink);
    }
  }
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
