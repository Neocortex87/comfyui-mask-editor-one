// ノード状態の共有ストア（maskEditor.js ↔ MaskEditorModal.js の循環 import を解消するため分離）
// WeakMap を使うことで onNodeCreated 時点の id=-1 問題を回避し、GC も自動処理される
import { t } from "./i18n.js";

const _callbacks = new WeakMap();

export function registerMaskPreviewCallback(node, fn) {
    _callbacks.set(node, fn);
}

export function unregisterMaskPreviewCallback(node) {
    _callbacks.delete(node);
}

export function notifyMaskPreviewUpdate(node, maskDataUrl) {
    const fn = _callbacks.get(node);
    if (fn) fn(maskDataUrl);
}

// BG 画像を input/mask_editor にアップロードし、参照をワークフロー（node.properties）に保存
// ワークフロー切り替え・再読み込み時に onConfigure で復元される
export function persistBgImage(node, file) {
    const body = new FormData();
    body.append("image", file);
    body.append("subfolder", "mask_editor");
    body.append("type", "input");
    return fetch("/upload/image", { method: "POST", body })
        .then(res => res.ok ? res.json() : null)
        .then(data => {
            if (data) node.properties.bg_image = { name: data.name, subfolder: data.subfolder, filename: file.name };
        })
        .catch(() => {});
}

// ノードプレビューの表示モード（ボタン名は次に切り替わるモードを示す）
const PREVIEW_MODES = ["image", "mask", "masked"];
const PREVIEW_LABEL_KEYS = { image: "node.showImage", mask: "node.showMask", masked: "node.showMasked" };

export function nextPreviewMode(mode) {
    return PREVIEW_MODES[(PREVIEW_MODES.indexOf(mode) + 1) % PREVIEW_MODES.length];
}

export function previewButtonLabel(mode) {
    return t(PREVIEW_LABEL_KEYS[nextPreviewMode(mode)]);
}
