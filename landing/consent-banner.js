/**
 * Consent Banner for Bear Landing Page
 *
 * Manages user consent for:
 * - Google Fonts (external font loading)
 * - Analytics (Umami or similar tracking)
 *
 * Persists choice in localStorage for 365 days.
 * Loads external resources only after explicit consent.
 */

const CONSENT_KEY = "bear-consent";
const CONSENT_EXPIRY_DAYS = 365;

/**
 * Parse consent from localStorage
 */
function getConsentChoice() {
  const stored = localStorage.getItem(CONSENT_KEY);
  if (!stored) return null;

  try {
    const parsed = JSON.parse(stored);
    const expiryDate = new Date(parsed.expiryDate);
    if (expiryDate > new Date()) {
      return parsed.choice;
    }
  } catch (e) {
    // Malformed or missing — treat as no consent
  }

  // Expired or invalid — remove and treat as no choice
  localStorage.removeItem(CONSENT_KEY);
  return null;
}

/**
 * Save consent choice to localStorage with expiry
 */
function saveConsentChoice(choice) {
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + CONSENT_EXPIRY_DAYS);

  localStorage.setItem(
    CONSENT_KEY,
    JSON.stringify({
      choice, // "accept" or "reject"
      timestamp: new Date().toISOString(),
      expiryDate: expiryDate.toISOString(),
    }),
  );
}

/**
 * Load external fonts (Google Fonts)
 */
function loadExternalFonts() {
  const fontLink = document.createElement("link");
  fontLink.rel = "stylesheet";
  fontLink.href =
    "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap";
  fontLink.onload = () => {
    document.documentElement.classList.add("fonts-loaded");
  };
  document.head.appendChild(fontLink);
}

/**
 * Load analytics (Umami — privacy-friendly, no cookies)
 *
 * Configure by setting the two env-style vars below, or by adding a
 * <meta name="umami-website-id"> and <meta name="umami-script-url"> tag
 * to the page <head>.  When neither is present analytics are silently skipped.
 *
 * Umami Cloud:  https://umami.is  — create an account, add a website, copy the
 *   website ID from the tracking snippet.
 * Self-hosted:  point script-url to your own Umami instance.
 */
function loadAnalytics() {
  const websiteId = document.querySelector('meta[name="umami-website-id"]')?.content?.trim() || ""; // <-- paste your Umami website ID here
  const scriptUrl =
    document.querySelector('meta[name="umami-script-url"]')?.content?.trim() ||
    "https://analytics.umami.is/script.js";

  if (!websiteId) return; // no ID configured — skip silently

  const script = document.createElement("script");
  script.defer = true;
  script.async = true;
  script.src = `${scriptUrl}`;
  script.setAttribute("data-website-id", websiteId);
  document.head.appendChild(script);
}

/**
 * Load all external resources based on consent
 */
function loadExternalResources(choice) {
  if (choice === "accept") {
    loadExternalFonts();
    loadAnalytics();
  }
  // If "reject", external resources are not loaded.
  // Fallback system fonts are used (defined in index.html).
}

/**
 * Show/hide consent banner and wire up event listeners
 */
function initConsentBanner() {
  const banner = document.getElementById("consent-banner");
  const acceptBtn = document.getElementById("consent-accept");
  const rejectBtn = document.getElementById("consent-reject");

  if (!banner || !acceptBtn || !rejectBtn) {
    console.warn("Consent banner elements not found. External resources may not load correctly.");
    return;
  }

  const existingChoice = getConsentChoice();

  if (existingChoice) {
    // User has already made a choice — hide banner and load resources
    banner.style.display = "none";
    loadExternalResources(existingChoice);
  } else {
    // No prior choice — show banner
    banner.style.display = "flex";

    acceptBtn.addEventListener("click", () => {
      saveConsentChoice("accept");
      loadExternalResources("accept");
      banner.style.display = "none";
    });

    rejectBtn.addEventListener("click", () => {
      saveConsentChoice("reject");
      loadExternalResources("reject");
      banner.style.display = "none";
    });
  }
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initConsentBanner);
} else {
  initConsentBanner();
}
