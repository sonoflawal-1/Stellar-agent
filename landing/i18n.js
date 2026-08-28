/**
 * Lightweight client-side i18n for the Bear landing page (issue #259).
 *
 * Walks elements carrying data-i18n="dotted.key" and swaps their textContent
 * for the matching string in the active language's JSON dictionary. English
 * strings already live directly in index.html, so they double as the
 * loading-state fallback — nothing flashes blank while a translation fetch
 * is in flight.
 */
(function () {
  "use strict";

  var SUPPORTED_LANGS = ["en", "es", "fr", "pt"];
  var DEFAULT_LANG = "en";
  var STORAGE_KEY = "bear-lang";

  function detectLang() {
    try {
      var stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored && SUPPORTED_LANGS.indexOf(stored) !== -1) return stored;
    } catch (e) {
      // localStorage unavailable (private mode, disabled cookies) — fall through.
    }
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || DEFAULT_LANG;
    var short = nav.slice(0, 2).toLowerCase();
    return SUPPORTED_LANGS.indexOf(short) !== -1 ? short : DEFAULT_LANG;
  }

  function resolve(dict, dottedKey) {
    var parts = dottedKey.split(".");
    var value = dict;
    for (var i = 0; i < parts.length; i++) {
      if (value == null) return undefined;
      value = value[parts[i]];
    }
    return typeof value === "string" ? value : undefined;
  }

  function applyTranslations(dict) {
    var nodes = document.querySelectorAll("[data-i18n]");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute("data-i18n");
      var value = resolve(dict, key);
      if (value !== undefined) node.textContent = value;
    }

    var attrNodes = document.querySelectorAll("[data-i18n-attr]");
    for (var j = 0; j < attrNodes.length; j++) {
      var attrNode = attrNodes[j];
      // Format: "aria-label:some.key,title:other.key"
      var pairs = attrNode.getAttribute("data-i18n-attr").split(",");
      for (var k = 0; k < pairs.length; k++) {
        var pair = pairs[k].split(":");
        var attrName = pair[0];
        var attrKey = pair[1];
        var attrValue = resolve(dict, attrKey);
        if (attrValue !== undefined) attrNode.setAttribute(attrName, attrValue);
      }
    }
  }

  function loadDict(lang) {
    if (lang === DEFAULT_LANG) return Promise.resolve(null); // HTML already has English text.
    return fetch("i18n/" + lang + ".json")
      .then(function (res) {
        if (!res.ok) throw new Error("failed to load " + lang + ".json: " + res.status);
        return res.json();
      })
      .catch(function (err) {
        console.warn("[i18n] falling back to English:", err);
        return null;
      });
  }

  function setLang(lang, switcher) {
    if (SUPPORTED_LANGS.indexOf(lang) === -1) lang = DEFAULT_LANG;
    document.documentElement.setAttribute("lang", lang);
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch (e) {
      // Ignore — persistence is a nice-to-have, not a requirement.
    }
    if (switcher) switcher.value = lang;
    loadDict(lang).then(function (dict) {
      var resolved = dict || {};
      applyTranslations(resolved);
      if (switcher)
        switcher.setAttribute("aria-label", resolve(resolved, "lang.label") || "Language");
    });
  }

  function buildSwitcher() {
    var container = document.getElementById("lang-switch-container");
    if (!container) return null;

    var select = document.createElement("select");
    select.id = "lang-switch";
    select.className = "lang-switch";
    select.setAttribute("aria-label", "Language");

    var LABELS = { en: "EN", es: "ES", fr: "FR", pt: "PT" };
    for (var i = 0; i < SUPPORTED_LANGS.length; i++) {
      var lang = SUPPORTED_LANGS[i];
      var option = document.createElement("option");
      option.value = lang;
      option.textContent = LABELS[lang] || lang.toUpperCase();
      select.appendChild(option);
    }

    select.addEventListener("change", function () {
      setLang(select.value, select);
    });

    container.appendChild(select);
    return select;
  }

  function init() {
    var switcher = buildSwitcher();
    var lang = detectLang();
    if (switcher) switcher.value = lang;
    setLang(lang, switcher);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
