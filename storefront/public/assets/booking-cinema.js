/* Decorative scene only: reads the existing form, never controls booking state. */
(function () {
  'use strict';
  const form = document.getElementById('booking-form');
  const scene = document.querySelector('.booking-cinema');
  if (!form || !scene) return;
  const chapters = [
    ['החבילה שלכם', 'כל משלוח|מתחיל כאן.', 'בוחרים מה שולחים, ויוצאים לדרך.', 'החבילה שלכם במרכז.'],
    ['הפרטים שלכם', 'המשלוח שלכם.|העדכונים אליכם.', 'מוסיפים פרטי קשר, כדי להישאר בתמונה.', 'שירות אישי. לאורך כל הדרך.'],
    ['איסוף ומסירה', 'מהדלת שלכם.|לידיים הנכונות.', 'שתי כתובות, דרך אחת ברורה.', 'המחשת מסלול, לא מפת מעקב.'],
    ['שירות ומועד', 'בזמן שלכם.|בקצב שמתאים.', 'בוחרים שירות ומועד שנוחים לכם.', 'המחשה של הדרך שלנו בתל אביב.'],
    ['בדיקה ואישור', 'הכול במקום.|נשאר לאשר.', 'עוברים על הפרטים לפני שמזמינים שליח.', 'ההזמנה תישלח רק לאחר האישור.']
  ];
  const set = (id, value) => {
    const element = document.getElementById(id);
    if (element.textContent !== value) element.textContent = value;
  };
  function refresh() {
    const step = Math.max(1, Math.min(5, Number(form.dataset.flowScreen) || 1));
    if (scene.dataset.scene !== String(step) || !scene.dataset.ready) {
      scene.dataset.scene = String(step);
      scene.dataset.ready = 'true';
      document.body.dataset.bookingScene = String(step);
      const [chapter, title, caption, footnote] = chapters[step - 1];
      set('cinema-chapter', '0' + step + ' / ' + chapter);
      const titleNode = document.getElementById('cinema-title');
      const lines = title.split('|');
      titleNode.replaceChildren(document.createTextNode(lines[0]), document.createElement('br'), document.createTextNode(lines[1]));
      set('cinema-caption', caption);
      set('cinema-footnote', footnote);
    }
    const medium = form.querySelector('input[name="size"]:checked')?.value === 'medium';
    const image = document.getElementById('cinema-package-image');
    const source = '/assets/package-' + (medium ? 'medium' : 'small') + '-3d.webp';
    if (image.getAttribute('src') !== source) image.src = source;
    set('cinema-recipient', document.getElementById('f-name').value.trim() || 'השם שלכם');
    set('cinema-origin', document.getElementById('f-pickup-addr').value.trim() || 'מהדלת שלכם');
    set('cinema-destination', document.getElementById('f-dropoff-addr').value.trim() || 'לידיים הנכונות');
    const service = form.querySelector('input[name="service"]:checked')?.value || 'standard';
    const names = { eco: 'חסכוני', standard: 'רגיל', flash: 'מהיר' };
    const date = document.querySelector('#sched-dates button[aria-pressed="true"]')?.textContent.trim() || document.getElementById('sched-custom-date').value;
    const time = document.querySelector('#sched-windows button[aria-pressed="true"]')?.textContent.trim();
    const when = service === 'flash' ? 'מיידי, בכפוף לזמינות השירות' : [date, time].filter(Boolean).join(' · ') || 'בוחרים מועד לאיסוף';
    set('cinema-service', names[service]);
    set('cinema-time-label', when);
    set('cinema-review-size', medium ? 'בינונית' : 'קטנה');
    set('cinema-review-service', names[service]);
    set('cinema-review-time', when);
  }
  new MutationObserver(refresh).observe(form, { attributes: true, attributeFilter: ['data-flow-screen'] });
  ['input', 'change', 'click'].forEach(event => form.addEventListener(event, refresh));
  // Schedule buttons are rebuilt by the existing availability logic.
  for (const id of ['sched-dates', 'sched-windows', 'sched-flash']) {
    new MutationObserver(refresh).observe(document.getElementById(id), { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  }
  scene.hidden = false;
  document.body.classList.add('booking-cinematic');
  refresh();
})();
