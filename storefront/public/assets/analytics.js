(function () {
  "use strict";

  var CONSENT_KEY = "edenmish_analytics_consent_v1";
  var ALLOWED_EVENTS = new Set([
    "booking_started",
    "booking_submitted",
    "payment_started",
    "tracking_opened",
    "whatsapp_clicked",
    "cancellation_submitted"
  ]);
  var ALLOWED_PARAMS = new Set(["service", "size", "review", "currency", "value", "source"]);

  var config = { gtmContainerId: "" };
  var configLoaded = false;
  var containerReady = false;
  var consent = readConsent();

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  updateGoogleConsent("default", "denied");

  function readConsent() {
    try {
      var value = window.localStorage.getItem(CONSENT_KEY);
      return value === "granted" || value === "denied" ? value : "unknown";
    } catch (_) {
      return "unknown";
    }
  }

  function writeConsent(value) {
    try { window.localStorage.setItem(CONSENT_KEY, value); } catch (_) {}
  }

  function hasContainer() {
    return Boolean(config.gtmContainerId);
  }

  function safeParams(input) {
    var output = { eden_page_path: window.location.pathname || "/" };
    Object.keys(input || {}).forEach(function (key) {
      if (!ALLOWED_PARAMS.has(key)) return;
      var value = input[key];
      var field = "eden_" + key;
      if (typeof value === "string") output[field] = value.slice(0, 40);
      else if (typeof value === "number" && Number.isFinite(value)) output[field] = value;
      else if (typeof value === "boolean") output[field] = value;
    });
    return output;
  }

  function updateGoogleConsent(command, value) {
    var granted = value === "granted";
    window.gtag("consent", command, {
      analytics_storage: granted ? "granted" : "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
  }

  function dispatch(name, params) {
    var clean = safeParams(params);
    clean.event = "eden_" + name;
    window.dataLayer.push(clean);
  }

  function track(name, params) {
    if (!ALLOWED_EVENTS.has(name) || consent !== "granted" || !containerReady) return false;
    dispatch(name, params);
    return true;
  }

  function initializeContainer() {
    if (containerReady || consent !== "granted" || !hasContainer()) return;
    updateGoogleConsent("update", "granted");
    window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
    var script = document.createElement("script");
    script.async = true;
    script.src = "https://www.googletagmanager.com/gtm.js?id=" + encodeURIComponent(config.gtmContainerId);
    document.head.appendChild(script);
    containerReady = true;
    if (/\/booking(?:\.html)?$/.test(window.location.pathname)) track("booking_started", { source: "booking_page" });
  }

  function removeBanner() {
    var banner = document.getElementById("eden-analytics-consent");
    if (banner) banner.remove();
  }

  function updateContainerConsent(value) {
    updateGoogleConsent("update", value);
    if (containerReady) {
      window.dataLayer.push({ event: "eden_consent_updated", eden_consent: value });
    }
  }

  function setConsent(value) {
    consent = value === "granted" ? "granted" : "denied";
    writeConsent(consent);
    removeBanner();
    if (consent === "granted") {
      if (containerReady) updateContainerConsent("granted");
      else initializeContainer();
    } else {
      updateContainerConsent("denied");
    }
  }

  function renderBanner() {
    if (!hasContainer() || document.getElementById("eden-analytics-consent")) return;
    var banner = document.createElement("section");
    banner.id = "eden-analytics-consent";
    banner.dir = "rtl";
    banner.setAttribute("role", "dialog");
    banner.setAttribute("aria-modal", "false");
    banner.setAttribute("aria-labelledby", "eden-consent-title");
    banner.className = "fixed inset-x-4 bottom-4 z-[100] mx-auto max-w-3xl rounded-2xl border border-glass-border bg-surface-container-high p-5 text-on-surface shadow-2xl";
    banner.innerHTML =
      '<h2 id="eden-consent-title" class="font-headline-md text-primary">בחירת פרטיות</h2>' +
      '<p class="mt-2 text-body-md text-on-surface-variant">בהסכמתכם בלבד נטען כלי מדידה של Google ו‑Meta כדי להבין שימוש באתר ושיפור השירות. לא נשלח אליהם שמות, טלפונים, כתובות, מספרי הזמנה או מזהי מעקב.</p>' +
      '<p class="mt-2 text-label-sm text-on-surface-variant"><a class="text-secondary underline" href="/privacy.html">מידע נוסף במדיניות הפרטיות</a></p>' +
      '<div class="mt-4 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">' +
        '<button id="eden-consent-essential" type="button" class="rounded-xl border border-outline px-5 py-3 font-label-bold text-on-surface hover:bg-white/5">רק חיוניות</button>' +
        '<button id="eden-consent-accept" type="button" class="rounded-xl bg-primary px-5 py-3 font-label-bold text-on-primary hover:opacity-90">אישור מדידה</button>' +
      '</div>';
    document.body.appendChild(banner);
    document.getElementById("eden-consent-essential").addEventListener("click", function () { setConsent("denied"); });
    document.getElementById("eden-consent-accept").addEventListener("click", function () { setConsent("granted"); });
    document.getElementById("eden-consent-accept").focus();
  }

  function openPreferences() {
    if (configLoaded && hasContainer()) renderBanner();
  }

  async function loadConfig() {
    try {
      var response = await fetch("/analytics-config", { credentials: "same-origin" });
      if (!response.ok) return;
      var data = await response.json();
      config.gtmContainerId = /^GTM-[A-Z0-9]+$/.test(data.gtmContainerId || "") ? data.gtmContainerId : "";
    } catch (_) {
      config = { gtmContainerId: "" };
    } finally {
      configLoaded = true;
    }
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var settings = target.closest("[data-analytics-settings]");
    if (settings) { event.preventDefault(); openPreferences(); return; }
    var link = target.closest("a[href]");
    if (!link) return;
    try {
      var url = new URL(link.href, window.location.href);
      if (url.hostname === "wa.me" || url.hostname === "api.whatsapp.com") {
        track("whatsapp_clicked", { source: window.location.pathname || "/" });
      }
    } catch (_) {}
  }, true);

  window.edenAnalytics = Object.freeze({
    track: track,
    getConsent: function () { return consent; },
    openPreferences: openPreferences
  });

  loadConfig().then(function () {
    if (!hasContainer()) return;
    document.querySelectorAll("[data-analytics-settings]").forEach(function (button) { button.hidden = false; });
    if (consent === "granted") initializeContainer();
    else if (consent === "unknown") renderBanner();
  });
})();
