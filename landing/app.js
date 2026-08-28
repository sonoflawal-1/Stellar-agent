// Bear on Stellar — Landing Page
// Scroll reveals, copy-to-clipboard, mobile nav, contract address loading,
// animated protocol stack diagram

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
    .querySelectorAll(".stack-grid, .steps-grid, .code-grid, .contracts-grid")
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

  // ── Mobile hamburger toggle ──
  const hamburger = document.getElementById("hamburger");
  const navLinksContainer = document.getElementById("nav-links");
  hamburger?.addEventListener("click", () => {
    const open = navLinksContainer.classList.toggle("nav-open");
    hamburger.setAttribute("aria-expanded", String(open));
  });
  navLinksContainer?.querySelectorAll(".nav-link").forEach((link) => {
    link.addEventListener("click", () => {
      navLinksContainer.classList.remove("nav-open");
      hamburger?.setAttribute("aria-expanded", "false");
    });
  });

  // ── Live contract addresses (issue #304) ──
  // Fetch from the /api/contract-addresses serverless endpoint and populate
  // the contract cards. Falls back silently to the hardcoded values already
  // in the HTML if the endpoint is unavailable.
  const CONTRACT_KEYS = {
    agent_identity: "CAMPXYFZJTIPEVOPOAZPRG5OHXKNBDPGTPRCOIO4LVPGEM4TONPY65A5",
    agentic_commerce: "CD2KWU7IE74Z2QKVP3FQ67J46XHNMGIDTNKXVWE7ZNVRC7T6UH46GQXE",
  };

  async function loadContractAddresses() {
    try {
      const res = await fetch("/api/contract-addresses");
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.contracts) return;

      const cardMap = {
        agent_identity: document.querySelector('[data-contract="agent_identity"]'),
        agentic_commerce: document.querySelector('[data-contract="agentic_commerce"]'),
      };

      for (const [key, card] of Object.entries(cardMap)) {
        const info = data.contracts[key];
        if (!card || !info?.address) continue;
        const btn = card.querySelector(".contract-addr");
        const code = card.querySelector(".contract-addr code");
        const full = card.querySelector(".contract-addr-full");
        const explorerLink = card.querySelector(".contract-explorer");
        if (btn) btn.dataset.address = info.address;
        if (code) code.textContent = info.address.slice(0, 4) + "..." + info.address.slice(-6);
        if (full) full.textContent = info.address;
        if (explorerLink && info.explorer) explorerLink.href = info.explorer;
      }

      // Mark cards as live-loaded for visibility
      document.querySelectorAll(".contracts-grid [data-contract]").forEach((c) => {
        c.classList.add("contracts-live");
      });
    } catch {
      // Silently fall back to static values
    }
  }

  loadContractAddresses();

  // ── Animated Protocol Stack Diagram (issue #303) ──
  const canvas = document.getElementById("protocol-diagram");
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext("2d");
    const DPR = window.devicePixelRatio || 1;

    function resizeCanvas() {
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width * DPR;
      canvas.height = 280 * DPR;
      canvas.style.width = rect.width + "px";
      canvas.style.height = "280px";
      ctx.scale(DPR, DPR);
    }
    resizeCanvas();
    window.addEventListener("resize", () => {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      resizeCanvas();
    });

    const LAYERS = [
      { label: "Agent Identity", sublabel: "ERC-8004 · Register", color: "#F97316", y: 40 },
      {
        label: "Agentic Commerce",
        sublabel: "ERC-8183 · Escrow & Settle",
        color: "#FB923C",
        y: 120,
      },
      { label: "x402 / MPP", sublabel: "HTTP 402 · Micropayments", color: "#FED7AA", y: 200 },
    ];

    const ARROW_COLOR = "#F97316";
    let tick = 0;
    let animationId;
    let diagramVisible = false;

    const diagramObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !diagramVisible) {
            diagramVisible = true;
            tick = 0;
            drawLoop();
          }
        });
      },
      { threshold: 0.2 },
    );
    diagramObserver.observe(canvas);

    function easeOutCubic(t) {
      return 1 - Math.pow(1 - t, 3);
    }

    function drawLayer(layer, progress, w) {
      const boxH = 60;
      const boxW = Math.min(w - 48, 640);
      const x = (w - boxW) / 2;
      const y = layer.y;
      const alpha = easeOutCubic(Math.min(progress, 1));
      const slideX = (1 - alpha) * -24;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(slideX, 0);

      // Card background
      ctx.beginPath();
      ctx.roundRect(x, y, boxW, boxH, 10);
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "rgba(249,115,22,0.12)";
      ctx.shadowBlur = 16;
      ctx.fill();
      ctx.shadowBlur = 0;

      // Left accent bar
      ctx.beginPath();
      ctx.roundRect(x, y, 4, boxH, [10, 0, 0, 10]);
      ctx.fillStyle = layer.color;
      ctx.fill();

      // Label
      ctx.fillStyle = "#0A0A0A";
      ctx.font = "600 15px Inter, system-ui, sans-serif";
      ctx.fillText(layer.label, x + 20, y + 26);

      // Sublabel
      ctx.fillStyle = "#6B7280";
      ctx.font = "500 12px Inter, system-ui, sans-serif";
      ctx.fillText(layer.sublabel, x + 20, y + 46);

      // Right color chip
      const chipW = 56;
      const chipX = x + boxW - chipW - 14;
      const chipY = y + 18;
      ctx.beginPath();
      ctx.roundRect(chipX, chipY, chipW, 22, 11);
      ctx.fillStyle = layer.color + "22";
      ctx.fill();
      ctx.fillStyle = layer.color;
      ctx.font = "600 11px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("LIVE", chipX + chipW / 2, chipY + 14.5);
      ctx.textAlign = "left";

      ctx.restore();
    }

    function drawArrow(fromY, progress, w) {
      if (progress <= 0) return;
      const boxW = Math.min(w - 48, 640);
      const x = w / 2;
      const startY = fromY + 60;
      const endY = fromY + 78;
      const alpha = easeOutCubic(Math.min(progress, 1));

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = ARROW_COLOR;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, startY);
      ctx.lineTo(x, endY);
      ctx.stroke();
      ctx.setLineDash([]);

      // Arrowhead
      ctx.fillStyle = ARROW_COLOR;
      ctx.beginPath();
      ctx.moveTo(x, endY + 6);
      ctx.lineTo(x - 5, endY);
      ctx.lineTo(x + 5, endY);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Pulse animation on the LIVE chips
    function drawPulse(w) {
      const pulse = (Math.sin(tick * 0.05) + 1) / 2; // 0..1
      LAYERS.forEach((layer) => {
        const boxW = Math.min(w - 48, 640);
        const x = (w - boxW) / 2;
        const chipW = 56;
        const chipX = x + boxW - chipW - 14;
        const chipY = layer.y + 18;
        ctx.save();
        ctx.globalAlpha = 0.35 * pulse;
        ctx.beginPath();
        ctx.roundRect(chipX, chipY, chipW, 22, 11);
        ctx.fillStyle = layer.color;
        ctx.fill();
        ctx.restore();
      });
    }

    const PHASE_DURATION = 22; // frames per layer reveal

    function drawLoop() {
      tick++;
      const w = canvas.width / DPR;
      const h = canvas.height / DPR;

      ctx.clearRect(0, 0, w, h);

      LAYERS.forEach((layer, i) => {
        const start = i * PHASE_DURATION;
        const progress = (tick - start) / PHASE_DURATION;
        drawLayer(layer, progress, w);

        if (i < LAYERS.length - 1) {
          const arrowStart = start + PHASE_DURATION * 0.6;
          drawArrow(layer.y, (tick - arrowStart) / (PHASE_DURATION * 0.4), w);
        }
      });

      const fullyLoaded = tick > LAYERS.length * PHASE_DURATION;
      if (fullyLoaded) {
        drawPulse(w);
      }

      animationId = requestAnimationFrame(drawLoop);
    }
  }

  // ── Try It playground — StackBlitz embed (issue #305) ──
  const playgroundSection = document.getElementById("try-it");
  const embedContainer = document.getElementById("stackblitz-embed");
  const loadPlaygroundBtn = document.getElementById("load-playground");

  if (loadPlaygroundBtn && embedContainer) {
    loadPlaygroundBtn.addEventListener("click", () => {
      loadPlaygroundBtn.disabled = true;
      loadPlaygroundBtn.textContent = "Loading…";

      // StackBlitz embed: open a pre-configured Node.js project demonstrating
      // the marc-stellar-sdk. The project URL encodes the files as query params
      // so no backend is needed — everything runs in the browser sandbox.
      const sbFiles = {
        "index.js": [
          "// Bear Protocol — marc-stellar-sdk browser playground",
          "// Edit and run this file to explore the SDK.",
          "",
          "import { IdentityClient, CommerceClient, TESTNET } from 'marc-stellar-sdk';",
          "import { Keypair } from '@stellar/stellar-sdk';",
          "",
          "const config = {",
          "  rpcUrl: TESTNET.rpcUrl,",
          "  networkPassphrase: TESTNET.networkPassphrase,",
          "  identityContract: TESTNET.identityContract,",
          "  commerceContract: TESTNET.commerceContract,",
          "  usdcToken: TESTNET.usdcToken,",
          "};",
          "",
          "console.log('TESTNET config:', config);",
          "",
          "// -- Register an agent identity --",
          "// const keypair = Keypair.random();",
          "// const identity = new IdentityClient(config);",
          "// const agentId = await identity.register(keypair, 'https://ipfs.example/metadata.json');",
          "// console.log('Registered agent:', agentId);",
          "",
          "// -- Create an escrow job --",
          "// const commerce = new CommerceClient(config);",
          "// const jobId = await commerce.createJob(",
          "//   keypair, provider, evaluator, config.usdcToken, 10_000_000n, 'Analyze data'",
          "// );",
          "// console.log('Job created:', jobId);",
        ].join("\n"),
        "package.json": JSON.stringify(
          {
            name: "bear-protocol-playground",
            version: "1.0.0",
            type: "module",
            dependencies: {
              "marc-stellar-sdk": "latest",
              "@stellar/stellar-sdk": "^12.0.0",
            },
          },
          null,
          2,
        ),
      };

      // Build StackBlitz URL with embedded files
      const params = new URLSearchParams();
      params.set("title", "Bear Protocol Playground");
      params.set("description", "marc-stellar-sdk interactive playground");
      params.set("template", "node");
      for (const [filename, content] of Object.entries(sbFiles)) {
        params.set(`files[${filename}]`, content);
      }
      params.set("embed", "1");
      params.set("view", "editor");
      params.set("theme", "light");
      params.set("hideNavigation", "1");

      const iframe = document.createElement("iframe");
      iframe.src = `https://stackblitz.com/run?${params.toString()}`;
      iframe.title = "Bear Protocol SDK Playground";
      iframe.allow = "cross-origin-isolated";
      iframe.loading = "lazy";
      iframe.className = "playground-iframe";
      iframe.setAttribute("aria-label", "Interactive SDK playground powered by StackBlitz");

      iframe.addEventListener("load", () => {
        loadPlaygroundBtn.parentElement?.removeChild(loadPlaygroundBtn);
      });

      embedContainer.appendChild(iframe);
    });
  }
});
