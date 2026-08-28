/**
 * 404 Page JavaScript
 * Handles mobile navigation toggle and dashboard link routing
 */

document.addEventListener("DOMContentLoaded", () => {
  // ── Dashboard link base URL ──
  // Same as landing page: reads from <meta name="marc-dashboard-url">
  const dashboardUrl = document.querySelector('meta[name="marc-dashboard-url"]')?.content?.trim();
  if (dashboardUrl) {
    document.querySelectorAll("[data-dashboard-link]").forEach((link) => {
      link.href = dashboardUrl;
    });
  }

  // ── Mobile hamburger menu ──
  const hamburger = document.getElementById("hamburger");
  const navLinks = document.getElementById("nav-links");
  const nav = document.getElementById("nav");

  if (hamburger && navLinks) {
    hamburger.addEventListener("click", () => {
      const isOpen = hamburger.getAttribute("aria-expanded") === "true";
      hamburger.setAttribute("aria-expanded", !isOpen);
      navLinks.classList.toggle("nav-open");
    });

    // Close menu when a link is clicked
    navLinks.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => {
        hamburger.setAttribute("aria-expanded", "false");
        navLinks.classList.remove("nav-open");
      });
    });

    // Close menu when clicking outside
    document.addEventListener("click", (e) => {
      if (!nav.contains(e.target)) {
        hamburger.setAttribute("aria-expanded", "false");
        navLinks.classList.remove("nav-open");
      }
    });
  }

  // ── Smooth scroll for anchor links ──
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (e) => {
      const href = link.getAttribute("href");
      if (href === "#" || href === "") return;

      const target = document.querySelector(href);
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth" });
      }
    });
  });
});
