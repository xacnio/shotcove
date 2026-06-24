import "./overlay.css";
import { invoke, listen, emit } from "../lib/tauri.js";
import { createT } from "../lib/i18n.js";

const bg = document.getElementById("bg");
const sel = document.getElementById("sel");
const sizeEl = document.getElementById("size");
const hint = document.getElementById("hint");
const canvas = document.getElementById("overlay-canvas");
const ctx = canvas ? canvas.getContext("2d") : null;

// Each overlay window gets its monitor index from its window label (e.g. overlay-0, overlay-1).
// If the label has no index (just "overlay"), we default to monitor index 0.
const label = window.__TAURI__?.window?.getCurrentWindow?.()?.label ?? "overlay";
const monIndex = label.startsWith("overlay-") ? parseInt(label.slice(8), 10) : 0;

let mode = null; // "area" | "area_multi" | "window" (null until setup arrives)
let windows = [];
let done = false;
let startLive = false;
let liveMode = false; // false = frozen (default for area); true = live
let isLinux = false;
let t = null;
let currentRect = null;

function drawCanvas(rect) {
  if (!canvas || !ctx) return;

  // Resetting canvas width/height forces the browser to discard and recreate
  // the canvas backing store (surface texture) on every frame. This is a very
  // reliable way to clear hardware-accelerated canvas texture caching/ghosting bugs.
  const dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  ctx.scale(dpr, dpr);

  if (mode === "window") {
    if (rect) {
      ctx.fillStyle = "rgba(255, 255, 255, 0.50)";
      ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      ctx.strokeStyle = "rgba(245, 158, 11, 0.75)";
      ctx.lineWidth = 2.0;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
  } else {
    // In live mode, we do NOT draw the dimming overlay because:
    // 1. It hides the live screen underneath.
    // 2. Accumulating opacity turns the window solid black due to composition artifacts.
    if (!liveMode) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
      ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
    }
    if (rect) {
      if (!liveMode) {
        ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
      }
      ctx.strokeStyle = "#f59e0b";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(rect.x, rect.y, rect.w, rect.h);
    }
  }

  // Workaround for WebKitGTK damage tracking/ghosting bug on Linux transparent windows:
  // Toggle the body background color opacity by an imperceptible 0.001 on each draw
  // to force the compositor to clear previous frames and redraw the entire window cleanly.
  if (isLinux) {
    document.body.style.backgroundColor = document.body.style.backgroundColor === "rgba(0, 0, 0, 0.005)"
      ? "rgba(0, 0, 0, 0.006)"
      : "rgba(0, 0, 0, 0.005)";
  }
}

function resizeCanvas() {
  drawCanvas(currentRect);
}

window.addEventListener("resize", resizeCanvas);

// Set visible after positioning delay
setTimeout(() => {
  document.body.classList.add("visible");
}, 300);

Promise.all([
  invoke("get_overlay_setup", { monIndex }),
  invoke("get_settings").catch(() => ({ language: "en" })),
  invoke("platform_capabilities").catch(() => ({ os: "unknown" })),
]).then(([s, settings, platform]) => {
    t = createT(settings.language ?? "en");
    mode = s.mode;
    windows = s.windows || [];
    isLinux = platform.os === "linux";
    startLive = s.live_mode;
    liveMode = startLive;

    if (startLive) {
      document.body.classList.add("live-mode");
    }
    
    document.body.classList.add("canvas-overlay");
    resizeCanvas();

    if (mode === "window") {
      document.body.classList.add("window-mode");
      hint.textContent = startLive
        ? (t("overlay.windowHintLive") ?? "Live screen — select window · Esc to cancel")
        : t("overlay.windowHintFrozen");
    } else {
      hint.textContent = startLive ? t("overlay.areaHintLive") : t("overlay.areaHintFrozen");
    }
    invoke("overlay_ready").catch(() => {});

    // Load the pre-captured screenshot for the frozen overlay background.
    if (!startLive) {
      invoke("get_overlay_image", { monIndex })
        .then((jpeg) => {
          if (!liveMode && jpeg) {
            bg.src = jpeg;
          }
        })
        .catch(() => {});
    }
  })
  .catch(() => {
    t = (key) => key;
    mode = "area";
    hint.textContent = "Frozen — select area · Middle mouse for live · Esc to cancel";
    document.body.classList.add("canvas-overlay");
    resizeCanvas();
    invoke("overlay_ready").catch(() => {});
  });

function cancel() {
  if (done) return;
  done = true;
  invoke("overlay_cancel");
}

function forceRepaint() {
  document.body.style.display = "none";
  document.body.offsetHeight; // Force layout reflow
  setTimeout(() => {
    document.body.style.display = "";
  }, 30);
}

function switchToLive(fromEvent = false) {
  if (liveMode) return;

  // On Linux, toggling an already-open (opaque) overlay window transparent
  // in place doesn't reliably work (WebKitGTK keeps the old frame stuck).
  // Closing and reopening the window already in live mode sidesteps it.
  // Rust handles every overlay window (all monitors) in one go, so siblings
  // don't need their own "go live" event here.
  if (isLinux) {
    if (!fromEvent) {
      // This window is about to be closed and replaced by reopen_overlay_live.
      // Mark it done so the closing window's own blur/cancel handlers don't
      // race with Rust opening the new live windows and wipe shared state.
      done = true;
      invoke("reopen_overlay_live").catch(() => {});
    }
    return;
  }

  liveMode = true;
  document.body.classList.add("live-mode");
  bg.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  bg.removeAttribute("src");
  if (t) {
    if (mode === "window") {
      hint.textContent = t("overlay.windowHintLive") ?? "Live screen — select window · Esc to cancel";
    } else {
      hint.textContent = t("overlay.areaHintLive");
    }
  }

  forceRepaint();
  drawCanvas(currentRect);

  if (!fromEvent) {
    emit("overlay-go-live").catch(() => {});
    invoke("set_area_live_mode").catch(() => {});
  }
}

// Area selection (drag)

let startX = 0;
let startY = 0;
let dragging = false;

function rect(e) {
  return {
    x: Math.min(startX, e.clientX),
    y: Math.min(startY, e.clientY),
    w: Math.abs(e.clientX - startX),
    h: Math.abs(e.clientY - startY),
  };
}

// Window selection

function windowAt(x, y) {
  // List is in z-order (topmost first); first match is the topmost window.
  for (const w of windows) {
    if (x >= w.x && x <= w.x + w.w && y >= w.y && y <= w.y + w.h) return w;
  }
  return null;
}

function highlight(w) {
  if (!w) {
    currentRect = null;
    drawCanvas(null);
    sizeEl.style.display = "none";
    hint.style.display = "block";
    return;
  }
  hint.style.display = "none";
  currentRect = { x: w.x, y: w.y, w: w.w, h: w.h };
  drawCanvas(currentRect);
  sizeEl.style.display = "block";
  sizeEl.textContent = w.title.length > 70 ? w.title.slice(0, 70) + "…" : w.title;
  sizeEl.style.left = w.x + "px";
  sizeEl.style.top = Math.max(0, w.y - 26) + "px";

  // Clear highlights in other monitor overlays
  emit("clear-overlay-highlight", { exceptMonIndex: monIndex });
}

// Events

window.addEventListener("mousedown", (e) => {
  if (e.button === 2) {
    cancel();
    return;
  }

  // Middle mouse: switch from frozen to live mode.
  if (e.button === 1) {
    e.preventDefault();
    if (mode !== null) switchToLive();
    return;
  }

  if (e.button !== 0 || mode === null) return;

  if (mode === "window") {
    const w = windowAt(e.clientX, e.clientY);
    if (w && !done) {
      done = true;
      sel.style.left = w.x + "px";
      sel.style.top = w.y + "px";
      sel.style.width = w.w + "px";
      sel.style.height = w.h + "px";
      sel.classList.add("scanning");
      // Delay invoke so the animation is visible before Rust hides the overlay.
      setTimeout(() => {
        invoke("window_selected", { id: w.id }).catch(() => {});
      }, 700);
    }
    return;
  }

  // Area mode: start drag
  dragging = true;
  startX = e.clientX;
  startY = e.clientY;
  hint.style.display = "none";
  currentRect = { x: startX, y: startY, w: 0, h: 0 };
  drawCanvas(currentRect);
});

// Prevent middle-click autoscroll popup.
window.addEventListener("auxclick", (e) => {
  if (e.button === 1) e.preventDefault();
});

window.addEventListener("mousemove", (e) => {
  if (mode === "window") {
    highlight(windowAt(e.clientX, e.clientY));
    return;
  }
  if (!dragging) return;
  const r = rect(e);
  currentRect = r;
  drawCanvas(currentRect);

  sizeEl.style.display = "block";
  sizeEl.textContent =
    Math.round(r.w * devicePixelRatio) + " × " + Math.round(r.h * devicePixelRatio);
  sizeEl.style.left = (e.clientX + 14) + "px";
  sizeEl.style.top  = (e.clientY + 14) + "px";
});

window.addEventListener("mouseup", (e) => {
  if (mode === "window" || !dragging || e.button !== 0) return;
  dragging = false;
  const r = rect(e);
  if (r.w < 4 || r.h < 4) {
    currentRect = null;
    drawCanvas(null);
    sizeEl.style.display = "none";
    hint.style.display = "block";
    return;
  }
  if (done) return;
  done = true;
  invoke("area_selected", { x: r.x, y: r.y, w: r.w, h: r.h, monIndex });
});

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") cancel();
});
window.addEventListener("contextmenu", (e) => e.preventDefault());
// Clear the hover highlight when the cursor leaves this monitor's overlay.
document.addEventListener("mouseleave", () => {
  if (mode === "window" && !done) highlight(null);
});
window.addEventListener("blur", () => {
  // mode is null until setup resolves; don't cancel while the overlay is initialising.
  // In window/area_multi mode multiple overlays are open; focus moves between them.
  if (mode === null || mode === "window" || mode === "area_multi") return;
  if (!dragging) cancel();
});

listen("clear-overlay-highlight", (event) => {
  const payload = event.payload || {};
  if (payload.exceptMonIndex !== monIndex) {
    if (mode === "window" && !done) {
      highlight(null);
    }
  }
});

listen("overlay-go-live", () => {
  switchToLive(true);
});
