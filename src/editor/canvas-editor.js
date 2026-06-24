import { invoke } from "../lib/tauri.js";

export const COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#ffffff", "#1c1917",
];
export const SIZES = [1, 2, 4, 8, 14, 22];

const FONT_DEFAULT = "Arial, sans-serif";

// TL T TR L R BL B BR order
const CROP_CURSORS = [
  "nw-resize", "n-resize", "ne-resize",
  "w-resize",              "e-resize",
  "sw-resize", "s-resize", "se-resize",
];

export class CanvasEditor {
  constructor({ canvas, viewport, grid, textInput, cropConfirm, onState, onToast }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.viewport = viewport;
    this.grid = grid;
    this.textInput = textInput;
    this.cropConfirm = cropConfirm;
    this.onState = onState || (() => {});
    this.onToast = onToast || (() => {});

    this.baseCanvas = document.createElement("canvas");
    this.bctx = this.baseCanvas.getContext("2d");

    this.ops = [];
    this.undoStack = [];
    this.redoStack = [];
    this.monitorRects = []; // [[x,y,w,h],...] in baseCanvas pixel coords, set by loadImage
    this.tool = "select";
    this.shapeKind = "rect";
    this.blurKind = "rect";
    this.arrowKind = "classic";
    this.fontKind = FONT_DEFAULT;
    this.fontBold = false;
    this.fontItalic = false;
    this.fontUnderline = false;
    this.textBg = "none";
    this.textFontSize = 28;
    this.textHAlign = "left";
    this.textVAlign = "center";
    this.color = "#ef4444";
    this.loaded = false;
    this.bg = {
      enabled: false,
      type: "gradient", // "solid" | "gradient" | "transparent"
      color1: "#6366f1",
      color2: "#a855f7",
      color3: null,
      angle: 135,
      paddingTop: 60,
      paddingRight: 60,
      paddingBottom: 60,
      paddingLeft: 60,
      shadowEnabled: true,
      shadowBlur: 30,
      shadowColor: "rgba(0, 0, 0, 0.4)",
      shadowOffset: 15,
      borderRadius: 0,
    };
    this.sizeIdx = 1;
    this.strokeSize = 2;
    this.zoom = 1;
    this.current = null;
    this.cropRect = null;
    this.drawing = false;
    this.hoverPos = null;
    this.textPos = null;
    this.editTextIdx = -1;

    this.selectedIdx = -1;
    this.dragMode = null;
    this.dragHandle = -1;
    this.dragStart = null;
    this.dragBefore = null;

    // Crop drag state
    this.cropDragMode = null;   // null | "new" | "move"
    this.cropDragStart = null;
    this.cropRectBefore = null;
    this._cropFresh = false; // when true, first click starts a new crop instead of moving

    // DOM-based crop handles and size label
    this._handleEls = null;
    this._dimLabel = null;

    // DOM-based selection border and handles
    this._selBorderEl  = null;
    this._selHandleEls = null;

    this.blurPrevBase = null;
    this.pixelCanvas = null;
    this.lastBlurPt = null;

    if (this.textInput) this.textInput.style.display = "none";
    if (this.cropConfirm) this.cropConfirm.style.display = "none";

    this._loadPrefs();
    this._bind();
    this._createCropHandles();
    this._createSelectionOverlay();
  }

  px() { return SIZES[this.sizeIdx]; }
  blurRadius() { return Math.max(14, this.px() * 9); }

  _fontStr(size, family, bold, italic) {
    const prefix = (italic ? "italic " : "") + (bold ? "bold " : "");
    return `${prefix}${size}px ${family}`;
  }

  // State broadcast

  _emit() {
    const sel = this.selectedIdx >= 0 ? this.ops[this.selectedIdx] : null;
    const isShape = sel && ["rect", "ellipse", "line", "star"].includes(sel.type);
    const isArrow = sel?.type === "arrow";
    this.onState({
      tool: this.tool,
      color: this.color,
      sizeIdx: this.sizeIdx,
      strokeSize: isShape || isArrow ? sel.size : this.strokeSize,
      shapeKind: this.shapeKind,
      blurKind: this.blurKind,
      arrowKind: this.arrowKind,
      fontKind:      sel?.type === "text" ? (sel.font      ?? this.fontKind)      : this.fontKind,
      fontBold:      sel?.type === "text" ? (sel.bold      ?? this.fontBold)      : this.fontBold,
      fontItalic:    sel?.type === "text" ? (sel.italic    ?? this.fontItalic)    : this.fontItalic,
      fontUnderline: sel?.type === "text" ? (sel.underline ?? this.fontUnderline) : this.fontUnderline,
      textBg: this.textBg,
      textFontSize: sel?.type === "text" ? sel.fontSize : this.textFontSize,
      textHAlign: sel?.type === "text" ? (sel.textHAlign ?? "left")   : this.textHAlign,
      textVAlign: sel?.type === "text" ? (sel.textVAlign ?? "center") : this.textVAlign,
      zoom: this.zoom,
      canvasW: this.canvas.width,
      canvasH: this.canvas.height,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      canDelete: this.canDeleteSelection(),
      selectedType: sel ? sel.type : null,
      bg: this.bg ? { ...this.bg } : null,
      loaded: this.loaded,
    });
  }

  // Image loading

  async loadImage() {
    this.loaded = false;
    const bytes = await invoke("get_editor_image").catch(() => null);
    if (!bytes) { invoke("editor_close"); return; }
    const meta = await invoke("get_editor_meta").catch(() => null);

    const blob = new Blob([bytes], { type: "image/png" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;

    try {
      await img.decode();
      this.baseCanvas.width = img.naturalWidth;
      this.baseCanvas.height = img.naturalHeight;
      this.bctx.drawImage(img, 0, 0);
      this.ops = [];
      this.undoStack = [];
      this.redoStack = [];
      this.current = null;
      this.selectedIdx = -1;
      this.dragMode = null;

      this.monitorRects = (meta?.monitor_rects || []).map(r => [r[0], r[1], r[2], r[3]]);

      if (meta && meta.is_window) {
        // Window screenshot: open with bg tool, no crop
        this.tool = "bg";
        this.cropRect = null;
        this.bg.enabled = true;
        // Color/angle/padding/shadow come from saved prefs (_loadPrefs)
      } else {
        // Regular screenshot: open with crop tool, full image selected
        this.tool = "crop";
        this.cropRect = { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
        this._cropFresh = true;
        this.bg.enabled = false;
      }

      this.updateCanvasSize();
      this.render();
      this._emit();
      invoke("editor_ready").then(() => {
        // Calculate fit with real size after window is maximized
        requestAnimationFrame(() => {
          this.fitZoom();
          this.render();
          this.loaded = true;
          this._emit();
        });
      }).catch(() => {
        this.loaded = true;
        this._emit();
      });
    } catch (err) {
      console.error("Failed to decode image asynchronously:", err);
      this.loaded = true;
      this._emit();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  fitZoom() {
    const dpr = window.devicePixelRatio || 1;
    const fit = Math.min(
      1,
      ((this.viewport.clientWidth  - 60) * dpr) / this.canvas.width,
      ((this.viewport.clientHeight - 60) * dpr) / this.canvas.height
    );
    this.setZoom(Math.max(0.1, fit), true);
  }

  setZoom(z, center = false) {
    this.zoom = Math.min(3, Math.max(0.1, z));
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width  = (this.canvas.width  * this.zoom / dpr) + "px";
    this.canvas.style.height = (this.canvas.height * this.zoom / dpr) + "px";
    if (this.zoom < 0.99) {
      this.canvas.style.imageRendering = "auto";
    } else {
      this.canvas.style.imageRendering = "pixelated";
    }
    if (this.cropRect) {
      this._positionCropConfirm();
      this._updateCropHandlesAndLabel();
    }
    if (center) this._centerCanvas();
    this._updateCursor();
    this._emit();
  }

  _centerCanvas() {
    requestAnimationFrame(() => {
      const vp  = this.viewport;
      const dpr = window.devicePixelRatio || 1;
      const cw  = this.canvas.width  * this.zoom / dpr;
      const ch  = this.canvas.height * this.zoom / dpr;
      const pad = 480;

      const gridW = Math.max(vp.clientWidth,  cw + pad * 2);
      const gridH = Math.max(vp.clientHeight, ch + pad * 2);

      if (this.grid) {
        const pl = Math.round((gridW - cw) / 2);
        const pt = Math.round((gridH - ch) / 2);
        this.grid.style.width   = gridW + "px";
        this.grid.style.height  = gridH + "px";
        this.grid.style.padding = `${pt}px ${pl}px`;
      }

      vp.scrollLeft = Math.round((gridW - vp.clientWidth)  / 2);
      vp.scrollTop  = Math.round((gridH - vp.clientHeight) / 2);
    });
  }

  updateCanvasSize() {
    const w = this.bg && this.bg.enabled
      ? this.baseCanvas.width + this.bg.paddingLeft + this.bg.paddingRight
      : this.baseCanvas.width;
    const h = this.bg && this.bg.enabled
      ? this.baseCanvas.height + this.bg.paddingTop + this.bg.paddingBottom
      : this.baseCanvas.height;

    this.canvas.width = w;
    this.canvas.height = h;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.style.width  = (w * this.zoom / dpr) + "px";
    this.canvas.style.height = (h * this.zoom / dpr) + "px";
    if (this.zoom < 0.99) {
      this.canvas.style.imageRendering = "auto";
    } else {
      this.canvas.style.imageRendering = "pixelated";
    }
  }

  updateBg(settings) {
    this.bg = { ...this.bg, ...settings };
    this.updateCanvasSize();
    this.render();
    this._savePrefs();
    const needsFit = ["paddingTop","paddingRight","paddingBottom","paddingLeft","enabled"].some(k => k in settings);
    if (needsFit) this.fitZoom(); else this._emit();
  }

  _imgPos(e) {
    const p = this._pos(e);
    const ox = this.bg && this.bg.enabled ? this.bg.paddingLeft : 0;
    const oy = this.bg && this.bg.enabled ? this.bg.paddingTop : 0;
    return {
      x: p.x - ox,
      y: p.y - oy,
    };
  }

  _drawBackground() {
    const { ctx, canvas } = this;
    const bg = this.bg;
    if (!bg || !bg.enabled) return;

    ctx.save();
    if (bg.type === "transparent") {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else if (bg.type === "solid") {
      ctx.fillStyle = bg.color1;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    } else if (bg.type === "gradient") {
      const angleRad = (bg.angle * Math.PI) / 180;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      const r = Math.abs(canvas.width * Math.cos(angleRad)) + Math.abs(canvas.height * Math.sin(angleRad));
      const halfR = r / 2;
      const x0 = cx - halfR * Math.cos(angleRad);
      const y0 = cy - halfR * Math.sin(angleRad);
      const x1 = cx + halfR * Math.cos(angleRad);
      const y1 = cy + halfR * Math.sin(angleRad);

      const grad = ctx.createLinearGradient(x0, y0, x1, y1);
      grad.addColorStop(0, bg.color1);
      if (bg.color3) grad.addColorStop(0.5, bg.color3);
      grad.addColorStop(1, bg.color2);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.restore();
  }

  _drawBaseCanvas(ox, oy) {
    const { ctx, canvas, baseCanvas, bg } = this;
    ctx.save();
    const w = baseCanvas.width;
    const h = baseCanvas.height;
    const r = bg?.borderRadius || 0;

    if (r > 0 && bg && bg.enabled) {
      // Multi-monitor captures use the individual monitor rects so the shadow
      // follows actual content edges, not the combined bounding box (which
      // extends below shorter monitors).
      const useMonRects = this.monitorRects.length > 1;

      if (bg.shadowEnabled) {
        ctx.shadowColor = bg.shadowColor || "rgba(0, 0, 0, 0.4)";
        ctx.shadowBlur = bg.shadowBlur || 30;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = bg.shadowOffset || 15;
      }

      // Fill style: use the background gradient/solid so transparent pixels
      // (alignment gaps) show the correct bg color, not white.
      if (bg.type === "gradient") {
        const angleRad = (bg.angle * Math.PI) / 180;
        const cx = canvas.width / 2;
        const cy = canvas.height / 2;
        const gLen = Math.abs(canvas.width * Math.cos(angleRad)) + Math.abs(canvas.height * Math.sin(angleRad));
        const halfL = gLen / 2;
        const grad = ctx.createLinearGradient(
          cx - halfL * Math.cos(angleRad), cy - halfL * Math.sin(angleRad),
          cx + halfL * Math.cos(angleRad), cy + halfL * Math.sin(angleRad),
        );
        grad.addColorStop(0, bg.color1);
        if (bg.color3) grad.addColorStop(0.5, bg.color3);
        grad.addColorStop(1, bg.color2);
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = bg.type === "transparent" ? "rgba(0,0,0,0.01)" : (bg.color1 || "#ffffff");
      }

      ctx.beginPath();
      if (useMonRects) {
        // Compound path of all monitor rects — shadow hugs actual content boundaries.
        for (const [rx, ry, rw, rh] of this.monitorRects) {
          ctx.rect(ox + rx, oy + ry, rw, rh);
        }
      } else {
        // Single image: full rounded rect.
        ctx.moveTo(ox + r, oy);
        ctx.lineTo(ox + w - r, oy);
        ctx.quadraticCurveTo(ox + w, oy, ox + w, oy + r);
        ctx.lineTo(ox + w, oy + h - r);
        ctx.quadraticCurveTo(ox + w, oy + h, ox + w - r, oy + h);
        ctx.lineTo(ox + r, oy + h);
        ctx.quadraticCurveTo(ox, oy + h, ox, oy + h - r);
        ctx.lineTo(ox, oy + r);
        ctx.quadraticCurveTo(ox, oy, ox + r, oy);
        ctx.closePath();
      }
      ctx.fill();

      if (bg.shadowEnabled) {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
        ctx.shadowOffsetY = 0;
      }

      // Clip to the full image rounded rect so the screenshot draws cleanly.
      ctx.beginPath();
      ctx.moveTo(ox + r, oy);
      ctx.lineTo(ox + w - r, oy);
      ctx.quadraticCurveTo(ox + w, oy, ox + w, oy + r);
      ctx.lineTo(ox + w, oy + h - r);
      ctx.quadraticCurveTo(ox + w, oy + h, ox + w - r, oy + h);
      ctx.lineTo(ox + r, oy + h);
      ctx.quadraticCurveTo(ox, oy + h, ox, oy + h - r);
      ctx.lineTo(ox, oy + r);
      ctx.quadraticCurveTo(ox, oy, ox + r, oy);
      ctx.closePath();
      ctx.clip();
    }

    ctx.drawImage(baseCanvas, ox, oy);
    ctx.restore();
  }

  // Drawing

  render() {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (this.bg && this.bg.enabled) {
      this._drawBackground();
    }

    const ox = this.bg && this.bg.enabled ? this.bg.paddingLeft : 0;
    const oy = this.bg && this.bg.enabled ? this.bg.paddingTop : 0;

    this._drawBaseCanvas(ox, oy);

    ctx.save();
    ctx.translate(ox, oy);
    for (const op of this.ops) this._drawOp(op);
    if (this.current) this._drawOp(this.current);
    ctx.restore();

    if (this.cropRect) {
      this._drawCropOverlay(this.cropRect);
    }

    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx]) {
      ctx.save();
      ctx.translate(ox, oy);
      this._drawSelection(this.ops[this.selectedIdx]);
      ctx.restore();
    }

    if (this.hoverPos) {
      const r = this.tool === "marker"
        ? this.px() * 1.1
        : this.blurRadius();
      ctx.save();
      ctx.translate(ox, oy);
      ctx.beginPath();
      ctx.arc(this.hoverPos.x, this.hoverPos.y, r, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,0,0,0.55)";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }

    this._updateSelectionOverlay();
  }

  _normRect(o) {
    return {
      x: Math.min(o.from.x, o.to.x),
      y: Math.min(o.from.y, o.to.y),
      w: Math.abs(o.to.x - o.from.x),
      h: Math.abs(o.to.y - o.from.y),
    };
  }

  _drawOp(op) {
    const { ctx, canvas } = this;
    ctx.save();
    ctx.strokeStyle = op.color;
    ctx.fillStyle = op.color;
    ctx.lineWidth = op.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    switch (op.type) {
      case "arrow": this._drawArrow(op); break;
      case "line":
        ctx.beginPath();
        ctx.moveTo(op.from.x, op.from.y);
        ctx.lineTo(op.to.x, op.to.y);
        ctx.stroke();
        break;
      case "rect": {
        const r = this._normRect(op);
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        break;
      }
      case "ellipse": {
        const r = this._normRect(op);
        ctx.beginPath();
        ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;
      }
      case "marker": {
        ctx.globalAlpha = 0.95;
        ctx.beginPath();
        const pts = op.points;
        ctx.moveTo(pts[0].x, pts[0].y);
        for (const p of pts) ctx.lineTo(p.x, p.y);
        ctx.stroke();
        break;
      }
      case "text": {
        ctx.font = this._fontStr(op.fontSize, op.font || FONT_DEFAULT, op.bold, op.italic);
        const tw  = ctx.measureText(op.text).width;
        const pad = op.fontSize * 0.18;
        const bw  = op.boxW ?? (tw + pad * 2);
        const bh  = op.boxH ?? (op.fontSize * 1.4 + pad * 2);
        if (op.bg && op.bg !== "none") {
          ctx.fillStyle = op.bg === "white" ? "#ffffff" : "#1b1b1b";
          ctx.fillRect(op.x, op.y, bw, bh);
        }
        const ha = op.textHAlign ?? "left";
        const va = op.textVAlign ?? "center";
        const textX = ha === "center" ? op.x + (bw - tw) / 2
                    : ha === "right"  ? op.x + bw - tw - pad
                    :                   op.x + pad;
        const textY = va === "top"    ? op.y + pad
                    : va === "bottom" ? op.y + bh - op.fontSize - pad
                    :                   op.y + (bh - op.fontSize) / 2;
        ctx.textBaseline = "top";
        ctx.fillStyle = op.color;
        ctx.fillText(op.text, textX, textY);
        if (op.underline) {
          const ulY = textY + op.fontSize * 0.88;
          ctx.fillRect(textX, ulY, tw, Math.max(1, Math.round(op.fontSize * 0.06)));
        }
        break;
      }
      case "star": {
        const r = this._normRect(op);
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        ctx.beginPath();
        for (let i = 0; i < 10; i++) {
          const ang = -Math.PI / 2 + (i * Math.PI) / 5;
          const f = i % 2 ? 0.45 : 1;
          const x = cx + (r.w / 2) * f * Math.cos(ang);
          const y = cy + (r.h / 2) * f * Math.sin(ang);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case "triangle": {
        const r = this._normRect(op);
        ctx.beginPath();
        ctx.moveTo(r.x + r.w / 2, r.y);
        ctx.lineTo(r.x + r.w, r.y + r.h);
        ctx.lineTo(r.x, r.y + r.h);
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case "diamond": {
        const r = this._normRect(op);
        ctx.beginPath();
        ctx.moveTo(r.x + r.w / 2, r.y);
        ctx.lineTo(r.x + r.w, r.y + r.h / 2);
        ctx.lineTo(r.x + r.w / 2, r.y + r.h);
        ctx.lineTo(r.x, r.y + r.h / 2);
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case "pentagon": {
        const r = this._normRect(op);
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        ctx.beginPath();
        for (let i = 0; i < 5; i++) {
          const ang = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
          const x = cx + (r.w / 2) * Math.cos(ang);
          const y = cy + (r.h / 2) * Math.sin(ang);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case "hexagon": {
        const r = this._normRect(op);
        const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
        ctx.beginPath();
        for (let i = 0; i < 6; i++) {
          const ang = (i * Math.PI) / 3;
          const x = cx + (r.w / 2) * Math.cos(ang);
          const y = cy + (r.h / 2) * Math.sin(ang);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        ctx.stroke();
        break;
      }
      case "blurbox": {
        const r = this._normRect(op);
        if (r.w < 2 || r.h < 2) break;
        const block = op.block || 12;
        const tw = Math.max(1, Math.ceil(r.w / block));
        const th = Math.max(1, Math.ceil(r.h / block));
        const tmp = document.createElement("canvas");
        tmp.width = tw; tmp.height = th;
        // ctx has translate(ox, oy) applied, so r.x/r.y are in image space.
        // Reading from the raw canvas element requires adding the background offset
        // so we sample from the image area, not the (potentially transparent) padding.
        const sbx = this.bg?.enabled ? (this.bg.paddingLeft ?? 0) : 0;
        const sby = this.bg?.enabled ? (this.bg.paddingTop  ?? 0) : 0;
        tmp.getContext("2d").drawImage(canvas, sbx + r.x, sby + r.y, r.w, r.h, 0, 0, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tmp, 0, 0, tw, th, r.x, r.y, r.w, r.h);
        ctx.imageSmoothingEnabled = true;
        if (op === this.current) {
          ctx.setLineDash([6, 4]);
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = "#ffffff";
          ctx.strokeRect(r.x, r.y, r.w, r.h);
          ctx.setLineDash([]);
        }
        break;
      }
      case "crop": {
        const r = this._normRect(op);
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#f59e0b";
        ctx.strokeRect(r.x, r.y, r.w, r.h);
        ctx.setLineDash([]);
        // Size label during new drawing (no canvas crop)
        if (op === this.current && this._dimLabel) {
          const ox = this.canvas.offsetLeft, oy = this.canvas.offsetTop;
          const lx = ox + (r.x + r.w / 2) * this.zoom;
          const ly = oy + (r.y + r.h) * this.zoom + 12;
          this._dimLabel.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
          this._dimLabel.style.left = lx + "px";
          this._dimLabel.style.top  = ly + "px";
          this._dimLabel.style.display = "block";
        }
        break;
      }
    }
    ctx.restore();
  }

  _drawArrow(op) {
    const { ctx } = this;
    const { from, to } = op;
    const angle = Math.atan2(to.y - from.y, to.x - from.x);
    const head = Math.max(10, op.size * 3.5);

    if (op.kind === "dots") {
      const dist = Math.hypot(to.x - from.x, to.y - from.y);
      const step = Math.max(10, op.size * 4);
      const n = Math.max(2, Math.floor(dist / step));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const radius = op.size * (0.6 + t * 1.4);
        ctx.beginPath();
        ctx.arc(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    if (op.kind === "open") {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(to.x - head * Math.cos(angle - 0.45), to.y - head * Math.sin(angle - 0.45));
      ctx.lineTo(to.x, to.y);
      ctx.lineTo(to.x - head * Math.cos(angle + 0.45), to.y - head * Math.sin(angle + 0.45));
      ctx.stroke();
      return;
    }
    const shaftEnd = {
      x: to.x - head * 0.7 * Math.cos(angle),
      y: to.y - head * 0.7 * Math.sin(angle),
    };
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(shaftEnd.x, shaftEnd.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(to.x, to.y);
    ctx.lineTo(to.x - head * Math.cos(angle - 0.45), to.y - head * Math.sin(angle - 0.45));
    ctx.lineTo(to.x - head * Math.cos(angle + 0.45), to.y - head * Math.sin(angle + 0.45));
    ctx.closePath();
    ctx.fill();
  }

  // Crop: overlay drawing (handles in DOM)

  _drawCropOverlay(r) {
    const { ctx, canvas } = this;
    ctx.save();
    // Dimming: area outside the crop within the canvas
    const cx0 = Math.max(0, r.x), cy0 = Math.max(0, r.y);
    const cx1 = Math.min(canvas.width, r.x + r.w);
    const cy1 = Math.min(canvas.height, r.y + r.h);
    ctx.fillStyle = "rgba(0,0,0,0.45)";
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    if (cx1 > cx0 && cy1 > cy0) ctx.rect(cx0, cy0, cx1 - cx0, cy1 - cy0);
    ctx.fill("evenodd");
    ctx.restore();
  }

  // Crop: DOM handles

  _createCropHandles() {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    // DOM border overlay — not clipped by canvas, extends freely outside its bounds
    this._cropBorderEl = document.createElement("div");
    Object.assign(this._cropBorderEl.style, {
      position:      "absolute",
      border:        "1.5px solid #f59e0b",
      boxSizing:     "border-box",
      pointerEvents: "none",
      display:       "none",
      zIndex:        "14",
    });
    parent.appendChild(this._cropBorderEl);

    // Size label
    this._dimLabel = document.createElement("div");
    Object.assign(this._dimLabel.style, {
      position:       "absolute",
      background:     "rgba(0,0,0,0.72)",
      color:          "#fff",
      font:           "bold 11px/1.5 system-ui,sans-serif",
      padding:        "2px 7px",
      borderRadius:   "4px",
      pointerEvents:  "none",
      display:        "none",
      zIndex:         "20",
      whiteSpace:     "nowrap",
      transform:      "translateX(-50%)",
    });
    parent.appendChild(this._dimLabel);

    // 8 handles
    this._handleEls = [];
    for (let i = 0; i < 8; i++) {
      const el = document.createElement("div");
      Object.assign(el.style, {
        position:    "absolute",
        width:       "10px",
        height:      "10px",
        borderRadius: "50%",
        background:  "#ffffff",
        border:      "2px solid #f59e0b",
        boxSizing:   "border-box",
        transform:   "translate(-50%, -50%)",
        display:     "none",
        zIndex:      "15",
        cursor:      CROP_CURSORS[i],
      });
      el.addEventListener("pointerdown", (e) => this._handleElDown(e, i));
      parent.appendChild(el);
      this._handleEls.push(el);
    }
  }

  // A handle DOM element was clicked — start document-level drag
  _handleElDown(e, idx) {
    if (e.button !== 0 || !this.cropRect) return;
    e.preventDefault();
    e.stopPropagation();

    const startP = this._rawPosFromClient(e.clientX, e.clientY);
    const base   = { ...this.cropRect };

    const onMove = (me) => {
      const rp = this._rawPosFromClient(me.clientX, me.clientY);
      this.cropRect = this._moveCropHandle(base, idx, rp);
      this._updateCropHandlesAndLabel();
      this._positionCropConfirm();
      this.render();
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup",   onUp);
      this._emit();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup",   onUp);
  }

  _rawPosFromClient(cx, cy) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (cx - rect.left) * dpr / this.zoom,
      y: (cy - rect.top)  * dpr / this.zoom,
    };
  }

  _cropHandles(r) {
    return [
      { x: r.x,           y: r.y           }, // 0 TL
      { x: r.x + r.w / 2, y: r.y           }, // 1 T
      { x: r.x + r.w,     y: r.y           }, // 2 TR
      { x: r.x,           y: r.y + r.h / 2 }, // 3 L
      { x: r.x + r.w,     y: r.y + r.h / 2 }, // 4 R
      { x: r.x,           y: r.y + r.h     }, // 5 BL
      { x: r.x + r.w / 2, y: r.y + r.h     }, // 6 B
      { x: r.x + r.w,     y: r.y + r.h     }, // 7 BR
    ];
  }

  // Move handle to new position; returns normalized rect
  _moveCropHandle(base, idx, p) {
    const right = base.x + base.w, bottom = base.y + base.h;
    let { x, y, w, h } = base;
    switch (idx) {
      case 0: x = p.x; w = right - p.x;  y = p.y; h = bottom - p.y; break; // TL
      case 1:                             y = p.y; h = bottom - p.y; break; // T
      case 2: w = p.x - base.x;          y = p.y; h = bottom - p.y; break; // TR
      case 3: x = p.x; w = right - p.x;                             break; // L
      case 4: w = p.x - base.x;                                     break; // R
      case 5: x = p.x; w = right - p.x;           h = p.y - base.y; break; // BL
      case 6:                                      h = p.y - base.y; break; // B
      case 7: w = p.x - base.x;                   h = p.y - base.y; break; // BR
    }
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    return { x, y, w, h };
  }

  // Update handle DOM elements and size label
  _updateCropHandlesAndLabel() {
    if (!this.cropRect || !this._handleEls) return;
    const r  = this.cropRect;
    const handles = this._cropHandles(r);
    const ox = this.canvas.offsetLeft;
    const oy = this.canvas.offsetTop;
    const dpr = window.devicePixelRatio || 1;

    this._handleEls.forEach((el, i) => {
      el.style.left    = (ox + (handles[i].x * this.zoom / dpr)) + "px";
      el.style.top     = (oy + (handles[i].y * this.zoom / dpr)) + "px";
      el.style.display = "block";
    });

    if (this._cropBorderEl) {
      this._cropBorderEl.style.left    = (ox + (r.x * this.zoom / dpr)) + "px";
      this._cropBorderEl.style.top     = (oy + (r.y * this.zoom / dpr)) + "px";
      this._cropBorderEl.style.width   = (r.w * this.zoom / dpr) + "px";
      this._cropBorderEl.style.height  = (r.h * this.zoom / dpr) + "px";
      this._cropBorderEl.style.display = "block";
    }

    if (this._dimLabel) {
      const lx = ox + ((r.x + r.w / 2) * this.zoom / dpr);
      const ly = oy + ((r.y + r.h)     * this.zoom / dpr) + 12;
      this._dimLabel.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
      this._dimLabel.style.left    = lx + "px";
      this._dimLabel.style.top     = ly + "px";
      this._dimLabel.style.display = "block";
    }
  }

  _hideCropHandlesAndLabel() {
    this._handleEls?.forEach((el) => (el.style.display = "none"));
    if (this._dimLabel)     this._dimLabel.style.display     = "none";
    if (this._cropBorderEl) this._cropBorderEl.style.display = "none";
  }

  _updateCropCursor(p) {
    if (!this.cropRect) { this.canvas.style.cursor = "crosshair"; return; }
    const r = this.cropRect;
    if (p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
      this.canvas.style.cursor = "move";
    } else {
      this.canvas.style.cursor = "crosshair";
    }
  }

  // Selection: bounding box, handles, hit testing

  _rectFromPts(pts) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  _opBBox(op) {
    switch (op.type) {
      case "arrow":
      case "line": return this._rectFromPts([op.from, op.to]);
      case "rect":
      case "ellipse":
      case "star":
      case "triangle":
      case "diamond":
      case "pentagon":
      case "hexagon":
      case "blurbox": return this._normRect(op);
      case "marker": return this._rectFromPts(op.points);
      case "text": {
        const { ctx } = this;
        ctx.save();
        ctx.font = this._fontStr(op.fontSize, op.font || FONT_DEFAULT, op.bold, op.italic);
        const tw = ctx.measureText(op.text).width;
        ctx.restore();
        const pad = op.fontSize * 0.18;
        return {
          x: op.x, y: op.y,
          w: op.boxW ?? (tw + pad * 2),
          h: op.boxH ?? (op.fontSize * 1.4 + pad * 2),
        };
      }
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  _distToSeg(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  }

  _pointNearRectEdge(p, r, t) {
    const inOuter = p.x >= r.x - t && p.x <= r.x + r.w + t && p.y >= r.y - t && p.y <= r.y + r.h + t;
    const inInner = p.x >= r.x + t && p.x <= r.x + r.w - t && p.y >= r.y + t && p.y <= r.y + r.h - t;
    return inOuter && !inInner;
  }

  _hitOp(op, p) {
    const t = Math.max(8 / this.zoom, (op.size || 4) / 2 + 4);
    switch (op.type) {
      case "arrow":
      case "line": return this._distToSeg(p, op.from, op.to) <= t;
      case "marker": {
        const pts = op.points;
        for (let i = 1; i < pts.length; i++) {
          if (this._distToSeg(p, pts[i - 1], pts[i]) <= t) return true;
        }
        return false;
      }
      case "rect": return this._pointNearRectEdge(p, this._normRect(op), t);
      case "ellipse": {
        const r = this._normRect(op);
        if (r.w < 2 || r.h < 2) return false;
        const dx = (p.x - (r.x + r.w / 2)) / (r.w / 2);
        const dy = (p.y - (r.y + r.h / 2)) / (r.h / 2);
        const d = Math.sqrt(dx * dx + dy * dy);
        return (Math.abs(d - 1) * Math.min(r.w, r.h)) / 2 <= t;
      }
      case "text":
      case "star":
      case "triangle":
      case "diamond":
      case "pentagon":
      case "hexagon":
      case "blurbox": {
        const b = this._opBBox(op);
        return p.x >= b.x - 4 && p.x <= b.x + b.w + 4 && p.y >= b.y - 4 && p.y <= b.y + b.h + 4;
      }
    }
    return false;
  }

  _hitTest(p) {
    for (let i = this.ops.length - 1; i >= 0; i--) {
      if (this._hitOp(this.ops[i], p)) return i;
    }
    return -1;
  }

  _opHandles(op) {
    if (op.type === "arrow" || op.type === "line") return [op.from, op.to];
    if (["rect", "ellipse", "star", "triangle", "diamond", "pentagon", "hexagon", "blurbox", "text"].includes(op.type)) {
      const r = op.type === "text" ? this._opBBox(op) : this._normRect(op);
      return [
        { x: r.x,       y: r.y       }, { x: r.x + r.w, y: r.y       },
        { x: r.x,       y: r.y + r.h }, { x: r.x + r.w, y: r.y + r.h },
      ];
    }
    return [];
  }

  _rotHandle(op) {
    if (op.type !== "arrow") return null;
    const b = this._opBBox(op);
    return { x: b.x + b.w / 2, y: b.y - 28 / this.zoom };
  }

  // Draws only the rotation handle line+circle on canvas (arrows only).
  // The dashed border and corner handles are DOM elements via _updateSelectionOverlay.
  _drawSelection(op) {
    const rh = this._rotHandle(op);
    if (!rh) return;
    const { ctx, zoom } = this;
    const b   = this._opBBox(op);
    const pad = 5 / zoom + 3;
    const r   = Math.max(4, 5 / zoom);
    ctx.save();
    ctx.strokeStyle = "#f59e0b";
    ctx.lineWidth   = Math.max(1, 1 / zoom);
    ctx.beginPath();
    ctx.moveTo(b.x + b.w / 2, b.y - pad);
    ctx.lineTo(rh.x, rh.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(rh.x, rh.y, r, 0, Math.PI * 2);
    ctx.fillStyle = "#f59e0b";
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.restore();
  }

  _createSelectionOverlay() {
    const parent = this.canvas.parentElement;
    if (!parent) return;

    this._selBorderEl = document.createElement("div");
    Object.assign(this._selBorderEl.style, {
      position:      "absolute",
      border:        "1.5px dashed #f59e0b",
      boxSizing:     "border-box",
      pointerEvents: "none",
      display:       "none",
      zIndex:        "14",
    });
    parent.appendChild(this._selBorderEl);

    this._selHandleEls = [];
    for (let i = 0; i < 4; i++) {
      const el = document.createElement("div");
      Object.assign(el.style, {
        position:      "absolute",
        width:         "10px",
        height:        "10px",
        borderRadius:  "50%",
        background:    "#ffffff",
        border:        "2px solid #f59e0b",
        boxSizing:     "border-box",
        transform:     "translate(-50%, -50%)",
        pointerEvents: "none",
        display:       "none",
        zIndex:        "15",
      });
      parent.appendChild(el);
      this._selHandleEls.push(el);
    }
  }

  _updateSelectionOverlay() {
    const active = this.tool === "select" && this.selectedIdx >= 0 && !!this.ops[this.selectedIdx];
    if (!active) { this._hideSelectionOverlay(); return; }

    const op   = this.ops[this.selectedIdx];
    const b    = this._opBBox(op);
    const dpr  = window.devicePixelRatio || 1;
    const s    = this.zoom / dpr;
    const bgOx = this.bg?.enabled ? (this.bg.paddingLeft ?? 0) : 0;
    const bgOy = this.bg?.enabled ? (this.bg.paddingTop  ?? 0) : 0;
    const cx   = this.canvas.offsetLeft;
    const cy   = this.canvas.offsetTop;
    const pad  = 5 / this.zoom + 3;

    if (this._selBorderEl) {
      this._selBorderEl.style.left    = (cx + (bgOx + b.x - pad) * s) + "px";
      this._selBorderEl.style.top     = (cy + (bgOy + b.y - pad) * s) + "px";
      this._selBorderEl.style.width   = ((b.w + 2 * pad) * s) + "px";
      this._selBorderEl.style.height  = ((b.h + 2 * pad) * s) + "px";
      this._selBorderEl.style.display = "block";
    }

    const handles = this._opHandles(op);
    this._selHandleEls?.forEach((el, i) => {
      if (i < handles.length) {
        const h = handles[i];
        el.style.left    = (cx + (bgOx + h.x) * s) + "px";
        el.style.top     = (cy + (bgOy + h.y) * s) + "px";
        el.style.display = "block";
      } else {
        el.style.display = "none";
      }
    });
  }

  _hideSelectionOverlay() {
    if (this._selBorderEl) this._selBorderEl.style.display = "none";
    this._selHandleEls?.forEach((el) => (el.style.display = "none"));
  }

  deselect() {
    if (this.selectedIdx >= 0) {
      this.selectedIdx = -1;
      this.dragMode = null;
      this.render();
      this._emit();
    }
  }

  _switchToSelect(idx) {
    this.tool = "select";
    this.canvas.style.cursor = "default";
    this.selectedIdx = idx;
    this.render();
    this._emit();
  }

  _applyTranslate(op, base, dx, dy) {
    switch (op.type) {
      case "arrow": case "line": case "rect": case "ellipse": case "star":
      case "triangle": case "diamond": case "pentagon": case "hexagon": case "blurbox":
        op.from = { x: base.from.x + dx, y: base.from.y + dy };
        op.to   = { x: base.to.x   + dx, y: base.to.y   + dy };
        break;
      case "marker":
        op.points = base.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
        break;
      case "text":
        op.x = base.x + dx;
        op.y = base.y + dy;
        break;
    }
  }

  _applyHandle(op, base, idx, p) {
    if (op.type === "arrow" || op.type === "line") {
      if (idx === 0) op.from = { ...p }; else op.to = { ...p };
      return;
    }
    if (op.type === "text") {
      const b = this._opBBox(base);
      const corners = [
        { x: b.x,       y: b.y       }, { x: b.x + b.w, y: b.y       },
        { x: b.x,       y: b.y + b.h }, { x: b.x + b.w, y: b.y + b.h },
      ];
      const anchor = corners[3 - idx];
      op.x    = Math.min(anchor.x, p.x);
      op.y    = Math.min(anchor.y, p.y);
      op.boxW = Math.max(20, Math.abs(p.x - anchor.x));
      op.boxH = Math.max(20, Math.abs(p.y - anchor.y));
      op.fontSize = Math.max(6, Math.round(base.fontSize * op.boxH / b.h));
      return;
    }
    if (["rect", "ellipse", "star", "triangle", "diamond", "pentagon", "hexagon", "blurbox"].includes(op.type)) {
      const r = this._normRect(base);
      const corners = [
        { x: r.x, y: r.y },         { x: r.x + r.w, y: r.y },
        { x: r.x, y: r.y + r.h },   { x: r.x + r.w, y: r.y + r.h },
      ];
      op.from = { ...corners[3 - idx] };
      op.to   = { ...p };
    }
  }

  _recordModify(index, before) {
    const after = structuredClone(this.ops[index]);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      this.undoStack.push({ kind: "modify", index, before, after });
      this.redoStack = [];
    }
  }

  canDeleteSelection() { return this.tool === "select" && this.selectedIdx >= 0; }

  bringToFront() {
    if (this.selectedIdx < 0 || this.selectedIdx === this.ops.length - 1) return;
    const op = this.ops.splice(this.selectedIdx, 1)[0];
    this.ops.push(op);
    this.selectedIdx = this.ops.length - 1;
    this.render();
    this._emit();
  }

  sendToBack() {
    if (this.selectedIdx < 0 || this.selectedIdx === 0) return;
    const op = this.ops.splice(this.selectedIdx, 1)[0];
    this.ops.unshift(op);
    this.selectedIdx = 0;
    this.render();
    this._emit();
  }

  deleteSelected() {
    if (this.selectedIdx < 0) return;
    const op = this.ops.splice(this.selectedIdx, 1)[0];
    this.undoStack.push({ kind: "remove", index: this.selectedIdx, op: structuredClone(op) });
    this.redoStack = [];
    this.selectedIdx = -1;
    this.render();
    this._emit();
  }

  // Undo / redo

  _pushOp(op) {
    this.ops.push(op);
    this.undoStack.push({ kind: "op" });
    this.redoStack = [];
  }

  _pushRaster(prevBase, prevOps, nextBase, nextOps) {
    this.undoStack.push({ kind: "raster", prevBase, prevOps, nextBase, nextOps });
    this.redoStack = [];
  }

  _restoreBase(dataURL, opsAfter) {
    const img = new Image();
    img.onload = () => {
      this.baseCanvas.width = img.naturalWidth;
      this.baseCanvas.height = img.naturalHeight;
      this.bctx.clearRect(0, 0, this.baseCanvas.width, this.baseCanvas.height);
      this.bctx.drawImage(img, 0, 0);
      this.canvas.width = this.baseCanvas.width;
      this.canvas.height = this.baseCanvas.height;
      if (opsAfter) this.ops = opsAfter.slice();
      this.updateCanvasSize();
      this.fitZoom();
      this.render();
      this._emit();
    };
    img.src = dataURL;
  }

  undo() {
    this.cancelCrop();
    this.deselect();
    const a = this.undoStack.pop();
    if (!a) return;
    if (a.kind === "op") {
      this.redoStack.push({ kind: "op", op: this.ops.pop() });
      this.render();
    } else if (a.kind === "modify") {
      this.ops[a.index] = structuredClone(a.before);
      this.redoStack.push(a);
      this.render();
    } else if (a.kind === "remove") {
      this.ops.splice(a.index, 0, structuredClone(a.op));
      this.redoStack.push(a);
      this.render();
    } else {
      this.redoStack.push(a);
      this._restoreBase(a.prevBase, a.prevOps);
    }
    this._emit();
  }

  redo() {
    this.cancelCrop();
    this.deselect();
    const a = this.redoStack.pop();
    if (!a) return;
    if (a.kind === "op") {
      this.ops.push(a.op);
      this.undoStack.push({ kind: "op" });
      this.render();
    } else if (a.kind === "modify") {
      this.ops[a.index] = structuredClone(a.after);
      this.undoStack.push(a);
      this.render();
    } else if (a.kind === "remove") {
      this.ops.splice(a.index, 1);
      this.undoStack.push(a);
      this.render();
    } else {
      this.undoStack.push(a);
      this._restoreBase(a.nextBase, a.nextOps);
    }
    this._emit();
  }

  // Blur brush

  _startBlur(p) {
    this.blurPrevBase = this.baseCanvas.toDataURL();
    const block = Math.max(8, this.px() * 4);
    const tw = Math.max(1, Math.ceil(this.baseCanvas.width / block));
    const th = Math.max(1, Math.ceil(this.baseCanvas.height / block));
    const tmp = document.createElement("canvas");
    tmp.width = tw; tmp.height = th;
    tmp.getContext("2d").drawImage(this.baseCanvas, 0, 0, tw, th);
    this.pixelCanvas = document.createElement("canvas");
    this.pixelCanvas.width = this.baseCanvas.width;
    this.pixelCanvas.height = this.baseCanvas.height;
    const pc = this.pixelCanvas.getContext("2d");
    pc.imageSmoothingEnabled = false;
    pc.drawImage(tmp, 0, 0, tw, th, 0, 0, this.baseCanvas.width, this.baseCanvas.height);
    this.lastBlurPt = p;
    this._stampBlur(p);
  }

  _stampBlur(p) {
    const r = this.blurRadius();
    this.bctx.save();
    this.bctx.beginPath();
    this.bctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    this.bctx.clip();
    this.bctx.drawImage(this.pixelCanvas, 0, 0);
    this.bctx.restore();
  }

  _moveBlur(p) {
    const r = this.blurRadius();
    const dist = Math.hypot(p.x - this.lastBlurPt.x, p.y - this.lastBlurPt.y);
    const steps = Math.max(1, Math.ceil(dist / (r / 2)));
    for (let i = 1; i <= steps; i++) {
      this._stampBlur({
        x: this.lastBlurPt.x + ((p.x - this.lastBlurPt.x) * i) / steps,
        y: this.lastBlurPt.y + ((p.y - this.lastBlurPt.y) * i) / steps,
      });
    }
    this.lastBlurPt = p;
  }

  _endBlur() {
    this._pushRaster(this.blurPrevBase, null, this.baseCanvas.toDataURL(), null);
    this.blurPrevBase = null;
    this.pixelCanvas  = null;
    this.lastBlurPt   = null;
    this._emit();
  }

  // Crop apply / cancel

  applyCrop() {
    const r = this.cropRect;
    if (!r || r.w < 4 || r.h < 4) { this.cancelCrop(); return; }

    const prevBase = this.baseCanvas.toDataURL();
    const prevOps  = this.ops.slice();

    // Round all coords to integers to prevent white lines from sub-pixel rendering:
    // start rounds down, end rounds up.
    const x0 = Math.floor(r.x);
    const y0 = Math.floor(r.y);
    const x1 = Math.ceil(r.x + r.w);
    const y1 = Math.ceil(r.y + r.h);

    this.cropRect    = null;
    this.current     = null;
    this.selectedIdx = -1;
    this._hideCropHandlesAndLabel();
    this.render(); // saf kompozit

    const srcX0 = Math.max(0, x0);
    const srcY0 = Math.max(0, y0);
    const srcX1 = Math.min(this.canvas.width,  x1);
    const srcY1 = Math.min(this.canvas.height, y1);
    const outW  = Math.max(1, x1 - x0);
    const outH  = Math.max(1, y1 - y0);

    const out = document.createElement("canvas");
    out.width  = outW;
    out.height = outH;
    const oc = out.getContext("2d");

    if (srcX1 > srcX0 && srcY1 > srcY0) {
      oc.drawImage(
        this.canvas,
        srcX0, srcY0, srcX1 - srcX0, srcY1 - srcY0,
        srcX0 - x0, srcY0 - y0, srcX1 - srcX0, srcY1 - srcY0
      );
    }

    this.baseCanvas.width  = out.width;
    this.baseCanvas.height = out.height;
    this.bctx.drawImage(out, 0, 0);
    this.ops = [];
    if (this.bg) this.bg.enabled = false;
    this.updateCanvasSize();
    this._pushRaster(prevBase, prevOps, this.baseCanvas.toDataURL(), []);
    this._hideCropConfirm();
    this.fitZoom();
    this.render();
    this._emit();
  }

  _compositeDataURL() {
    const wasCrop     = this.cropRect;
    const wasCurrent  = this.current;
    const wasSelected = this.selectedIdx;
    this.cropRect    = null;
    this.current     = null;
    this.selectedIdx = -1;
    this.render();
    const url = this.canvas.toDataURL("image/png");
    this.cropRect    = wasCrop;
    this.current     = wasCurrent;
    this.selectedIdx = wasSelected;
    this.render();
    return url;
  }

  cancelCrop() {
    if (!this.cropRect && !this.current) return;
    this.cropRect       = null;
    this.current        = null;
    this.cropDragMode   = null;
    this.cropDragStart  = null;
    this.cropRectBefore = null;
    this._hideCropHandlesAndLabel();
    this._hideCropConfirm();
    this.render();
    this._emit();
  }

  _positionCropConfirm() {
    const el = this.cropConfirm;
    if (!el) return;
    const r = this.cropRect;
    if (r.x === 0 && r.y === 0 && r.w === this.canvas.width && r.h === this.canvas.height) {
      el.style.display = "none";
      return;
    }
    el.style.display = "flex";
    const dpr  = window.devicePixelRatio || 1;
    const ox   = this.bg?.enabled ? this.bg.paddingLeft : 0;
    const oy   = this.bg?.enabled ? this.bg.paddingTop  : 0;
    const bh   = el.offsetHeight || 40;
    const bw   = el.offsetWidth  || 160;

    const left     = ((ox + r.x + r.w) * this.zoom / dpr) - bw;
    const topBelow = ((oy + r.y + r.h) * this.zoom / dpr) + 8;
    const topAbove = ((oy + r.y)       * this.zoom / dpr) - bh - 8;

    // Check whether the label stays within the viewport
    const canvasTop = this.canvas.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top;
    const belowInVp = canvasTop + topBelow + bh;
    const top = belowInVp > this.viewport.clientHeight - 8 ? Math.max(0, topAbove) : topBelow;

    el.style.left = Math.max(0, left) + "px";
    el.style.top  = Math.max(0, top)  + "px";
  }

  _hideCropConfirm() {
    if (this.cropConfirm) this.cropConfirm.style.display = "none";
  }

  // Crop: mouse events (canvas level)

  // Canvas clicked (DOM handles capture their own events)
  _cropDown(p, e) {
    const r = this.cropRect;
    if (r) {
      // Inside rect + user-drawn rect → move
      if (!this._cropFresh && p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h) {
        this.cropDragMode   = "move";
        this.cropDragStart  = this._rawPos(e);
        this.cropRectBefore = { ...r };
        this.canvas.setPointerCapture(e.pointerId);
        this.canvas.style.cursor = "move";
        return;
      }
      // Fresh (default) rect or outside rect → clear, start new crop
      this.cropRect = null;
      this._hideCropHandlesAndLabel();
      this._hideCropConfirm();
    }
    this._cropFresh = false;
    // Draw new crop
    this.cropDragMode = "new";
    this.current = { type: "crop", from: { ...p }, to: { ...p } };
    this.canvas.setPointerCapture(e.pointerId);
    this.render();
  }

  _cropMove(e) {
    const rp = this._rawPos(e);
    const cp = this._pos(e);

    if (this.cropDragMode === "new") {
      if (this.current) { this.current.to = { ...cp }; this.render(); }
      return;
    }
    if (this.cropDragMode === "move") {
      const dx = rp.x - this.cropDragStart.x;
      const dy = rp.y - this.cropDragStart.y;
      this.cropRect = {
        x: this.cropRectBefore.x + dx, y: this.cropRectBefore.y + dy,
        w: this.cropRectBefore.w,      h: this.cropRectBefore.h,
      };
      this._updateCropHandlesAndLabel();
      this._positionCropConfirm();
      this.render();
      return;
    }
    // No drag → update cursor
    this._updateCropCursor(cp);
  }

  _cropUp() {
    if (this.cropDragMode === "new") {
      const op = this.current;
      this.current = null;
      const moved = op && (Math.abs(op.to.x - op.from.x) > 3 || Math.abs(op.to.y - op.from.y) > 3);
      if (moved) {
        this.cropRect = this._normRect(op);
      } else if (!this.cropRect) {
        // Click without drag → full-image crop rectangle
        this.cropRect = { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
      }
      if (this.cropRect) {
        this._updateCropHandlesAndLabel();
        this._positionCropConfirm();
      }
      this.render();
    }
    this.cropDragMode   = null;
    this.cropDragStart  = null;
    this.cropRectBefore = null;
    this.canvas.style.cursor = "crosshair";
    this._emit();
  }

  // Text tool

  _startText(p, editIdx = -1) {
    this.textPos      = p;
    this.editTextIdx  = editIdx;
    const op = editIdx >= 0 ? this.ops[editIdx] : null;
    const fs = op ? op.fontSize : this.textFontSize;
    const bg = op ? op.bg || "none" : this.textBg;
    const ti = this.textInput;
    ti.value          = op ? op.text : "";
    ti.style.display  = "block";
    const ox  = this.bg && this.bg.enabled ? this.bg.paddingLeft : 0;
    const oy  = this.bg && this.bg.enabled ? this.bg.paddingTop  : 0;
    const dpr = window.devicePixelRatio || 1;
    const pad  = fs * 0.18;
    const bh   = op?.boxH ?? (fs * 1.4 + pad * 2);
    const bw   = op?.boxW ?? null;
    const ha   = op?.textHAlign ?? this.textHAlign;
    const va   = op?.textVAlign ?? this.textVAlign;
    const inputY = va === "top"    ? p.y + pad
                 : va === "bottom" ? p.y + bh - fs - pad
                 :                   p.y + (bh - fs) / 2;
    const inputX = ha === "center" && bw ? p.x + bw / 2  // approximate; input auto-sizes
                 : ha === "right"  && bw ? p.x + bw - pad
                 :                         p.x + pad;
    ti.style.left     = ((inputX + ox) * this.zoom / dpr) + "px";
    ti.style.top      = ((inputY + oy) * this.zoom / dpr) + "px";
    ti.style.fontSize       = (fs * this.zoom / dpr) + "px";
    ti.style.fontFamily     = op ? op.font || FONT_DEFAULT : this.fontKind;
    ti.style.fontWeight     = (op ? (op.bold      ?? false) : this.fontBold)      ? "bold"      : "normal";
    ti.style.fontStyle      = (op ? (op.italic    ?? false) : this.fontItalic)    ? "italic"    : "normal";
    ti.style.textDecoration = (op ? (op.underline ?? false) : this.fontUnderline) ? "underline" : "none";
    ti.style.color          = op ? op.color : this.color;
    ti.style.background     = bg === "white" ? "#ffffff" : bg === "black" ? "#1b1b1b" : "transparent";
    setTimeout(() => ti.focus(), 0);
  }

  _commitText() {
    const text = this.textInput.value.trim();
    if (this.editTextIdx >= 0 && this.ops[this.editTextIdx]) {
      const before = structuredClone(this.ops[this.editTextIdx]);
      if (!text) {
        const op = this.ops.splice(this.editTextIdx, 1)[0];
        this.undoStack.push({ kind: "remove", index: this.editTextIdx, op: structuredClone(op) });
        this.redoStack = [];
        this.selectedIdx = -1;
      } else if (text !== before.text) {
        this.ops[this.editTextIdx].text = text;
        this._recordModify(this.editTextIdx, before);
      }
    } else if (text && this.textPos) {
      const fs  = this.textFontSize;
      this.ctx.save();
      this.ctx.font = this._fontStr(fs, this.fontKind, this.fontBold, this.fontItalic);
      const tw  = this.ctx.measureText(text).width;
      this.ctx.restore();
      const pad = fs * 0.18;
      this._pushOp({
        type: "text", text,
        x: this.textPos.x, y: this.textPos.y,
        boxW: tw + pad * 2,
        boxH: fs * 1.4 + pad * 2,
        textHAlign: this.textHAlign,
        textVAlign: this.textVAlign,
        color: this.color,
        fontSize: fs,
        font: this.fontKind,
        bg: this.textBg,
        bold: this.fontBold,
        italic: this.fontItalic,
        underline: this.fontUnderline,
      });
      this.textPos = null;
      this.editTextIdx = -1;
      this.textInput.style.display = "none";
      this._switchToSelect(this.ops.length - 1);
      return;
    }
    this.textPos = null;
    this.editTextIdx = -1;
    this.textInput.style.display = "none";
    this.render();
    this._emit();
  }

  // Mouse events

  // Convert to canvas coordinates — clamped to canvas bounds
  _pos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: Math.min(this.canvas.width,  Math.max(0, (e.clientX - rect.left) * dpr / this.zoom)),
      y: Math.min(this.canvas.height, Math.max(0, (e.clientY - rect.top)  * dpr / this.zoom)),
    };
  }

  // Convert to canvas coordinates — NO bounds clamping (for move/resize)
  _rawPos(e) {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (e.clientX - rect.left) * dpr / this.zoom,
      y: (e.clientY - rect.top)  * dpr / this.zoom,
    };
  }

  _onPointerDown(e) {
    if (e.button !== 0) return;
    if (this.textPos) { this._commitText(); return; }
    const p = this._pos(e);
    const ip = this._imgPos(e);

    if (this.tool === "select") { this._selectDown(ip, e); return; }
    if (this.tool === "crop")   { this._cropDown(p, e);   return; }

    if (this.cropRect) this.cancelCrop();
    this.selectedIdx = -1;

    if (this.tool === "text") { this._startText(ip); return; }

    this.drawing = true;
    this.canvas.setPointerCapture(e.pointerId);

    if (this.tool === "blur") {
      if (this.blurKind === "brush") {
        this._startBlur(ip);
        this.render();
      } else {
        this.current = { type: "blurbox", from: ip, to: ip, block: Math.max(8, this.px() * 4) };
        this.render();
      }
      return;
    }
    if (this.tool === "marker") {
      this.current = { type: "marker", color: this.color, size: this.px() * 2.2, points: [ip] };
    } else if (this.tool === "arrow") {
      this.current = { type: "arrow", kind: this.arrowKind, color: this.color, size: this.strokeSize, from: ip, to: ip };
    } else if (this.tool === "shape") {
      this.current = { type: this.shapeKind, color: this.color, size: this.strokeSize, from: ip, to: ip };
    }
    this.render();
  }

  _onPointerMove(e) {
    if (this.tool === "select") { this._selectMove(this._imgPos(e), e); return; }
    if (this.tool === "crop")   { this._cropMove(e);              return; }

    if (this.tool === "marker" || (this.tool === "blur" && this.blurKind === "brush")) {
      this.hoverPos = this._imgPos(e);
      if (!this.drawing) { this.render(); return; }
    }

    if (!this.drawing) return;

    const ip = this._imgPos(e);
    if (this.tool === "blur" && this.blurKind === "brush") {
      this._moveBlur(ip);
      this.render();
      return;
    }
    if (!this.current) return;
    if (this.current.type === "marker") {
      this.current.points.push(ip);
    } else {
      this.current.to = e.shiftKey ? this._snapAngle(this.current.from, ip) : ip;
    }
    this.render();
  }

  _snapAngle(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const angle = Math.atan2(dy, dx);
    const snapped = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);
    const dist = Math.hypot(dx, dy);
    return { x: from.x + dist * Math.cos(snapped), y: from.y + dist * Math.sin(snapped) };
  }

  _onPointerUp() {
    if (this.tool === "select") { this._selectUp(); return; }
    if (this.tool === "crop")   { this._cropUp();   return; }

    if (!this.drawing) return;
    this.drawing = false;

    if (this.tool === "blur" && this.blurKind === "brush") { this._endBlur(); return; }
    if (!this.current) return;

    let op = this.current;
    this.current = null;
    const moved =
      op.type === "marker"
        ? op.points.length > 2
        : Math.abs(op.to.x - op.from.x) > 3 || Math.abs(op.to.y - op.from.y) > 3;
    if (!moved) { this.render(); return; }

    // Brush straight-line correction
    if (op.type === "marker" && this._isStraightPath(op.points)) {
      op = { type: "line", color: op.color, size: op.size, from: op.points[0], to: op.points[op.points.length - 1] };
    }
    this._pushOp(op);
    if (this.tool !== "marker") {
      this._switchToSelect(this.ops.length - 1);
    } else {
      this.render();
      this._emit();
    }
  }

  _isStraightPath(points) {
    if (points.length < 3) return false;
    const first = points[0], last = points[points.length - 1];
    const totalDist = Math.hypot(last.x - first.x, last.y - first.y);
    if (totalDist < 25) return false;
    const threshold = Math.max(5, totalDist * 0.04);
    for (const pt of points) {
      if (this._distToSeg(pt, first, last) > threshold) return false;
    }
    return true;
  }

  _selectDown(p, e) {
    const op = this.ops[this.selectedIdx];
    if (op) {
      const ht = Math.max(10 / this.zoom, 8);
      // Rotation handle check (for arrow)
      const rh = this._rotHandle(op);
      if (rh && Math.hypot(p.x - rh.x, p.y - rh.y) <= ht) {
        this.dragMode   = "rotate";
        this.dragStart  = p;
        this.dragBefore = structuredClone(op);
        this.canvas.setPointerCapture(e.pointerId);
        return;
      }
      const handles = this._opHandles(op);
      for (let i = 0; i < handles.length; i++) {
        if (Math.hypot(p.x - handles[i].x, p.y - handles[i].y) <= ht) {
          this.dragMode   = "handle";
          this.dragHandle = i;
          this.dragStart  = p;
          this.dragBefore = structuredClone(op);
          this.canvas.setPointerCapture(e.pointerId);
          return;
        }
      }
    }
    const hit = this._hitTest(p);
    if (hit >= 0) {
      this.selectedIdx = hit;
      this.dragMode    = "move";
      this.dragStart   = p;
      this.dragBefore  = structuredClone(this.ops[hit]);
      this.canvas.setPointerCapture(e.pointerId);
    } else {
      this.selectedIdx = -1;
      this.dragMode    = "pan";
      this._panStart   = { x: e.clientX, y: e.clientY, sl: this.viewport.scrollLeft, st: this.viewport.scrollTop };
      this.canvas.setPointerCapture(e.pointerId);
      this._updateCursor();
    }
    this.render();
    this._emit();
  }

  _selectMove(p, e) {
    if (!this.dragMode) return;
    if (this.dragMode === "pan") {
      const ps = this._panStart;
      if (!ps) return;
      this.viewport.scrollLeft = ps.sl - (e.clientX - ps.x);
      this.viewport.scrollTop  = ps.st - (e.clientY - ps.y);
      return;
    }
    if (this.selectedIdx < 0) return;
    const op = this.ops[this.selectedIdx];
    if (this.dragMode === "move") {
      this._applyTranslate(op, this.dragBefore, p.x - this.dragStart.x, p.y - this.dragStart.y);
    } else if (this.dragMode === "rotate") {
      const cx = (this.dragBefore.from.x + this.dragBefore.to.x) / 2;
      const cy = (this.dragBefore.from.y + this.dragBefore.to.y) / 2;
      const a0 = Math.atan2(this.dragStart.y - cy, this.dragStart.x - cx);
      const a1 = Math.atan2(p.y - cy, p.x - cx);
      const da = a1 - a0;
      const cos = Math.cos(da), sin = Math.sin(da);
      const rot = (pt) => ({
        x: cx + (pt.x - cx) * cos - (pt.y - cy) * sin,
        y: cy + (pt.x - cx) * sin + (pt.y - cy) * cos,
      });
      op.from = rot(this.dragBefore.from);
      op.to   = rot(this.dragBefore.to);
    } else {
      this._applyHandle(op, this.dragBefore, this.dragHandle, p);
    }
    this.render();
  }

  _selectUp() {
    if (this.dragMode === "pan") {
      this.dragMode  = null;
      this._panStart = null;
      this._updateCursor();
      this._emit();
      return;
    }
    if (this.dragMode && this.selectedIdx >= 0 && this.dragBefore) {
      this._recordModify(this.selectedIdx, this.dragBefore);
    }
    this.dragMode   = null;
    this.dragBefore = null;
    this._emit();
  }

  _onDblClick(e) {
    if (this.tool !== "select") return;
    const ip = this._imgPos(e);
    const i = this._hitTest(ip);
    if (i >= 0 && this.ops[i].type === "text") {
      this.selectedIdx = i;
      this._startText({ x: this.ops[i].x, y: this.ops[i].y }, i);
    }
  }

  _zoomCenter(z) {
    const vp = this.viewport;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const vpRect = vp.getBoundingClientRect();
    const cx = vpRect.left + vp.clientWidth  / 2;
    const cy = vpRect.top  + vp.clientHeight / 2;
    const ix = (cx - rect.left) * dpr / this.zoom;
    const iy = (cy - rect.top)  * dpr / this.zoom;
    const old = this.zoom;
    this.setZoom(z);
    if (this.zoom !== old) {
      const nrect = this.canvas.getBoundingClientRect();
      vp.scrollLeft += nrect.left + (ix * this.zoom / dpr) - cx;
      vp.scrollTop  += nrect.top  + (iy * this.zoom / dpr) - cy;
    }
  }

  _onWheel(e) {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const ix = (e.clientX - rect.left) * dpr / this.zoom;
    const iy = (e.clientY - rect.top)  * dpr / this.zoom;
    const old = this.zoom;
    this.setZoom(this.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    if (this.zoom !== old) {
      const nrect = this.canvas.getBoundingClientRect();
      this.viewport.scrollLeft += nrect.left + (ix * this.zoom / dpr) - e.clientX;
      this.viewport.scrollTop  += nrect.top  + (iy * this.zoom / dpr) - e.clientY;
    }
  }

  // Cursor

  _brushCursor(canvasDiameter) {
    const dpr = window.devicePixelRatio || 1;
    const d   = Math.max(2, Math.round(canvasDiameter * this.zoom / dpr));
    if (d > 128) return "crosshair";
    const r   = d / 2;
    const pad = 2;
    const sz  = d + pad * 2;
    const c   = sz / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${sz}" height="${sz}">` +
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="rgba(0,0,0,0.55)" stroke-width="2.5"/>` +
      `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="white" stroke-width="1.2"/>` +
      `</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${c} ${c}, crosshair`;
  }

  _updateCursor() {
    const t = this.tool;
    if (t === "marker" || (t === "blur" && this.blurKind === "brush")) {
      this.canvas.style.cursor = "none";
    } else if (t === "select") {
      this.canvas.style.cursor = this.dragMode === "pan" ? "grabbing" : "default";
    } else {
      this.canvas.style.cursor = "crosshair";
    }
  }

  // Toolbar setters

  setTool(tool) {
    this.tool = tool;
    this.hoverPos = null;
    this._updateCursor();
    if (tool !== "select") this.deselect();
    if (tool !== "crop") {
      this.cancelCrop();
    } else {
      // When crop tool is selected, immediately show a full-image rect with handles
      this.cropRect = { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
      this._cropFresh = true;
      this._updateCropHandlesAndLabel();
      this._positionCropConfirm();
      this.render();
    }
    this._emit();
  }

  setCropRect(x, y, w, h) {
    this.tool = "crop";
    this.hoverPos = null;
    this._updateCursor();
    this.deselect();
    this.cropRect = { x, y, w, h };
    this._cropFresh = false;
    this._updateCropHandlesAndLabel();
    this._positionCropConfirm();
    this.render();
    this._emit();
  }

  setColor(c) {
    this.color = c;
    if (this.tool === "select" && this.selectedIdx >= 0) {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].color = c;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setSizeIdx(idx) {
    this.sizeIdx = idx;
    this._updateCursor();
    if (this.tool === "select" && this.selectedIdx >= 0) {
      const op = this.ops[this.selectedIdx];
      const before = structuredClone(op);
      if (op.type === "marker")  op.size = this.px() * 2.2;
      else if (op.type === "blurbox") op.block = Math.max(8, this.px() * 4);
      else op.size = this.px();
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setShapeKind(kind) {
    this.shapeKind = kind;
    if (this.tool === "select" && this.selectedIdx >= 0) {
      const op = this.ops[this.selectedIdx];
      if (["rect", "ellipse", "line", "star", "triangle", "diamond", "pentagon", "hexagon"].includes(op.type)) {
        const before = structuredClone(op);
        op.type = kind;
        this._recordModify(this.selectedIdx, before);
        this.render();
      }
    }
    this._savePrefs();
    this._emit();
  }

  setBlurKind(kind)  { this.blurKind  = kind; this._updateCursor(); this._savePrefs(); this._emit(); }

  setArrowKind(kind) {
    this.arrowKind = kind;
    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx].type === "arrow") {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].kind = kind;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setStrokeSize(px) {
    this.strokeSize = px;
    if (this.tool === "select" && this.selectedIdx >= 0) {
      const op = this.ops[this.selectedIdx];
      if (["arrow", "rect", "ellipse", "line", "star", "triangle", "diamond", "pentagon", "hexagon"].includes(op.type)) {
        const before = structuredClone(op);
        op.size = px;
        this._recordModify(this.selectedIdx, before);
        this.render();
      }
    }
    this._savePrefs();
    this._emit();
  }

  setFontKind(font) {
    this.fontKind = font;
    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx].type === "text") {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].font = font;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setFontBold(v) {
    this.fontBold = v;
    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx].type === "text") {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].bold = v;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setFontItalic(v) {
    this.fontItalic = v;
    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx].type === "text") {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].italic = v;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setFontUnderline(v) {
    this.fontUnderline = v;
    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx].type === "text") {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].underline = v;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setTextBg(bg) {
    this.textBg = bg;
    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx].type === "text") {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].bg = bg;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setTextFontSize(sz) {
    this.textFontSize = sz;
    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx].type === "text") {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].fontSize = sz;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setTextHAlign(align) {
    this.textHAlign = align;
    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx].type === "text") {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].textHAlign = align;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  setTextVAlign(align) {
    this.textVAlign = align;
    if (this.tool === "select" && this.selectedIdx >= 0 && this.ops[this.selectedIdx].type === "text") {
      const before = structuredClone(this.ops[this.selectedIdx]);
      this.ops[this.selectedIdx].textVAlign = align;
      this._recordModify(this.selectedIdx, before);
      this.render();
    }
    this._savePrefs();
    this._emit();
  }

  // Preferences (localStorage)

  _loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem("shotcove_prefs") || "{}");
      if (p.color)       this.color       = p.color;
      if (p.sizeIdx != null) this.sizeIdx = p.sizeIdx;
      if (p.strokeSize != null) this.strokeSize = p.strokeSize;
      if (p.fontKind)    this.fontKind    = p.fontKind;
      if (p.fontBold      != null) this.fontBold      = p.fontBold;
      if (p.fontItalic    != null) this.fontItalic    = p.fontItalic;
      if (p.fontUnderline != null) this.fontUnderline = p.fontUnderline;
      if (p.textFontSize) this.textFontSize = p.textFontSize;
      if (p.textBg)      this.textBg      = p.textBg;
      if (p.textHAlign)  this.textHAlign  = p.textHAlign;
      if (p.textVAlign)  this.textVAlign  = p.textVAlign;
      if (p.arrowKind)   this.arrowKind   = p.arrowKind;
      if (p.shapeKind)   this.shapeKind   = p.shapeKind;
      if (p.blurKind)    this.blurKind    = p.blurKind;
      if (p.bg) this.bg = { ...this.bg, ...p.bg, enabled: false };
    } catch {}
  }

  _savePrefs() {
    try {
      localStorage.setItem("shotcove_prefs", JSON.stringify({
        color:        this.color,
        sizeIdx:      this.sizeIdx,
        strokeSize:   this.strokeSize,
        fontKind:      this.fontKind,
        fontBold:      this.fontBold,
        fontItalic:    this.fontItalic,
        fontUnderline: this.fontUnderline,
        textFontSize:  this.textFontSize,
        textBg:        this.textBg,
        textHAlign:    this.textHAlign,
        textVAlign:    this.textVAlign,
        arrowKind:    this.arrowKind,
        shapeKind:    this.shapeKind,
        blurKind:     this.blurKind,
        bg: {
          type:          this.bg.type,
          color1:        this.bg.color1,
          color2:        this.bg.color2,
          color3:        this.bg.color3,
          angle:         this.bg.angle,
          paddingTop:    this.bg.paddingTop,
          paddingRight:  this.bg.paddingRight,
          paddingBottom: this.bg.paddingBottom,
          paddingLeft:   this.bg.paddingLeft,
          shadowEnabled: this.bg.shadowEnabled,
          borderRadius:  this.bg.borderRadius,
        },
      }));
    } catch {}
  }

  // Export

  exportData() {
    if (this.textPos) this._commitText();
    this.cancelCrop();
    return this._compositeDataURL().split(",")[1];
  }

  // Event binding / cleanup

  _bind() {
    this._h = {
      down:   (e) => this._onPointerDown(e),
      move:   (e) => this._onPointerMove(e),
      up:     ()  => this._onPointerUp(),
      dbl:    (e) => this._onDblClick(e),
      wheel:  (e) => this._onWheel(e),
      resize: () => {
        this.fitZoom();
        if (this.cropRect) {
          this._positionCropConfirm();
          this._updateCropHandlesAndLabel();
        }
      },
      tiKey: (e) => {
        e.stopPropagation();
        if (e.key === "Enter") this._commitText();
        if (e.key === "Escape") {
          this.textInput.value = "";
          this.textPos = null;
          this.editTextIdx = -1;
          this.textInput.style.display = "none";
          this.render();
        }
      },
      tiBlur: () => { if (this.textPos) this._commitText(); },
    };
    this.canvas.addEventListener("pointerdown",  this._h.down);
    this.canvas.addEventListener("pointermove",  this._h.move);
    this.canvas.addEventListener("pointerup",    this._h.up);
    this.canvas.addEventListener("dblclick",     this._h.dbl);
    this.canvas.addEventListener("pointerleave", () => {
      if (this.hoverPos) { this.hoverPos = null; this.render(); }
    });
    this.viewport.addEventListener("wheel",     this._h.wheel, { passive: false });
    window.addEventListener("resize",           this._h.resize);
    this.textInput.addEventListener("keydown",  this._h.tiKey);
    this.textInput.addEventListener("blur",     this._h.tiBlur);
  }

  dispose() {
    const h = this._h;
    if (h) {
      this.canvas.removeEventListener("pointerdown", h.down);
      this.canvas.removeEventListener("pointermove", h.move);
      this.canvas.removeEventListener("pointerup",   h.up);
      this.canvas.removeEventListener("dblclick",    h.dbl);
      this.viewport.removeEventListener("wheel",     h.wheel);
      window.removeEventListener("resize",           h.resize);
      this.textInput.removeEventListener("keydown",  h.tiKey);
      this.textInput.removeEventListener("blur",     h.tiBlur);
      this._h = null;
    }
    // Remove DOM crop elements
    this._handleEls?.forEach((el) => el.remove());
    this._dimLabel?.remove();
    this._cropBorderEl?.remove();
    this._handleEls    = null;
    this._dimLabel     = null;
    this._cropBorderEl = null;

    // Remove DOM selection overlay elements
    this._selBorderEl?.remove();
    this._selHandleEls?.forEach((el) => el.remove());
    this._selBorderEl  = null;
    this._selHandleEls = null;
  }
}
