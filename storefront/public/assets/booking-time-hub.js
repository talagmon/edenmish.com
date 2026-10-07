/* Presentation only. Existing scheduling buttons own dates, availability and values. */
(function () {
  'use strict';
  const hub = document.querySelector('.schedule-hub');
  if (!hub) return;
  const dates = document.getElementById('sched-dates');
  const windows = document.getElementById('sched-windows');
  const custom = document.getElementById('sched-custom-date');
  const flash = document.getElementById('sched-flash');
  const display = hub.querySelector('.time-hub-display');
  function text(id, value) {
    const target = document.getElementById(id);
    if (target.textContent !== value) target.textContent = value;
  }
  function refresh() {
    const immediate = !flash.hidden;
    hub.dataset.mode = immediate ? 'flash' : 'scheduled';
    dates.querySelectorAll('button').forEach(button => {
      const label = button.textContent.trim();
      button.setAttribute('aria-label', label);
      const parts = label.match(/^(.*?)\s+(\d{2}\/\d{2})$/);
      if (!parts) return;
      button.dataset.day = parts[1].replace(' · ', ' ');
      button.dataset.date = parts[2];
    });
    const day = dates.querySelector('[aria-pressed="true"]')?.textContent.trim();
    const slot = windows.querySelector('[aria-pressed="true"]')?.textContent.trim();
    windows.querySelectorAll('button').forEach(button => button.setAttribute('aria-label', button.textContent.trim()));
    const customLabel = custom.value ? custom.value.split('-').reverse().join('/') : '';
    const hasDate = Boolean(day || customLabel);
    const ready = !immediate && hasDate && Boolean(slot);
    hub.dataset.ready = String(ready);
    hub.querySelector('.hub-empty').hidden = immediate || hasDate;
    text('time-hub-day', immediate ? 'שירות מהיר' : day || customLabel || 'מתחילים בבחירת יום');
    text('time-hub-slot', immediate ? 'שיגור מיידי בשעות הפעילות' : slot || (hasDate ? 'אין חלונות זמינים ביום הזה' : 'ואז בוחרים חלון איסוף נוח'));
    text('time-hub-status', immediate ? 'בדקו את הזמינות המוצגת למטה' : ready ? 'חלון האיסוף שנבחר · אפשר לשנות בלחיצה' : 'אפשר לשנות את הבחירה בכל רגע');
    const start = ready && slot.match(/^(\d{2}):(\d{2})/);
    const hour = start ? Number(start[1]) : 10;
    const minute = start ? Number(start[2]) : 10;
    hub.style.setProperty('--hub-hour', ((hour % 12) * 30 + minute / 2) + 'deg');
    hub.style.setProperty('--hub-minute', (minute * 6) + 'deg');
  }
  const observer = new MutationObserver(refresh);
  for (const root of [dates, windows, flash]) {
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-pressed', 'hidden'] });
  }
  custom.addEventListener('change', refresh);
  display.hidden = false;
  refresh();
})();
