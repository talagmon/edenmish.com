import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  businessAccountHtml,
  businessBatchIdleStatus,
  businessProfilePatch,
  createLatestBusinessSnapshotRefresher,
  selectRelevantBusinessTopup,
} from '../src/business-page.js';

const HOUR = 60 * 60 * 1000;
const NOW = 2_000_000_000_000;

describe('business payment status selection', () => {
  const paidTrial = {
    id: 'trial-paid',
    plan_id: 'trial',
    status: 'paid',
    created_at: NOW - (3 * HOUR),
    paid_at: NOW - HOUR,
  };
  const oldSilverCheckout = {
    id: 'silver-old',
    plan_id: 'silver',
    status: 'checkout_ready',
    created_at: NOW - (4 * HOUR),
  };

  test('shows the newer completed payment instead of an older unpaid checkout', () => {
    assert.equal(
      selectRelevantBusinessTopup([oldSilverCheckout, paidTrial], '', '', NOW),
      paidTrial,
    );
  });

  test('still shows a genuine checkout started after the completed payment', () => {
    const newGoldCheckout = {
      id: 'gold-new',
      plan_id: 'gold',
      status: 'checkout_ready',
      created_at: NOW - (30 * 60 * 1000),
    };
    assert.equal(
      selectRelevantBusinessTopup([oldSilverCheckout, paidTrial, newGoldCheckout], '', '', NOW),
      newGoldCheckout,
    );
  });

  test('does not revive an older checkout after the completed message is dismissed', () => {
    assert.equal(
      selectRelevantBusinessTopup([oldSilverCheckout, paidTrial], '', paidTrial.id, NOW),
      null,
    );
  });

  test('ignores a stale active checkout when a newer payment has completed', () => {
    assert.equal(
      selectRelevantBusinessTopup([oldSilverCheckout, paidTrial], oldSilverCheckout.id, '', NOW),
      paidTrial,
    );
  });

  test('shows a recent checkout when there is no completed payment', () => {
    assert.equal(
      selectRelevantBusinessTopup([oldSilverCheckout], '', '', NOW),
      oldSilverCheckout,
    );
  });

  test('hides checkout messages after 24 hours', () => {
    const expiredCheckout = { ...oldSilverCheckout, created_at: NOW - (25 * HOUR) };
    assert.equal(selectRelevantBusinessTopup([expiredCheckout], '', '', NOW), null);
  });

  test('keeps an unresolved payment mismatch visible until it is dismissed', () => {
    const mismatch = { id: 'review-payment', status: 'mismatch', created_at: NOW - (72 * HOUR) };
    assert.equal(selectRelevantBusinessTopup([mismatch, paidTrial], '', '', NOW), mismatch);
    assert.equal(selectRelevantBusinessTopup([mismatch, paidTrial], '', mismatch.id, NOW), paidTrial);
  });

  test('uses the completion time for a delayed paid checkout', () => {
    const delayedPayment = { ...paidTrial, created_at: NOW - (48 * HOUR), paid_at: NOW - HOUR };
    assert.equal(selectRelevantBusinessTopup([delayedPayment], '', '', NOW), delayedPayment);
  });

  test('does not keep polling an expired active checkout', () => {
    const expiredCheckout = { ...oldSilverCheckout, created_at: NOW - (25 * HOUR) };
    assert.equal(selectRelevantBusinessTopup([expiredCheckout], expiredCheckout.id, '', NOW), null);
  });
});

describe('business profile patching', () => {
  test('submits only fields the customer changed', () => {
    assert.deepEqual(businessProfilePatch({
      company: 'Eden Mish',
      contactName: '',
      phone: '',
    }, ['company']), { company_name: 'Eden Mish' });
  });

  test('allows an explicitly edited field to be cleared', () => {
    assert.deepEqual(businessProfilePatch({ phone: '' }, ['phone']), { phone: '' });
  });

  test('ignores a stale profile refresh that resolves after the post-save refresh', async () => {
    const pending = [];
    let rendered = null;
    const refresh = createLatestBusinessSnapshotRefresher(
      () => new Promise((resolve) => pending.push(resolve)),
      (snapshot) => { rendered = snapshot; },
    );

    const beforeSave = refresh();
    const afterSave = refresh();
    pending[1]({ account: { company_name: 'Saved business' } });
    assert.equal(await afterSave, true);
    pending[0]({ account: { company_name: 'Old business' } });
    assert.equal(await beforeSave, false);
    assert.equal(rendered.account.company_name, 'Saved business');
  });
});

describe('business batch idle status', () => {
  test('reports no importable rows after the last valid row is removed', () => {
    assert.deepEqual(businessBatchIdleStatus({
      pendingCount: 0,
      invalidCount: 3,
    }), {
      text: 'לא נמצאו שורות שניתן לייבא. תקנו את רשימת השגיאות והעלו שוב.',
      error: true,
    });
  });

  test('rebuilds the ready summary from the currently active rows', () => {
    assert.deepEqual(businessBatchIdleStatus({
      pendingCount: 1,
      invalidCount: 3,
    }), {
      text: 'מוכנים לייבוא 1 שורות. 3 שורות מופיעות בנפרד לתיקון.',
      error: false,
    });
  });
});

describe('business account dashboard', () => {
  const html = businessAccountHtml('https://edenmish.example');

  test('uses the canonical storefront navigation and responsive login artwork', () => {
    assert.match(html, /data-eden-site-nav data-storefront-origin="https:\/\/edenmish\.example"/);
    assert.match(html, /https:\/\/edenmish\.example\/assets\/mobile-nav\.js/);
    assert.match(html, /edenmish-business-login-bg-desktop\.webp/);
    assert.match(html, /edenmish-business-login-bg-mobile\.webp/);
    assert.match(html, /id="auth-backdrop"/);
    assert.match(html, /auth-backdrop'\)\.classList\.add\('hidden'\)/);
  });

  test('renders all five approved programs as account top-ups with their real artwork', () => {
    assert.match(html, /trial:'חבילת ניסיון'/);
    assert.match(html, /wallet:'ארנק עסקי'/);
    assert.match(html, /silver:'Silver · כסף'/);
    assert.match(html, /gold:'Gold · זהב'/);
    assert.match(html, /platinum:'Platinum · פלטינום'/);
    assert.match(html, /trial:'שליח על אופנוע מתחיל מסלול משלוח באזור עירוני'/);
    assert.match(html, /wallet:'ארנק דיגיטלי מחבר רשת של שליחים על אופנועים'/);
    assert.match(html, /function planArt\(id\)\{return STOREFRONT\+'\/assets\/business-'\+\(planNames\[id\]\?id:'wallet'\)\+'\.webp'\}/);
    assert.ok(html.includes("'/assets/business-'"));
    assert.ok(html.includes("+'.webp'"));
    assert.match(html, /מסלולי התחלה בחשבון/);
    assert.match(html, /entry-plan-cards/);
    assert.doesNotMatch(html, /data-assist|openAssistedProgram/);
    assert.match(html, /data-plan=/);
    assert.match(html, /trial_already_used/);
  });

  test('keeps operational content ahead of collapsed plan and profile details', () => {
    assert.ok(html.indexOf('משלוחים אחרונים') < html.indexOf('השוואה ושינוי תוכנית'));
    assert.ok(html.indexOf('פעילות בארנק') < html.indexOf('פרטי העסק'));
    assert.match(html, /<details id="batch-import"/);
    assert.match(html, /<details id="programs"/);
    assert.match(html, /<details id="business-details"/);
    assert.match(html, /id="login-email"[^>]*readonly/);
    assert.match(html, /profileDirty\.has\('company'\)/);
    assert.match(html, /profileDirty\.add\(input\.id\)/);
    assert.match(html, /businessProfilePatch\(values,dirty\)/);
    assert.match(html, /createLatestBusinessSnapshotRefresher/);
    assert.doesNotMatch(html, /\b__name\s*\(/);
  });

  test('makes the active identity explicit and offers a safe account switch', () => {
    assert.match(html, /aria-label="החשבון המחובר"/);
    assert.match(html, /id="session-email"/);
    assert.match(html, /מחוברים כעת/);
    assert.match(html, /הכניסה נשמרת במכשיר זה עד 3 ימים/);
    assert.match(html, /id="switch-account"[^>]*data-business-logout/);
    assert.match(html, /החלפת חשבון/);
    assert.match(html, /\$\('session-email'\)\.textContent=s\.user\.email\|\|''/);
    assert.match(html, /document\.querySelectorAll\('\[data-business-logout\]'\)\.forEach/);
    assert.match(html, /api\('\/api\/business\/logout'/);
  });

  test('opens Shopify separately and exposes pending, paid, and review states', () => {
    assert.match(html, /window\.open\('about:blank','_blank'\)/);
    assert.match(html, /status==='checkout_ready'/);
    assert.match(html, /status==='paid'/);
    assert.match(html, /status==='mismatch'/);
    assert.match(html, /אל תשלמו שוב/);
    assert.match(html, /setInterval\(.*6000/);
    assert.match(html, /function selectRelevantBusinessTopup\(/);
    assert.match(html, /return selectRelevantBusinessTopup\(snapshot\.topups,activeTopupId\(\)/);
  });

  test('offers a business-plan coupon field and sends it with the selected plan', () => {
    assert.match(html, /id="business-coupon"/);
    assert.match(html, /קוד קופון למסלול עסקי/);
    assert.match(html, /coupon_code:couponCode\|\|undefined/);
    assert.match(html, /error\.message==='invalid_coupon'/);
    assert.match(html, /ההנחה תוצג ב־Shopify/);
  });

  test('offers a template-driven batch import without bypassing the order API', () => {
    assert.match(html, /downloads\/edenmish-business-batch-template\.xlsx/);
    assert.match(html, /accept="\.xlsx,\.csv/);
    assert.match(html, /\/api\/business\/batches\/parse/);
    assert.match(html, /api\('\/api\/business\/quote'/);
    assert.match(html, /api\('\/api\/orders'/);
    assert.match(html, /'Idempotency-Key':row\.idempotency_key/);
    assert.match(html, /\/api\/business\/batches\/approve/);
    assert.match(html, /batch_row_token:row\.batch_token/);
    assert.match(html, /batch_pickup_token:settings\.pickup\.batch_token/);
    assert.match(html, /expected_price:row\.price/);
    assert.match(html, /phone_delivery_link_opt_in:false/);
    assert.match(html, /when_date:row\.pickup_date/);
    assert.match(html, /when_hour:row\.pickup_hour/);
    assert.match(html, /size:row\.package_size/);
    assert.doesNotMatch(html, /id="batch-size"/);
    assert.match(html, /id="batch-approve-corrections"/);
    assert.match(html, /correctionsApproved:correctionCount===0/);
    assert.match(html, /!batchState\.correctionsApproved/);
    assert.match(html, /אישור התיקונים/);
    assert.match(html, /גודל החבילה חייב להיות קטן או בינוני/);
    assert.match(html, /לא נמצאה התאמה בטוחה לרחוב ולמספר הבית/);
    assert.match(html, /batchCorrectionLabels=\{external_id:'מזהה משלוח'/);
    assert.match(html, /delivery_street:'שם רחוב מסירה'/);
    assert.match(html, /pickup_street:'שם רחוב איסוף'/);
    assert.match(html, /missing_delivery_house_number:'חסר מספר בית למסירה'/);
    assert.match(html, /missing_external_id:'חסר מזהה משלוח'/);
    assert.match(html, /id="batch-pickup-street"/);
    assert.match(html, /id="batch-pickup-house-number"/);
    assert.match(html, /correction\.source==='google_maps'/);
    assert.match(html, /translate="no">Google Maps/);
    assert.match(html, /translate="no">Cloudflare Workers AI/);
    assert.match(html, /data\.import_mode==='ai_assisted'/);
    assert.match(html, /ai_low_confidence:'המסייע החכם לא הצליח/);
    assert.match(html, /תוכן שורות מוגבל נשלח ל־Cloudflare Workers AI/);
    assert.match(html, /id="batch-download-errors"/);
    assert.match(html, /edenmish-batch-errors-/);
    assert.match(html, /new Blob\(\[csv\],\{type:'text\/csv;charset=utf-8'\}\)/);
    assert.match(html, /function batchCsvCell\(value\).*text='\\t'\+text/);
    assert.match(html, /data\.import_mode==='saved_mapping'/);
    assert.match(html, /approved\.mapping_saved/);
    assert.match(html, /id="batch-mappings"/);
    assert.match(html, /מיפויי קבצים שמורים/);
    assert.match(html, /api\('\/api\/business\/batch-mappings'\)/);
    assert.match(html, /api\('\/api\/business\/batch-mappings\/'\+mappingId,\{method:'DELETE'\}\)/);
    assert.match(html, /data-delete-batch-mapping/);
    assert.match(html, /לא תמחק משלוחים, קבצים או קרדיט/);
    assert.match(html, /batchMappingsLoaded=false/);
    assert.match(html, /ממתין לאישור תיקון/);
    assert.match(html, /batchScheduleError/);
    assert.match(html, /external_id:row\.external_id/);
    assert.match(html, /אין איסוף בשבת/);
    assert.match(html, /עד 100 שורות/);
    assert.match(html, /id="batch-exceptions"/);
    assert.match(html, /שורות שלא ניתן לייבא/);
    assert.match(html, /id="batch-new"/);
    assert.match(html, /id="batch-updates"/);
    assert.match(html, /id="batch-unchanged"/);
    assert.match(html, /id="batch-total-label">שינוי מרבי בקרדיט/);
    assert.match(html, /id="batch-balance-label">יתרה מינימלית לאחר הייבוא/);
    assert.match(html, /batchState\.completed\?'שינוי בפועל בקרדיט':'שינוי מרבי בקרדיט'/);
    assert.match(html, /batchState\.completed\?'יתרה נוכחית':'יתרה מינימלית לאחר הייבוא'/);
    assert.match(html, /המחיר שנבדק הוא תקרת החיוב המאושרת/);
    assert.match(html, /מבצע אוטומטי עשוי להקטין את החיוב בפועל/);
    assert.match(html, /רכישת קרדיט נוסף/);
    assert.match(html, /data-batch-remove/);
    assert.match(html, /businessBatchIdleStatus\(\{pickupErrors:pickup\.errors\|\|\[\]/);
    assert.match(html, /if\(!batchState\.running&&!batchState\.completed\)/);
    assert.match(html, /result\.updated\?'updated'/);
    assert.match(html, /data-cancel-business-order/);
    assert.match(html, /id="cancel-order-dialog"[^>]*aria-labelledby="cancel-order-title"/);
    assert.match(html, /id="cancel-order-confirm"[^>]*>ביטול ושחרור קרדיט/);
    assert.match(html, /showModal\(\)/);
    assert.match(html, /openCancelBusinessOrder\(Number\(button\.dataset\.cancelBusinessOrder\),button\)/);
    assert.match(html, /api\('\/api\/business\/orders\/'\+pending\.orderId,\{method:'DELETE'\}\)/);
    assert.doesNotMatch(html, /confirm\('לבטל את המשלוח/);
    assert.match(html, /לא ייווצרו כפילויות/);
  });

  test('cleans one-time login tokens from the address even after verification errors', () => {
    assert.match(html, /finally\{history\.replaceState\(\{\},'',location\.pathname\+\(selectedPlanId/);
  });
});
