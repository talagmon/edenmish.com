import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { businessAccountHtml } from '../src/business-page.js';

describe('business account dashboard', () => {
  const html = businessAccountHtml('https://edenmish.example');

  test('renders all five approved programs with their real artwork', () => {
    for (const asset of ['business-trial.webp', 'business-wallet.webp']) {
      assert.match(html, new RegExp(asset.replace('.', '\\.')));
    }
    assert.match(html, /silver:'Silver · כסף'/);
    assert.match(html, /gold:'Gold · זהב'/);
    assert.match(html, /platinum:'Platinum · פלטינום'/);
    assert.ok(html.includes("'/assets/business-'"));
    assert.ok(html.includes("+'.webp'"));
    assert.match(html, /תוכניות בליווי אישי/);
    assert.match(html, /מסלולי חשבון וטעינת יתרה/);
  });

  test('keeps operational content ahead of collapsed plan and profile details', () => {
    assert.ok(html.indexOf('משלוחים אחרונים') < html.indexOf('השוואה ושינוי תוכנית'));
    assert.ok(html.indexOf('פעילות בארנק') < html.indexOf('פרטי העסק'));
    assert.match(html, /<details id="programs"/);
    assert.match(html, /<details id="business-details"/);
    assert.match(html, /id="login-email"[^>]*readonly/);
  });

  test('opens Shopify separately and exposes pending, paid, and review states', () => {
    assert.match(html, /window\.open\('about:blank','_blank'\)/);
    assert.match(html, /status==='checkout_ready'/);
    assert.match(html, /status==='paid'/);
    assert.match(html, /status==='mismatch'/);
    assert.match(html, /אל תשלמו שוב/);
    assert.match(html, /setInterval\(.*6000/);
  });

  test('cleans one-time login tokens from the address even after verification errors', () => {
    assert.match(html, /finally\{history\.replaceState\(\{\},'',location\.pathname\)\}/);
  });
});
