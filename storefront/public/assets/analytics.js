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
  var GA4_EVENTS = {
    booking_started: "booking_started",
    booking_submitted: "generate_lead",
    payment_started: "begin_checkout",
    tracking_opened: "tracking_opened",
    whatsapp_clicked: "contact",
    cancellation_submitted: "cancellation_submitted"
  };
  var META_EVENTS = {
    booking_submitted: "Lead",
    payment_started: "InitiateCheckout",
    whatsapp_clicked: "Contact"
  };

  var config = { ga4MeasurementId: "", metaPixelId: "" };
  var configLoaded = false;
  var providersReady = false;
  var consent = readConsent();

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

  function hasProviders() {
    return Boolean(config.ga4MeasurementId || config.metaPixelId);
  }

  function safeParams(input) {
    var output = { page_path: window.location.pathname || "/" };
    Object.keys(input || {}).forEach(function (key) {
      if (!ALLOWED_PARAMS.has(key)) return;
      var value = input[key];
      if (typeof value === "string") output[key] = value.slice(0, 40);
      else if (typeof value === "number" && Number.isFinite(value)) output[key] = value;
      else if (typeof value === "boolean") output[key] = value;
    });
    return output;
  }

  function loadGoogle(measurementId) {
    window.dataLayer = window.dataLayer || [];
    window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
    window.gtag("consent", "default", {
      analytics_storage: "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
    window.gtag("consent", "update", {
      analytics_storage: "granted",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
    window.gtag("js", new Date());
    window.gtag("config", measurementId, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      send_page_view: true
    });
    var script = document.createElement("script");
    script.async = true;
    script.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(measurementId);
    document.head.appendChild(script);
  }

  function loadMeta(pixelId) {
    if (window.fbq) return;
    var fbq = window.fbq = function () {
      fbq.callMethod ? fbq.callMethod.apply(fbq, arguments) : fbq.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = fbq;
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = "2.0";
    fbq.queue = [];
    fbq("consent", "grant");
    fbq("init", pixelId);
    fbq("track", "PageView");
    var script = document.createElement("script");
    script.async = true;
    script.src = "https://connect.facebook.net/en_US/fbevents.js";
    document.head.appendChild(script);
  }

  function dispatch(name, params) {
    var clean = safeParams(params);
    if (config.ga4MeasurementId && window.gtag) {
      if (name === "payment_started") clean.transport_type = "beacon";
      window.gtag("event", GA4_EVENTS[name] || name, clean);
    }
    if (config.metaPixelId && window.fbq) {
      var standardName = META_EVENTS[name];
      window.fbq(standardName ? "track" : "trackCustom", standardName || name, clean);
    }
  }

  function track(name, params) {
    if (!ALLOWED_EVENTS.has(name) || consent !== "granted" || !providersReady) return false;
    dispatch(name, params);
    return true;
  }

  function initializeProviders() {
    if (providersReady || consent !== "granted" || !hasProviders()) return;
    if (config.ga4MeasurementId) loadGoogle(config.ga4MeasurementId);
    if (config.metaPixelId) loadMeta(config.metaPixelId);
    providersReady = true;
    if (/\/booking(?:\.html)?$/.test(window.location.pathname)) track("booking_started", { source: "booking_page" });
  }

  function removeBanner() {
    var banner = document.getElementById("eden-analytics-consent");
    if (banner) banner.remove();
  }

  function updateProviderConsent(value) {
    var granted = value === "granted";
    if (window.gtag) window.gtag("consent", "update", {
      analytics_storage: granted ? "granted" : "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
    if (window.fbq) window.fbq("consent", granted ? "grant" : "revoke");
  }

  function setConsent(value) {
    consent = value === "granted" ? "granted" : "denied";
    writeConsent(consent);
    removeBanner();
    if (consent === "granted") {
      if (providersReady) updateProviderConsent("granted");
      else initializeProviders();
    } else {
      updateProviderConsent("denied");
    }
  }

  function renderBanner() {
    if (!hasProviders() || document.getElementById("eden-analytics-consent")) return;
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
    if (configLoaded && hasProviders()) renderBanner();
  }

  async function loadConfig() {
    try {
      var response = await fetch("/analytics-config", { credentials: "same-origin" });
      if (!response.ok) return;
      var data = await response.json();
      config.ga4MeasurementId = /^G-[A-Z0-9]+$/.test(data.ga4MeasurementId || "") ? data.ga4MeasurementId : "";
      config.metaPixelId = /^\d{5,20}$/.test(data.metaPixelId || "") ? data.metaPixelId : "";
    } catch (_) {
      config = { ga4MeasurementId: "", metaPixelId: "" };
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
    if (!hasProviders()) return;
    document.querySelectorAll("[data-analytics-settings]").forEach(function (button) { button.hidden = false; });
    if (consent === "granted") initializeProviders();
    else if (consent === "unknown") renderBanner();
  });
})();
