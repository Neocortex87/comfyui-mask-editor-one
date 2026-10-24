import { BaseTool } from "./BaseTool.js";

const SETTINGS_KEY = "me-brush";

export class PaintTool extends BaseTool {
    constructor(drawCanvas, bgCanvas) {
        super(drawCanvas, bgCanvas);
        this.brushSize        = 30;
        this.hardness         = 0.85;
        this.spacing          = 0.25;   // stamp interval as fraction of brushSize
        this.angle            = 0;      // image brush rotation in degrees [0, 360)
        this.mode             = "add";  // "add" | "erase"
        this.brushImage       = null;   // HTMLImageElement | null
        this.brushName        = "Circle";
        this.sizeJitter       = false;  // randomise size per stamp
        this.sizeJitterAmount = 0.5;    // 0‥1 — fraction of brushSize that can be removed
        this.rotationJitter   = false;  // randomise rotation 0‥360° per stamp

        this._drawing     = false;
        this._lastX       = 0;
        this._lastY       = 0;

        // Scratch canvas for rendering a single stamp before reading its alpha
        this._scratch    = document.createElement("canvas");
        this._scratchCtx = this._scratch.getContext("2d", { willReadFrequently: true });

        // Cached stamp canvas; rebuilt when brush params change
        this._stamp      = null;
        this._stampSize  = 0;
        this._stampHard  = 0;
        this._stampImg   = null;

        this.loadSettings();
    }

    activate() {
        // カーソルはエディタ側でブラシサイズの円として描画する
        this.drawCanvas.style.cursor = "none";
    }

    deactivate() {
        this.drawCanvas.style.cursor = "";
        this._drawing = false;
    }

    /** Size and hardness are shared by all editors and survive page reloads. */
    loadSettings() {
        const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
        this.brushSize = saved.brushSize ?? this.brushSize;
        this.hardness  = saved.hardness ?? this.hardness;
    }

    saveSettings() {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ brushSize: this.brushSize, hardness: this.hardness }));
    }

    /** Set an image brush loaded from the library. */
    setImageBrush(img, name) {
        this.brushImage = img;
        this.brushName  = name;
        this._stamp     = null;
    }

    /** Reset to default circular brush. */
    clearImageBrush() {
        this.brushImage = null;
        this.brushName  = "Circle";
        this._stamp     = null;
    }

    onMouseDown(x, y) {
        this._drawing = true;
        this._lastX = x;
        this._lastY = y;
        this._applyStamps([this._renderStamp(x, y)]);
    }

    onMouseMove(x, y) {
        if (!this._drawing) return;
        const x0 = this._lastX, y0 = this._lastY;
        const dist  = Math.hypot(x - x0, y - y0);
        const steps = Math.ceil(dist / Math.max(1, this.brushSize * this.spacing));
        const stamps = [];
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            stamps.push(this._renderStamp(x0 + (x - x0) * t, y0 + (y - y0) * t));
        }
        this._applyStamps(stamps);
        this._lastX = x;
        this._lastY = y;
    }

    onMouseUp() {
        if (this._drawing) {
            this._drawing = false;
            this._notifyChange();
        }
    }

    onMouseLeave() {
        if (this._drawing) {
            this._drawing = false;
            this._notifyChange();
        }
    }

    // ── Stamping ─────────────────────────────────────────────────────

    /**
     * Render one stamp into the scratch canvas and return its alpha with its
     * position on the draw canvas: { left, top, w, h, data }.
     */
    _renderStamp(x, y) {
        const savedSize      = this.brushSize;
        const savedAngle     = this.angle;
        const savedStamp     = this._stamp;
        const savedStampSize = this._stampSize;
        if (this.sizeJitter) {
            this.brushSize = savedSize * (1 - Math.random() * this.sizeJitterAmount);
        }
        if (this.rotationJitter) {
            this.angle = Math.random() * 360;
        }

        let ext = this.brushSize / 2;
        if (this.brushImage) {
            const stamp = this._getStamp(Math.round(this.brushSize));
            ext = Math.hypot(stamp.width, stamp.height) / 2;
        }
        const left = Math.floor(x - ext) - 1;
        const top  = Math.floor(y - ext) - 1;
        const w    = Math.ceil(x + ext) + 1 - left;
        const h    = Math.ceil(y + ext) + 1 - top;
        this._scratch.width  = w;
        this._scratch.height = h;

        const origCtx = this.ctx;
        this.ctx = this._scratchCtx;
        if (this.brushImage) {
            this._paintImageBrush(x - left, y - top, "add");
        } else {
            this._paintCircle(x - left, y - top, "add");
        }
        this.ctx = origCtx;

        // Restore jittered state so the base stamp cache stays valid
        this.brushSize  = savedSize;
        this.angle      = savedAngle;
        this._stamp     = savedStamp;
        this._stampSize = savedStampSize;

        return { left, top, w, h, data: this._scratchCtx.getImageData(0, 0, w, h).data };
    }

    /**
     * Write stamps into the draw canvas taking the max of alpha (add) or capping
     * alpha at 1 - stamp (erase), so overlapping soft edges never build up beyond
     * the brush's own value — neither within a stroke nor over earlier strokes.
     */
    _applyStamps(stamps) {
        const cw = this.drawCanvas.width;
        const ch = this.drawCanvas.height;
        let x0 = cw, y0 = ch, x1 = 0, y1 = 0;
        for (const s of stamps) {
            x0 = Math.min(x0, s.left);
            y0 = Math.min(y0, s.top);
            x1 = Math.max(x1, s.left + s.w);
            y1 = Math.max(y1, s.top + s.h);
        }
        x0 = Math.max(0, x0); y0 = Math.max(0, y0);
        x1 = Math.min(cw, x1); y1 = Math.min(ch, y1);
        if (x0 >= x1 || y0 >= y1) return;

        const tw = x1 - x0, th = y1 - y0;
        const target = this.ctx.getImageData(x0, y0, tw, th);
        const t = target.data;
        const erase = this.mode === "erase";

        for (const s of stamps) {
            const sx0 = Math.max(0, x0 - s.left), sx1 = Math.min(s.w, x1 - s.left);
            const sy0 = Math.max(0, y0 - s.top),  sy1 = Math.min(s.h, y1 - s.top);
            for (let sy = sy0; sy < sy1; sy++) {
                let si = (sy * s.w + sx0) * 4 + 3;
                let ti = ((s.top + sy - y0) * tw + (s.left + sx0 - x0)) * 4;
                for (let sx = sx0; sx < sx1; sx++, si += 4, ti += 4) {
                    const a = s.data[si];
                    if (!a) continue;
                    if (erase) {
                        if (t[ti + 3] > 255 - a) t[ti + 3] = 255 - a;
                    } else if (t[ti + 3] < a) {
                        t[ti] = t[ti + 1] = t[ti + 2] = 255;
                        t[ti + 3] = a;
                    }
                }
            }
        }
        this.ctx.putImageData(target, x0, y0);
    }

    // ── Brush rendering ──────────────────────────────────────────────

    /**
     * Photoshop-compatible circle brush.
     * hardness controls where the opaque core ends and the feathered edge begins:
     *   hardness=1.0 → sharp, fully opaque circle
     *   hardness=0   → full soft feather from centre to edge
     */
    _paintCircle(x, y, forceMode) {
        const ctx  = this.ctx;
        const r    = this.brushSize / 2;
        const mode = forceMode ?? this.mode;

        ctx.globalCompositeOperation =
            mode === "erase" ? "destination-out" : "source-over";

        if (this.hardness >= 1.0) {
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = "white";
            ctx.fill();
        } else {
            // Inner opaque core up to r*hardness, then feather to edge
            const innerR = r * Math.max(0, Math.min(0.999, this.hardness));
            const grad   = ctx.createRadialGradient(x, y, innerR, x, y, r);
            grad.addColorStop(0, "rgba(255,255,255,1)");
            grad.addColorStop(1, "rgba(255,255,255,0)");
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();
        }

        ctx.globalCompositeOperation = "source-over";
    }

    _paintImageBrush(x, y, forceMode) {
        const ctx  = this.ctx;
        const size = Math.round(this.brushSize);
        const stamp = this._getStamp(size);
        const mode = forceMode ?? this.mode;

        ctx.globalCompositeOperation =
            mode === "erase" ? "destination-out" : "source-over";

        if (this.angle) {
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate((this.angle * Math.PI) / 180);
            ctx.drawImage(stamp, -stamp.width / 2, -stamp.height / 2);
            ctx.restore();
        } else {
            ctx.drawImage(stamp, Math.round(x - stamp.width / 2), Math.round(y - stamp.height / 2));
        }

        ctx.globalCompositeOperation = "source-over";
    }

    /**
     * Cached offscreen stamp canvas.
     * White pixels; alpha = luminance (image brush) or alpha channel value.
     * Aspect ratio of the source brush image is preserved; brushSize controls height.
     */
    _getStamp(size) {
        if (
            this._stamp &&
            this._stampSize  === size &&
            this._stampHard  === this.hardness &&
            this._stampImg   === this.brushImage
        ) {
            return this._stamp;
        }

        const img  = this.brushImage;
        const srcW = img.naturalWidth  || img.width;
        const srcH = img.naturalHeight || img.height;
        const aspect = (srcW > 0 && srcH > 0) ? srcW / srcH : 1;

        const stampH = size;
        const stampW = Math.max(1, Math.round(size * aspect));

        const canvas = document.createElement("canvas");
        canvas.width  = stampW;
        canvas.height = stampH;
        const stx = canvas.getContext("2d");

        stx.drawImage(img, 0, 0, stampW, stampH);

        const imgData = stx.getImageData(0, 0, stampW, stampH);
        const d = imgData.data;

        // Detect whether the image carries meaningful alpha information.
        // New ABR brushes are saved as RGBA (alpha = brush density).
        // Old/imported grayscale PNGs have no alpha; detect background colour
        // from corners to decide whether bright or dark pixels are the brush.
        let hasAlpha = false;
        for (let i = 3; i < d.length; i += 4) {
            if (d[i] < 250) { hasAlpha = true; break; }
        }

        let invertLum = false;
        if (!hasAlpha) {
            // Sample 4 corners to determine background luminance
            const cornerIdx = [0, stampW - 1, stampW * (stampH - 1), stampW * stampH - 1];
            let bgLum = 0;
            for (const ci of cornerIdx) {
                const ii = ci * 4;
                bgLum += (d[ii] * 0.299 + d[ii + 1] * 0.587 + d[ii + 2] * 0.114) / 255;
            }
            bgLum /= cornerIdx.length;
            // White background (bgLum > 0.5): dark pixels are the brush → invert
            invertLum = bgLum > 0.5;
        }

        for (let i = 0; i < d.length; i += 4) {
            let alpha;
            if (hasAlpha) {
                alpha = d[i + 3] / 255;
            } else {
                const lum = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) / 255;
                alpha = invertLum ? 1 - lum : lum;
            }
            d[i]     = 255;
            d[i + 1] = 255;
            d[i + 2] = 255;
            d[i + 3] = Math.round(alpha * 255);
        }
        stx.putImageData(imgData, 0, 0);

        this._stamp     = canvas;
        this._stampSize = size;
        this._stampHard = this.hardness;
        this._stampImg  = this.brushImage;

        return canvas;
    }
}
