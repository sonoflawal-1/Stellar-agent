// Bear on Stellar — Landing Page
// Scroll reveals, copy-to-clipboard, mobile nav, contract address loading,
// animated protocol stack diagram, interactive SDK snippet viewer

document.addEventListener("DOMContentLoaded", () => {
  // ── Dashboard link base URL ──
  // Reads the configurable base path from the <meta name="marc-dashboard-url">
  // tag so this same markup works whether the dashboard is served from this
  // same origin (default "/app") or deployed separately (override the meta
  // tag's content with an absolute URL).
  const dashboardUrl = document.querySelector('meta[name="marc-dashboard-url"]')?.content?.trim();
  if (dashboardUrl) {
    document.querySelectorAll("[data-dashboard-link]").forEach((link) => {
      link.href = dashboardUrl;
    });
  }

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
    { threshold: 0.12 },
  );

  // Stagger fade-in items inside grids
  document
    .querySelectorAll(".stack-grid, .steps-grid, .code-grid, .contracts-grid, .stats-grid")
    .forEach((group) => {
      const items = group.querySelectorAll(".fade-in");
      items.forEach((el, i) => {
        el.style.transitionDelay = i * 0.1 + "s";
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

  window.addEventListener(
    "scroll",
    () => {
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
    },
    { passive: true },
  );

  // ── Copy-to-clipboard ──
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = "Copied!";
  document.body.appendChild(toast);

  let toastTimeout;
  function showToast(message) {
    toast.textContent = message || "Copied!";
    toast.classList.add("show");
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove("show"), 1500);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
  }

  document.querySelectorAll(".contract-addr").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const addr = btn.dataset.address;
      if (!addr) return;
      await copyText(addr);
      showToast("Copied!");
    });
  });

  // ── Interactive SDK snippet viewer (issue #600) ──
  // Renders the selected use-case snippet with lightweight syntax
  // highlighting and a one-click copy button with tooltip feedback.
  const SNIPPETS = {
    identity: {
      label: "Identity",
      code: [
        "import { MarcClient } from 'marc-stellar-sdk';\n",
        "\n",
        "const client = new MarcClient({ network: 'testnet' });\n",
        "\n",
        "// Register an agent identity (ERC-8004)\n",
        "const agent = await client.identity.register({\n",
        "  name: 'research-agent',\n",
        "  capabilities: ['search', 'summarize'],\n",
        "  metadataUri: 'ipfs://bafy...',\n",
        "});\n",
        "\n",
        "console.log('Agent registered:', agent.id);\n",
      ].join(""),
    },
    escrow: {
      label: "Escrow Job",
      code: [
        "import { MarcClient } from 'marc-stellar-sdk';\n",
        "\n",
        "const client = new MarcClient({ network: 'testnet' });\n",
        "\n",
        "// Create an escrow-backed job (ERC-8183)\n",
        "const job = await client.jobs.create({\n",
        "  provider: 'G...PROVIDER',\n",
        "  amount: '100',\n",
        "  asset: 'USDC',\n",
        "  deadline: Math.floor(Date.now() / 1000) + 3600,\n",
        "});\n",
        "\n",
        "await job.fund();\n",
        "console.log('Job funded:', job.id);\n",
      ].join(""),
    },
    x402: {
      label: "x402 Paywall",
      code: [
        "import { MarcClient } from 'marc-stellar-sdk';\n",
        "\n",
        "const client = new MarcClient({ network: 'testnet' });\n",
        "\n",
        "// Gate an endpoint behind an x402 paywall\n",
        "const paywall = client.x402.paywall({\n",
        "  price: '0.01',\n",
        "  asset: 'USDC',\n",
        "  payTo: 'G...MERCHANT',\n",
        "});\n",
        "\n",
        "app.get('/premium', paywall, (req, res) => {\n",
        "  res.json({ data: 'paid content' });\n",
        "});\n",
      ].join(""),
    },
    fetch: {
      label: "Fetch with Payment",
      code: [
        "import { MarcClient } from 'marc-stellar-sdk';\n",
        "\n",
        "const client = new MarcClient({ network: 'testnet' });\n",
        "\n",
        "// Automatically settle HTTP 402 challenges\n",
        "const res = await client.x402.fetch('https://api.example.com/premium', {\n",
        "  method: 'GET',\n",
        "  maxAmount: '0.05',\n",
        "});\n",
        "\n",
        "const data = await res.json();\n",
        "console.log('Paid response:', data);\n",
      ].join(""),
    },
  };

  const snippetViewer = document.querySelector("[data-snippet-viewer]");
  if (snippetViewer) {
    const tabs = snippetViewer.querySelectorAll("[data-snippet-tab]");
    const codeEl = snippetViewer.querySelector("[data-snippet-code]");
    const copyBtn = snippetViewer.querySelector("[data-snippet-copy]");
    const tooltip = snippetViewer.querySelector("[data-snippet-tooltip]");
    let activeKey = tabs[0]?.dataset.snippetTab || "identity";

    // Minimal tokenizer: comments, strings, keywords, numbers.
    function highlight(code) {
      const escaped = code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      return escaped
        .replace(/(\/\/[^\n]*)/g, '<span class="tok-comment">$1</span>')
        .replace(/(&#39;|')([^'\n]*)(&#39;|')/g, '<span class="tok-string">$1$2$3</span>')
        .replace(/\b(import|from|const|await|async|new|return|console)\b/g, '<span class="tok-keyword">$1</span>')
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
    }

    function renderSnippet(key) {
      const snippet = SNIPPETS[key];
      if (!snippet || !codeEl) return;
      activeKey = key;
      codeEl.innerHTML = highlight(snippet.code);
      tabs.forEach((tab) => {
        const isActive = tab.dataset.snippetTab === key;
        tab.classList.toggle("active", isActive);
        tab.setAttribute("aria-selected", String(isActive));
      });
    }

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => renderSnippet(tab.dataset.snippetTab));
    });

    let tooltipTimeout;
    copyBtn?.addEventListener("click", async () => {
      const snippet = SNIPPETS[activeKey];
      if (!snippet) return;
      await copyText(snippet.code);
      if (tooltip) {
        tooltip.classList.add("show");
        clearTimeout(tooltipTimeout);
        tooltipTimeout = setTimeout(() => tooltip.classList.remove("show"), 1500);
      }
      showToast("Copied!");
    });

    renderSnippet(activeKey);
  }

  // ── Mobile hamburger toggle ──
  const hamburger = document.getElementById("hamburger");
  const mobileMenu = document.getElementById("mobile-menu");
  if (hamburger && mobileMenu) {
    const setMenuState = (open) => {
      mobileMenu.classList.toggle("open", open);
      hamburger.classList.toggle("active", open);
      hamburger.setAttribute("aria-expanded", String(open));
      hamburger.setAttribute("aria-controls", "mobile-menu");
      hamburger.setAttribute("aria-label", open ? "Close navigation menu" : "Open navigation menu");
    };
    setMenuState(false);
    hamburger.addEventListener("click", () => {
      setMenuState(!mobileMenu.classList.contains("open"));
    });
  }

  // ── Modal accessibility (issue #601) ──
  // Adds dialog semantics, Escape-to-close, focus trapping while open, and
  // focus restoration to the trigger element on close.
  const FOCUSABLE =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

  document.querySelectorAll("[data-modal]")
    .forEach((modal) => {
      const dialog = modal.querySelector("[role='dialog']") || modal;
      const labelledBy = dialog.getAttribute("aria-labelledby");
      if (!dialog.hasAttribute("role")) dialog.setAttribute("role", "dialog");
      dialog.setAttribute("aria-modal", "true");
      if (!labelledBy) {
        const heading = dialog.querySelector("h1, h2, h3, [data-modal-title]");
        if (heading) {
          if (!heading.id) heading.id = "modal-title-" + Math.random().toString(36).slice(2, 8);
          dialog.setAttribute("aria-labelledby", heading.id);
        }
      }

      let lastFocused = null;

      const getFocusable = () =>
        Array.from(dialog.querySelectorAll(FOCUSABLE)).filter(
          (el) => el.offsetParent !== null || el === document.activeElement,
        );

      const onKeydown = (event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeModal();
          return;
        }
        if (event.key !== "Tab") return;
        const focusable = getFocusable();
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      };

      function openModal() {
        lastFocused = document.activeElement;
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
        document.addEventListener("keydown", onKeydown);
        const focusable = getFocusable();
        (focusable[0] || dialog).focus();
      }

      function closeModal() {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
        document.removeEventListener("keydown", onKeydown);
        if (lastFocused && typeof lastFocused.focus === "function") {
          lastFocused.focus();
        }
      }

      modal.querySelectorAll("[data-modal-close]").forEach((btn) => {
        if (!btn.hasAttribute("aria-label")) btn.setAttribute("aria-label", "Close dialog");
        btn.addEventListener("click", closeModal);
      });

      document.querySelectorAll("[data-modal-open='" + modal.id + "']").forEach((trigger) => {
        trigger.addEventListener("click", openModal);
      });

      modal._openModal = openModal;
      modal._closeModal = closeModal;
    });

  // ── Live On-Chain Protocol Stats (Issue #599) ──
  // Queries live stats from /api/stats (or Soroban testnet) and updates
  // Total Registered Agents (identity.registered_count),
  // Total Escrow Jobs (commerce.job_count), and Fee Revenue (USDC amount),
  // falling back gracefully to cached baseline figures if the network fails.
  const FALLBACK_STATS = {
    totalAgents: null,
    totalJobs: null,
    feeRevenueFormatted: "Stats temporarily unavailable",
  };

  async function fetchProtocolStats() {
    const agentsEl = document.getElementById("stat-registered-agents");
    const jobsEl = document.getElementById("stat-escrow-jobs");
    const revenueEl = document.getElementById("stat-fee-revenue");

    function renderStats(stats) {
      if (agentsEl) {
        agentsEl.textContent =
          stats.totalAgents !== undefined && stats.totalAgents !== null
            ? String(stats.totalAgents)
            : "—";
        agentsEl.classList.remove("loading");
      }
      if (jobsEl) {
        jobsEl.textContent =
          stats.totalJobs !== undefined && stats.totalJobs !== null
            ? String(stats.totalJobs)
            : "—";
        jobsEl.classList.remove("loading");
      }
      if (revenueEl) {
        revenueEl.textContent =
          stats.feeRevenueFormatted ||
          (stats.feeRevenue ? `$${stats.feeRevenue} USDC` : "Stats temporarily unavailable");
        revenueEl.classList.remove("loading");
      }
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);

      const res = await fetch("/api/stats", { signal: controller.signal });
      clearTimeout(timeoutId);

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      renderStats(data);
    } catch (err) {
      console.warn("[landing] Live testnet stats unavailable, falling back to cached figures:", err);
      renderStats(FALLBACK_STATS);
    }
  }

  fetchProtocolStats();
});
