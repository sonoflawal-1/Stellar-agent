// Bear on Stellar — Landing Page
// Scroll reveals, copy-to-clipboard, mobile nav, contract address loading

document.addEventListener("DOMContentLoaded", () => {

  // ── Scroll reveal observer (fade-in elements) ──
  const revealObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("visible");
          revealObserver.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.12 }
  );

  // Stagger fade-in items inside grids
  document.querySelectorAll(".stack-grid, .steps-grid, .code-grid, .contracts-grid").forEach((group) => {
    const items = group.querySelectorAll(".fade-in");
    items.forEach((el, i) => {
      el.style.transitionDelay = (i * 0.1) + "s";
      revealObserver.observe(el);
    });
  });

  // Standalone fade-in elements
  document.querySelectorAll(".fade-in").forEach((el) => {
    if (!el.style.transitionDelay) {
      revealObserver.observe(el);
    }
  });

  // ── Active nav link tracking ──
  const nav = document.getElementById("nav");
  const sections = document.querySelectorAll("section[id]");
  const navLinks = document.querySelectorAll(".nav-link[data-section]");

  window.addEventListener("scroll", () => {
    let current = "";
    sections.forEach((section) => {
      const top = section.offsetTop - 100;
      if (window.scrollY >= top) {
        current = section.getAttribute("id");
      }
    });
    navLinks.forEach((link) => {
      link.classList.toggle("active", link.dataset.section === current);
    });
  }, { passive: true });

  // ── Copy-to-clipboard ──
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = "Copied!";
  document.body.appendChild(toast);

  let toastTimeout;
  document.querySelectorAll(".contract-addr").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const addr = btn.dataset.address;
      if (!addr) return;
      try {
        await navigator.clipboard.writeText(addr);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = addr;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
      }
      toast.classList.add("show");
      clearTimeout(toastTimeout);
      toastTimeout = setTimeout(() => toast.classList.remove("show"), 1500);
    });
  });

  // ── Smooth scroll for nav links ──
  const NAV_HEIGHT = 72;
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (e) => {
      const target = document.querySelector(link.getAttribute("href"));
      if (target) {
        e.preventDefault();
        const top = target.getBoundingClientRect().top + window.scrollY - NAV_HEIGHT;
        window.scrollTo({ top, behavior: "smooth" });
      }
    });
  });

  // ── Mobile hamburger toggle ──
  const hamburger = document.getElementById("hamburger");
  const navLinks = document.getElementById("nav-links");
  hamburger?.addEventListener("click", () => {
    const open = navLinks.classList.toggle("nav-open");
    hamburger.setAttribute("aria-expanded", String(open));
  });
  navLinks?.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("nav-open");
      hamburger?.setAttribute("aria-expanded", "false");
    });
  });
});
