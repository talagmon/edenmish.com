import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { businessAccountHtml, businessProfilePatch, createLatestBusinessSnapshotRefresher, selectRelevantBusinessTopup } from '../src/business-page.js';

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

describe('business account dashboard', () => {
  const html = businessAccountHtml('https://edenmish.example');

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
    assert.match(html, /<details id="programs"/);
    assert.match(html, /<details id="business-details"/);
    assert.match(html, /id="login-email"[^>]*readonly/);
    assert.match(html, /profileDirty\.has\('company'\)/);
    assert.match(html, /profileDirty\.add\(input\.id\)/);
    assert.match(html, /businessProfilePatch\(values,dirty\)/);
    assert.match(html, /createLatestBusinessSnapshotRefresher/);
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

  test('cleans one-time login tokens from the address even after verification errors', () => {
    assert.match(html, /finally\{history\.replaceState\(\{\},'',location\.pathname\+\(selectedPlanId/);
  });
});
