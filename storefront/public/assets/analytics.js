(function () {
  "use strict";

  var CONSENT_KEY = "edenmish_analytics_consent_v2";
  var LEGACY_CONSENT_KEY = "edenmish_analytics_consent_v1";
  var CONVERSION_KEY = "edenmish_paid_conversion_v1";
  var CONVERSION_MAX_ATTEMPTS = 30;
  var PROVIDERS = ["googleAnalytics", "metaPixel"];
  var ALLOWED_EVENTS = new Set([
    "booking_started",
    "booking_submitted",
    "payment_started",
    "paid_order",
    "tracking_opened",
    "whatsapp_clicked",
    "cancellation_submitted"
  ]);
  var SAFE_SERVICE = new Set(["standard", "eco", "flash"]);
  var SAFE_SIZE = new Set(["small", "medium"]);
  var SAFE_SOURCE = /^(?:booking_page|\/(?:[a-z0-9-]+(?:\.html)?)?)$/;

  var config = {
    gtmContainerId: "",
    providers: { googleAnalytics: false, metaPixel: false },
    paidConversionEnabled: false
  };
  var configLoaded = false;
  var containerReady = false;
  var consent = readConsent();
  var lastFocus = null;
  var configPromise;

  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
  updateGoogleConsent("default");
  updateMetaConsent();

  function blankConsent(value) {
    return {
      googleAnalytics: value || "unknown",
      metaPixel: value || "unknown"
    };
  }

  function validConsentValue(value) {
    return value === "granted" || value === "denied" || value === "unknown";
  }

  function readConsent() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(CONSENT_KEY) || "null");
      if (parsed && PROVIDERS.every(function (provider) {
        return validConsentValue(parsed[provider]);
      })) {
        return {
          googleAnalytics: parsed.googleAnalytics,
          metaPixel: parsed.metaPixel
        };
      }
      // A previous refusal remains a refusal. A previous broad grant is not
      // migrated because it did not identify the enabled providers.
      if (window.localStorage.getItem(LEGACY_CONSENT_KEY) === "denied") {
        return blankConsent("denied");
      }
    } catch (_) {}
    return blankConsent("unknown");
  }

  function writeConsent() {
    try { window.localStorage.setItem(CONSENT_KEY, JSON.stringify(consent)); } catch (_) {}
  }

  function configured(provider) {
    return Boolean(config.gtmContainerId && config.providers[provider]);
  }

  function configuredProviders() {
    return PROVIDERS.filter(configured);
  }

  function providerGranted(provider) {
    return configured(provider) && consent[provider] === "granted";
  }

  function canMeasure() {
    return configuredProviders().some(providerGranted) && !sensitiveContext();
  }

  function safePath() {
    var path = String(window.location.pathname || "/");
    return /^\/(?:[a-z0-9-]+(?:\.html)?)?$/.test(path) ? path : "/";
  }

  function sensitiveContext() {
    if (window.location.search || window.location.hash) return true;
    var referrer = String(document.referrer || "");
    if (!referrer) return false;
    try {
      var referrerUrl = new URL(referrer, window.location.origin);
      return Boolean(
        referrerUrl.search ||
        referrerUrl.hash ||
        /\/(?:track|business)(?:\.html)?$/i.test(referrerUrl.pathname)
      );
    } catch (_) {
      return /[?#]/.test(referrer);
    }
  }

  function safeParams(input) {
    var output = { eden_page_path: safePath() };
    var value;
    if (input && SAFE_SERVICE.has(input.service)) output.eden_service = input.service;
    if (input && SAFE_SIZE.has(input.size)) output.eden_size = input.size;
    if (input && typeof input.review === "boolean") output.eden_review = input.review;
    if (input && input.currency === "ILS") output.eden_currency = "ILS";
    value = input && input.value;
    if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000000) {
      output.eden_value = value;
    }
    if (input && typeof input.source === "string" && SAFE_SOURCE.test(input.source)) {
      output.eden_source = input.source;
    }
    return output;
  }

  function updateGoogleConsent(command) {
    var granted = providerGranted("googleAnalytics");
    window.gtag("consent", command, {
      analytics_storage: granted ? "granted" : "denied",
      ad_storage: "denied",
      ad_user_data: "denied",
      ad_personalization: "denied"
    });
  }

  function updateMetaConsent() {
    window.dataLayer.push({
      event: "eden_provider_consent",
      eden_meta_consent: providerGranted("metaPixel") ? "granted" : "denied"
    });
  }

  function dispatch(name, params) {
    var clean = safeParams(params);
    clean.event = "eden_" + name;
    window.dataLayer.push(clean);
  }

  function track(name, params) {
    if (!ALLOWED_EVENTS.has(name) || !containerReady || !canMeasure()) return false;
    dispatch(name, params);
    return true;
  }

  function initializeContainer() {
    if (containerReady || !canMeasure()) return;
    updateGoogleConsent("update");
    updateMetaConsent();
    window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
    var script = document.createElement("script");
    script.async = true;
    script.dataset.edenAnalyticsScript = "1";
    script.referrerPolicy = "no-referrer";
    script.src = "https://www.googletagmanager.com/gtm.js?id=" +
      encodeURIComponent(config.gtmContainerId);
    document.head.appendChild(script);
    containerReady = true;
    if (/\/booking(?:\.html)?$/.test(safePath())) {
      track("booking_started", { source: "booking_page" });
    }
  }

  function removeDialog() {
    var dialog = document.getElementById("eden-analytics-consent");
    if (dialog) dialog.remove();
    document.removeEventListener("keydown", handleDialogKeydown);
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    lastFocus = null;
  }

  function clearCookie(name) {
    var expires = "Thu, 01 Jan 1970 00:00:00 GMT";
    document.cookie = name + "=; expires=" + expires + "; path=/; SameSite=Lax";
    document.cookie = name + "=; expires=" + expires + "; path=/; domain=.edenmish.com; SameSite=Lax";
  }

  function providerCookie(provider, name) {
    if (provider === "googleAnalytics") {
      return /^_(?:ga(?:_|$)|gid$|gat|gac_|gcl_)/.test(name);
    }
    return provider === "metaPixel" && (name === "_fbp" || name === "_fbc");
  }

  function clearProviderData(provider) {
    try {
      String(document.cookie || "").split(";").forEach(function (entry) {
        var name = entry.split("=")[0].trim();
        if (providerCookie(provider, name)) clearCookie(name);
      });
    } catch (_) {}
    [window.localStorage, window.sessionStorage].forEach(function (storage) {
      try {
        Object.keys(storage).forEach(function (key) {
          var googleKey = /^_(?:ga|gid|gat|gac|gcl)/.test(key);
          var metaKey = /^_(?:fbp|fbc)$/.test(key);
          if (
            (provider === "googleAnalytics" && googleKey) ||
            (provider === "metaPixel" && metaKey)
          ) storage.removeItem(key);
        });
      } catch (_) {}
    });
  }

  function clearConversionContext() {
    try { window.sessionStorage.removeItem(CONVERSION_KEY); } catch (_) {}
  }

  function terminateLoadedContainer() {
    document.querySelectorAll("[data-eden-analytics-script]").forEach(function (script) {
      script.remove();
    });
    if (!containerReady) return;
    containerReady = false;
    window.setTimeout(function () { window.location.reload(); }, 0);
  }

  function applyConsent(next, persist) {
    var previous = consent;
    consent = {
      googleAnalytics: validConsentValue(next.googleAnalytics) ? next.googleAnalytics : "denied",
      metaPixel: validConsentValue(next.metaPixel) ? next.metaPixel : "denied"
    };
    if (persist) writeConsent();

    updateGoogleConsent("update");
    updateMetaConsent();
    window.dataLayer.push({
      event: "eden_consent_updated",
      eden_google_analytics_consent: consent.googleAnalytics,
      eden_meta_pixel_consent: consent.metaPixel
    });

    PROVIDERS.forEach(function (provider) {
      if (consent[provider] !== "granted") clearProviderData(provider);
    });
    if (!PROVIDERS.some(function (provider) { return consent[provider] === "granted"; })) {
      clearConversionContext();
    }
    removeDialog();

    var changed = PROVIDERS.some(function (provider) {
      return previous[provider] !== consent[provider];
    });
    if (containerReady && changed) terminateLoadedContainer();
    else initializeContainer();
  }

  function providerLabel(provider) {
    return provider === "googleAnalytics" ? "Google Analytics" : "Meta Pixel";
  }

  function handleDialogKeydown(event) {
    if (event.key === "Escape") removeDialog();
  }

  function renderDialog() {
    removeDialog();
    var providers = configuredProviders();
    // With no enabled measurement provider there is no customer choice to make.
    // Keep internal configuration state out of the customer-facing UI.
    if (!providers.length) return;
    lastFocus = document.activeElement;
    var dialog = document.createElement("section");
    dialog.id = "eden-analytics-consent";
    dialog.dir = "rtl";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "eden-consent-title");
    dialog.style.cssText = "position:fixed;inset:auto 1rem 1rem;z-index:100;margin:auto;max-width:48rem;padding:1.25rem;border:1px solid rgba(209,218,255,.22);border-radius:1rem;background:#171b36;color:#f6f2fb;box-shadow:0 24px 70px rgba(0,0,0,.55);font-family:inherit";

    var names = providers.map(providerLabel).join(" ו־");
    var choices = providers.map(function (provider) {
      var checked = consent[provider] === "granted" ? " checked" : "";
      return '<label style="display:flex;align-items:flex-start;gap:.7rem;margin:.7rem 0;line-height:1.5">' +
        '<input data-eden-provider="' + provider + '" type="checkbox"' + checked + ' style="margin-top:.25rem;width:1.1rem;height:1.1rem">' +
        '<span><strong>' + providerLabel(provider) + '</strong> — מדידת שימוש ושיפור השירות</span></label>';
    }).join("");
    dialog.innerHTML =
      '<h2 id="eden-consent-title" style="margin:0;color:#dfb7ff;font-size:1.25rem">בחירת פרטיות</h2>' +
      '<p style="margin:.7rem 0;line-height:1.6;color:#d7d1df">רק בהסכמתכם נטען את ' + names + '. לא נשלח שמות, טלפונים, כתובות, מספרי הזמנה או מזהי מעקב.</p>' +
      '<div style="margin:.8rem 0">' + choices + '</div>' +
      '<p style="margin:.65rem 0;font-size:.88rem"><a style="color:#91d3c8;text-decoration:underline" href="/privacy.html">מידע נוסף במדיניות הפרטיות</a></p>' +
      '<div style="display:flex;flex-wrap:wrap;gap:.7rem;justify-content:flex-end;margin-top:1rem">' +
        '<button id="eden-consent-essential" type="button" style="min-height:2.75rem;padding:.65rem 1rem;border:1px solid #91d3c8;border-radius:.75rem;background:transparent;color:#fff;font:inherit;font-weight:700">רק חיוניות</button>' +
        '<button id="eden-consent-save" type="button" style="min-height:2.75rem;padding:.65rem 1rem;border:0;border-radius:.75rem;background:#dfb7ff;color:#241133;font:inherit;font-weight:800">שמירת בחירה</button>' +
      '</div>';
    document.body.appendChild(dialog);
    document.getElementById("eden-consent-essential").addEventListener("click", function () {
      applyConsent(blankConsent("denied"), true);
    });
    document.getElementById("eden-consent-save").addEventListener("click", function () {
      var next = blankConsent("denied");
      providers.forEach(function (provider) {
        var input = dialog.querySelector('[data-eden-provider="' + provider + '"]');
        next[provider] = input && input.checked ? "granted" : "denied";
      });
      applyConsent(next, true);
    });
    document.getElementById("eden-consent-save").focus();
    document.addEventListener("keydown", handleDialogKeydown);
  }

  function ensurePreferencesControl() {
    var controls = document.querySelectorAll("[data-analytics-settings]");
    var hasProviders = configuredProviders().length > 0;
    controls.forEach(function (button) { button.hidden = !hasProviders; });
    if (!hasProviders || controls.length) return;
    var button = document.createElement("button");
    button.type = "button";
    button.dataset.analyticsSettings = "1";
    button.textContent = "העדפות פרטיות";
    button.setAttribute("aria-label", "פתיחת העדפות פרטיות");
    button.style.cssText = "position:fixed;left:1rem;bottom:1rem;z-index:80;min-height:2.5rem;padding:.55rem .8rem;border:1px solid rgba(145,211,200,.55);border-radius:999px;background:#171b36;color:#f6f2fb;font:inherit;font-size:.8rem;font-weight:700;box-shadow:0 8px 28px rgba(0,0,0,.35)";
    document.body.appendChild(button);
  }

  function openPreferences() {
    if (configLoaded) renderDialog();
    else if (configPromise) configPromise.then(renderDialog);
  }

  function randomClaim() {
    if (!window.crypto || typeof window.crypto.getRandomValues !== "function") return null;
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes).map(function (value) {
      return value.toString(16).padStart(2, "0");
    }).join("");
  }

  function getConversionContext() {
    if (
      !configLoaded ||
      !config.paidConversionEnabled ||
      !containerReady ||
      !canMeasure()
    ) return null;
    try {
      var existing = window.sessionStorage.getItem(CONVERSION_KEY);
      if (/^[a-f0-9]{32}$/.test(existing || "")) return existing;
      var created = randomClaim();
      if (!created) return null;
      window.sessionStorage.setItem(CONVERSION_KEY, created);
      return created;
    } catch (_) {
      return null;
    }
  }

  function finalizeConversionContext(registered) {
    if (!registered) clearConversionContext();
  }

  function conversionRetryDelay(attempt) {
    return Math.min(1000 * (attempt + 1), 10000);
  }

  function scheduleConversionRetry(attempt) {
    if (attempt + 1 >= CONVERSION_MAX_ATTEMPTS) return false;
    window.setTimeout(function () {
      observePaidConversion(attempt + 1);
    }, conversionRetryDelay(attempt));
    return true;
  }

  async function observePaidConversion(attempt) {
    if (!/\/thank-you(?:\.html)?$/.test(safePath())) return;
    if (!config.paidConversionEnabled) {
      clearConversionContext();
      return;
    }
    var credential;
    try { credential = window.sessionStorage.getItem(CONVERSION_KEY); } catch (_) {}
    if (!/^[a-f0-9]{32}$/.test(credential || "")) return;

    var eligible = Boolean(containerReady && canMeasure());
    try {
      var api = window.EDEN_API && window.EDEN_API.find;
      if (!api) {
        if (!eligible) clearConversionContext();
        return;
      }
      var response = await fetch(api + "/api/analytics/paid-conversion", {
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credential: credential, eligible: eligible })
      });
      var retryable = response.status === 202 ||
        response.status === 429 ||
        response.status >= 500;
      if (retryable && eligible && scheduleConversionRetry(attempt)) {
        return;
      }
      if (response.ok && response.status === 200) {
        var event = await response.json();
        if (
          event &&
          event.event === "paid_order" &&
          event.currency === "ILS" &&
          typeof event.value === "number" &&
          Number.isFinite(event.value)
        ) {
          track("paid_order", { currency: "ILS", value: event.value });
        }
      }
      if (!retryable) clearConversionContext();
    } catch (_) {
      // A refusal, missing configuration, or withdrawal must never become a
      // historical conversion after consent changes later.
      if (!eligible) clearConversionContext();
      else scheduleConversionRetry(attempt);
    }
  }

  async function loadConfig() {
    try {
      var response = await fetch("/analytics-config", {
        credentials: "same-origin",
        referrerPolicy: "no-referrer"
      });
      if (!response.ok) return;
      var data = await response.json();
      var id = /^GTM-[A-Z0-9]+$/.test(data.gtmContainerId || "") ? data.gtmContainerId : "";
      config = {
        gtmContainerId: id,
        providers: {
          googleAnalytics: Boolean(id && data.providers && data.providers.googleAnalytics === true),
          metaPixel: Boolean(id && data.providers && data.providers.metaPixel === true)
        },
        paidConversionEnabled: Boolean(id && data.paidConversionEnabled === true)
      };
    } catch (_) {
      config = {
        gtmContainerId: "",
        providers: { googleAnalytics: false, metaPixel: false },
        paidConversionEnabled: false
      };
    } finally {
      configLoaded = true;
    }
  }

  document.addEventListener("click", function (event) {
    var target = event.target;
    if (!target || typeof target.closest !== "function") return;
    var settings = target.closest("[data-analytics-settings]");
    if (settings) {
      event.preventDefault();
      openPreferences();
      return;
    }
    var link = target.closest("a[href]");
    if (!link) return;
    try {
      var url = new URL(link.href, window.location.href);
      if (url.hostname === "wa.me" || url.hostname === "api.whatsapp.com") {
        track("whatsapp_clicked", { source: safePath() });
      }
    } catch (_) {}
  }, true);

  window.addEventListener("storage", function (event) {
    if (event.key !== CONSENT_KEY) return;
    var next = readConsent();
    var changed = PROVIDERS.some(function (provider) {
      return next[provider] !== consent[provider];
    });
    if (!changed) return;
    applyConsent(next, false);
  });

  window.edenAnalytics = Object.freeze({
    track: track,
    getConsent: function () {
      return {
        googleAnalytics: consent.googleAnalytics,
        metaPixel: consent.metaPixel
      };
    },
    openPreferences: openPreferences,
    getConversionContext: getConversionContext,
    finalizeConversionContext: finalizeConversionContext,
    ready: function () { return configPromise; }
  });

  configPromise = loadConfig().then(function () {
    var providers = configuredProviders();
    ensurePreferencesControl();
    if (providers.some(function (provider) { return consent[provider] === "granted"; })) {
      initializeContainer();
    } else if (providers.some(function (provider) { return consent[provider] === "unknown"; })) {
      renderDialog();
    }
    return observePaidConversion(0);
  });
})();
