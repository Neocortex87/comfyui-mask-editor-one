// v0.1.6
import { app } from "../../../scripts/app.js";
import { MaskEditorModal } from "./editor/MaskEditorModal.js";
import { t } from "./editor/i18n.js";
import { LayerManager } from "./editor/LayerManager.js";
import { CanvasCompositor } from "./editor/CanvasCompositor.js";
import { registerMaskPreviewCallback, unregisterMaskPreviewCallback, notifyMaskPreviewUpdate, persistBgImage, nextPreviewMode, previewButtonLabel } from "./editor/nodeState.js";

const _modalCache = new Map();

// ノードごとの BG 画像 file input（共有）
let _bgFileInput = null;
function _getBgFileInput() {
    if (!_bgFileInput) {
        _bgFileInput = document.createElement("input");
        _bgFileInput.type = "file";
        _bgFileInput.accept = "image/*";
        _bgFileInput.style.display = "none";
        document.body.appendChild(_bgFileInput);
    }
    return _bgFileInput;
}

function openMaskEditor(node) {
    let modal = _modalCache.get(node.id);
    if (!modal) {
        modal = new MaskEditorModal(node);
        _modalCache.set(node.id, modal);
    }
    modal.open();
}

function hideLayerDataWidget(node) {
    const w = node.widgets?.find(w => w.name === "layer_data");
    if (!w) return;
    if (w.element) {
        w.element.style.display = "none";
        w.element.style.height  = "0";
        w.element.style.overflow = "hidden";
    }
    w.draw = () => {};
    w.computeSize = () => [0, -4];
}

// BG 画像をサーバーキャッシュに送信
function _storeBgImage(nodeId, dataUrl, filename = "") {
    fetch("/mask_editor/store_image", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
            node_id:      String(nodeId),
            bg_image_b64: dataUrl,
            filename:     filename,
        }),
    }).catch(() => {});
}

// Paste (Clipspace): 選択中の画像を新しい BG として読み込む（マスクはリセット）
async function _pasteClipspaceImage(node, clipspace) {
    const img = clipspace.imgs?.[clipspace.selectedIndex];
    if (!img) return;
    const blob = await (await fetch(img.src)).blob();
    const name = new URL(img.src, location.href).searchParams.get("filename") || "clipspace.png";
    await _loadFileAsBg(node, new File([blob], name, { type: blob.type }));
}

// Image オブジェクトを非同期ロード
function _loadImage(src) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload  = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = src;
    });
}

// マスクプレビューを不透明なグレースケール canvas に変換
// （invert 時の PNG は白+アルファなので黒背景に合成する。invert=true で白黒反転）
function _maskToCanvas(img, invert) {
    const c = document.createElement("canvas");
    c.width  = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0);
    if (invert) {
        ctx.globalCompositeOperation = "difference";
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.globalCompositeOperation = "source-over";
    }
    return c;
}

// マスク画像の黒い部分に半透明の赤オーバーレイを生成
// エディタのクイックマスク表示と同じく、invert 時は描いた部分が赤くなる
function _makeMaskOverlay(maskImg) {
    const c = document.createElement("canvas");
    c.width  = maskImg.width;
    c.height = maskImg.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(maskImg, 0, 0);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    const d = data.data;
    for (let i = 0; i < d.length; i += 4) {
        d[i + 3] = (255 - d[i]) * 0.5;
        d[i] = 255; d[i + 1] = 0; d[i + 2] = 0;
    }
    ctx.putImageData(data, 0, 0);
    return c;
}

// ノードプレビューの高さ
const PREVIEW_H = 160;

app.registerExtension({
    name: "ComfyUI.MaskEditorOne",

    setup() {
        // 標準の Paste (Clipspace) は node.imgs とウィジェット値（layer_data 含む）をコピーするだけで
        // このノードの BG には反映されないため、MaskEditorOne のみ画像の読み込みに置き換える
        const ComfyApp = app.constructor;
        const origPaste = ComfyApp.pasteFromClipspace;
        ComfyApp.pasteFromClipspace = function (node) {
            if (node.comfyClass !== "MaskEditorOne") return origPaste.apply(this, arguments);
            if (ComfyApp.clipspace) _pasteClipspaceImage(node, ComfyApp.clipspace);
        };
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== "MaskEditorOne") return;

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = origOnNodeCreated ? origOnNodeCreated.apply(this, arguments) : undefined;
            const node = this;

            hideLayerDataWidget(node);

            // ─── convert_to_mask トグル（invert_mask の上） ──
            // 新しい画像の読み込み時に、画像の明るさから Layer 1 のマスクを生成するか。
            // エディタ専用の設定なので node.properties に保存し、widgets_values とプロンプトには含めない
            node.properties.convert_to_mask = true;
            const convertWidget = node.addWidget("toggle", "convert_to_mask", true,
                v => { node.properties.convert_to_mask = v; }, { serialize: false });
            convertWidget.serialize = false;
            node.widgets.splice(node.widgets.indexOf(convertWidget), 1);
            node.widgets.splice(node.widgets.findIndex(w => w.name === "invert_mask"), 0, convertWidget);
            node._convertWidget = convertWidget;

            // ─── マスクプレビューコールバック登録 ──────────
            // node オブジェクトをキーにする（onNodeCreated 時点では id=-1 のため id は使わない）
            registerMaskPreviewCallback(node, (maskDataUrl) => {
                node._maskDataUrl = maskDataUrl;
                _loadImage(maskDataUrl).then(img => {
                    node._maskImg = _maskToCanvas(img, false);
                    node._maskOverlay = _makeMaskOverlay(node._maskImg);
                    _resizeNode(node);
                    node.setDirtyCanvas(true, true);
                });
            });

            // ─── 状態 ──────────────────────────────────────
            node._bgDataUrl     = null;   // BG 選択画像の data URL
            node._bgImg         = null;   // BG Image オブジェクト
            node._maskDataUrl   = null;   // Apply 後のマスクプレビュー data URL
            node._maskImg       = null;   // マスク（グレースケール canvas）
            node._maskOverlay   = null;   // masked 表示用の半透明赤オーバーレイ canvas
            // 表示モード "image" | "mask" | "masked"。ワークフローに保存され、切り替え後も維持される
            node.properties.preview_mode = "masked";

            // ─── BG ボタン ─────────────────────────────────
            const bgWidget = node.addWidget("button", t("node.loadImage"), null, () => {
                const input = _getBgFileInput();
                input.onchange = null;
                input.onchange = async (e) => {
                    const file = e.target.files[0];
                    if (!file) return;
                    await _loadFileAsBg(node, file);
                    input.value = "";
                };
                input.click();
            });
            node._bgWidget = bgWidget;

            // ─── IMG / MASK / MASKED 切り替えボタン ────────
            // ボタン名は「次にクリックすると切り替わる先」を示す
            const viewWidget = node.addWidget("button", previewButtonLabel(node.properties.preview_mode), null, () => {
                node.properties.preview_mode = nextPreviewMode(node.properties.preview_mode);
                viewWidget.name = previewButtonLabel(node.properties.preview_mode);
                _resizeNode(node);
                node.setDirtyCanvas(true, true);
            });
            node._viewWidget = viewWidget;

            // ─── invert_mask 切り替えでプレビューを即時反転 ───
            // Apply 時の compositeGray と同じ結果（値 v → 255 - v）になる
            const invertWidget = node.widgets.find(w => w.name === "invert_mask");
            const origInvertCallback = invertWidget.callback;
            invertWidget.callback = function () {
                const res = origInvertCallback?.apply(this, arguments);
                if (node._maskImg) {
                    node._maskImg     = _maskToCanvas(node._maskImg, true);
                    node._maskOverlay = _makeMaskOverlay(node._maskImg);
                    node.setDirtyCanvas(true, true);
                }
                return res;
            };

            // ─── Edit Mask ボタン ──────────────────────────
            node._editMaskWidget = node.addWidget("button", t("node.editMask"), null, () => openMaskEditor(node));

            // ─── プレビュー描画（常時表示・ドロップゾーン兼用） ───
            node.onDrawForeground = function (ctx) {
                if (this.flags.collapsed) return;

                const margin = 6;
                const x = margin;
                const y = this.size[1] - PREVIEW_H - margin;
                const w = this.size[0] - margin * 2;
                const h = PREVIEW_H;

                ctx.fillStyle = "#111";
                ctx.fillRect(x, y, w, h);

                const mode = this.properties.preview_mode;
                const img = mode === "mask" ? this._maskImg : this._bgImg;
                if (img) {
                    const scale = Math.min(w / img.width, h / img.height);
                    const dw = img.width  * scale;
                    const dh = img.height * scale;
                    const dx = x + (w - dw) / 2;
                    const dy = y + (h - dh) / 2;
                    ctx.drawImage(img, dx, dy, dw, dh);
                    if (mode === "masked" && this._maskOverlay) {
                        ctx.drawImage(this._maskOverlay, dx, dy, dw, dh);
                    }

                    ctx.fillStyle = "rgba(0,0,0,0.55)";
                    ctx.fillRect(x, y, 52, 16);
                    ctx.fillStyle = "#ccc";
                    ctx.font = "10px sans-serif";
                    ctx.fillText(mode.toUpperCase(), x + 4, y + 11);
                } else {
                    ctx.strokeStyle = "#444";
                    ctx.lineWidth = 1;
                    ctx.setLineDash([4, 4]);
                    ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
                    ctx.setLineDash([]);
                    ctx.fillStyle = "#666";
                    ctx.font = "12px sans-serif";
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText("Drop image here", x + w / 2, y + h / 2);
                    ctx.textAlign = "left";
                    ctx.textBaseline = "alphabetic";
                }
            };

            // ─── プレビューエリアへのファイルドロップ ─────────
            const _cnvEl = app.canvas.canvas;

            const _onDragOver = (e) => {
                if (!e.dataTransfer?.items) return;
                const hasImg = [...e.dataTransfer.items].some(
                    it => it.kind === "file" && it.type.startsWith("image/")
                );
                if (!hasImg) return;
                const [gx, gy] = _graphPos(e);
                if (_inPreview(node, gx, gy)) {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "copy";
                }
            };

            const _onDrop = (e) => {
                const [gx, gy] = _graphPos(e);
                if (!_inPreview(node, gx, gy)) return;
                const file = [...(e.dataTransfer?.files ?? [])].find(
                    f => f.type.startsWith("image/")
                );
                if (!file) return;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                _loadFileAsBg(node, file);
            };

            _cnvEl.addEventListener("dragover", _onDragOver, { capture: true });
            _cnvEl.addEventListener("drop",     _onDrop,     { capture: true });
            node._cleanupDropHandlers = () => {
                _cnvEl.removeEventListener("dragover", _onDragOver, { capture: true });
                _cnvEl.removeEventListener("drop",     _onDrop,     { capture: true });
            };

            _resizeNode(node);
            return r;
        };

        // ComfyUI の自動プレビュー（onDrawBackground → updatePreviews → node.imgs）を抑制
        // onDrawBackground は毎フレーム呼ばれ nodeOutputStore から node.imgs を設定するため
        // onExecuted での null クリアでは効果がなく、ここで完全にスキップする必要がある
        nodeType.prototype.onDrawBackground = function () {
            // no-op: 独自プレビューは onDrawForeground で描画するため自動プレビューは不要
        };

        // ワークフロー読み込み後も layer_data を非表示に保つ
        const origOnConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function (info) {
            if (origOnConfigure) origOnConfigure.apply(this, arguments);
            hideLayerDataWidget(this);
            this._viewWidget.name = previewButtonLabel(this.properties.preview_mode);
            this._convertWidget.value = this.properties.convert_to_mask;
            _resizeNode(this);
            if (this.properties?.bg_image) _restoreBgImage(this, this.properties.bg_image);
            _restoreMaskPreview(this);
        };

        // ノード削除時にモーダルキャッシュ・コールバック・ドロップハンドラをクリア
        const origOnRemoved = nodeType.prototype.onRemoved;
        nodeType.prototype.onRemoved = function () {
            _modalCache.delete(this.id);
            unregisterMaskPreviewCallback(this);
            this._cleanupDropHandlers?.();
            if (origOnRemoved) origOnRemoved.apply(this, arguments);
        };
    },
});

// プレビューエリアは常時表示 — 常に PREVIEW_H を加算
function _resizeNode(node) {
    const base = node.computeSize();

    const currentWidth = node.size?.[0] ?? base[0];
    const currentHeight = node.size?.[1] ?? base[1];

    const minHeight = base[1] + PREVIEW_H + 8;

    // Preserve any manual resizing. Only grow the node if it is too
    // small to fit the widgets and preview area.
    node.size[0] = Math.max(currentWidth, base[0]);
    node.size[1] = Math.max(currentHeight, minHeight);
}

// イベント座標をグラフ座標に変換
function _graphPos(e) {
    const cnv = app.canvas.canvas;
    const rect = cnv.getBoundingClientRect();
    const ds   = app.canvas.ds;
    const ratio = cnv.width / rect.width;
    const cx = (e.clientX - rect.left) * ratio;
    const cy = (e.clientY - rect.top)  * ratio;
    return [cx / ds.scale - ds.offset[0], cy / ds.scale - ds.offset[1]];
}

// グラフ座標がノードのプレビューエリア内かどうか判定
function _inPreview(node, gx, gy) {
    if (node.flags?.collapsed) return false;
    const m = 6;
    return (
        gx >= node.pos[0] + m &&
        gx <= node.pos[0] + node.size[0] - m &&
        gy >= node.pos[1] + node.size[1] - PREVIEW_H - m &&
        gy <= node.pos[1] + node.size[1] - m
    );
}

// ファイルを BG 画像として読み込む（ボタン・ドロップ共用）
async function _loadFileAsBg(node, file) {
    return new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = async (ev) => {
            const dataUrl = ev.target.result;
            node._bgDataUrl   = dataUrl;
            node._bgImg       = await _loadImage(dataUrl);
            // layer_data をリセットするのでマスクプレビューも破棄
            node._maskImg     = null;
            node._maskOverlay = null;
            _storeBgImage(node.id, dataUrl, file.name);
            persistBgImage(node, file);
            const lw = node.widgets?.find(w => w.name === "layer_data");
            if (lw) lw.value = "{}";
            _resizeNode(node);
            node.setDirtyCanvas(true, true);
            _modalCache.get(node.id)?.reloadBackground(dataUrl);
            resolve();
        };
        reader.readAsDataURL(file);
    });
}

// ワークフローに保存された参照から BG 画像を復元（input フォルダから読み込み）
async function _restoreBgImage(node, bg) {
    const params = new URLSearchParams({ filename: bg.name, subfolder: bg.subfolder, type: "input" });
    const res = await fetch("/view?" + params).catch(() => null);
    if (!res?.ok) return;
    const blob = await res.blob();
    const dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = ev => resolve(ev.target.result);
        reader.readAsDataURL(blob);
    });
    node._bgDataUrl = dataUrl;
    node._bgImg     = await _loadImage(dataUrl);
    _storeBgImage(node.id, dataUrl, bg.filename);
    node.setDirtyCanvas(true, true);
}

// ワークフローに保存された layer_data からマスクプレビューを再生成
async function _restoreMaskPreview(node) {
    const value = node.widgets?.find(w => w.name === "layer_data")?.value;
    let json;
    try { json = JSON.parse(value); } catch { return; }
    if (!json?.layers?.length) return;
    const layerMgr = new LayerManager(json.width ?? 512, json.height ?? 512);
    await layerMgr.fromJSON(json);
    const inverted = !!node.widgets?.find(w => w.name === "invert_mask")?.value;
    const gray = new CanvasCompositor().compositeGray(layerMgr.layers, layerMgr.width, layerMgr.height, inverted);
    notifyMaskPreviewUpdate(node, gray.toDataURL("image/png"));
}

