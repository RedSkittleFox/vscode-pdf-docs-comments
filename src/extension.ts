import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export function activate(context: vscode.ExtensionContext) {
const provider = new PdfReadonlyEditorProvider(context);
const providerRegistration = vscode.window.registerCustomEditorProvider(
'vscode-pdf-docs.pdfPreview',
provider,
{
webviewOptions: { retainContextWhenHidden: true },
supportsMultipleEditorsPerDocument: true
}
);

const goToPageCommand = vscode.commands.registerCommand('vscode-pdf-docs.goToPage', async () => {
const handled = await provider.triggerNativeGoToPageForActiveEditor();
if (!handled) {
void vscode.window.showInformationMessage('Open a PDF preview tab to use Go to Page.');
}
});
context.subscriptions.push(providerRegistration);
context.subscriptions.push(goToPageCommand);
}

export function deactivate() {}

class PdfReadonlyEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
constructor(private readonly extensionContext: vscode.ExtensionContext) {}

private activePanel: vscode.WebviewPanel | undefined;

public async openCustomDocument(uri: vscode.Uri): Promise<PdfDocument> {
return PdfDocument.create(uri);
}

public async resolveCustomEditor(
document: PdfDocument,
webviewPanel: vscode.WebviewPanel
): Promise<void> {
webviewPanel.webview.options = {
enableScripts: true,
localResourceRoots: [this.extensionContext.extensionUri]
};
webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

if (webviewPanel.active) {
this.activePanel = webviewPanel;
}

const panelStateSubscription = webviewPanel.onDidChangeViewState((event) => {
if (event.webviewPanel.active) {
this.activePanel = event.webviewPanel;
}
});

const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (event) => {
if (event?.type === 'ready') {
try {
const data = await vscode.workspace.fs.readFile(document.uri);
const base64 = Buffer.from(data).toString('base64');
await webviewPanel.webview.postMessage({
type: 'loadPdf',
base64,
fileName: document.uri.path.split('/').pop() ?? ''
});
} catch (error) {
const message = error instanceof Error ? error.message : String(error);
await webviewPanel.webview.postMessage({ type: 'error', message });
}
return;
}

if (event?.type === 'openGoToPageDialog') {
const currentPage = Number(event.currentPage ?? 1);
const totalPages = Number(event.totalPages ?? 1);
const value = await vscode.window.showInputBox({
title: 'Go to Page',
prompt: `Enter page number (1-${Math.max(1, totalPages)})`,
value: String(Math.max(1, currentPage)),
valueSelection: [0, String(Math.max(1, currentPage)).length],
validateInput: (input) => {
const match = input.trim().match(/^:?(\d+)$/);
if (!match) {
return 'Use format :number or number';
}
const page = Number(match[1]);
if (!Number.isFinite(page) || page < 1 || page > Math.max(1, totalPages)) {
return `Page must be between 1 and ${Math.max(1, totalPages)}`;
}
return null;
}
});

if (value === undefined) {
return;
}

const match = value.trim().match(/^:?(\d+)$/);
if (!match) {
return;
}

const page = Number(match[1]);
await webviewPanel.webview.postMessage({
type: 'goToPage',
page
});
}
});

webviewPanel.onDidDispose(() => {
panelStateSubscription.dispose();
if (this.activePanel === webviewPanel) {
this.activePanel = undefined;
}
messageSubscription.dispose();
document.dispose();
});
}

public async triggerNativeGoToPageForActiveEditor(): Promise<boolean> {
if (!this.activePanel) {
return false;
}

await this.activePanel.webview.postMessage({
type: 'requestNativeGoToPageDialog'
});
return true;
}

private getHtmlForWebview(webview: vscode.Webview): string {
const nonce = randomBytes(16).toString('base64');
const pdfjsUri = webview.asWebviewUri(
vscode.Uri.joinPath(this.extensionContext.extensionUri, 'node_modules', 'pdfjs-dist', 'build', 'pdf.mjs')
);
const workerUri = webview.asWebviewUri(
vscode.Uri.joinPath(this.extensionContext.extensionUri, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.mjs')
);

return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${webview.cspSource}; connect-src ${webview.cspSource};" />
<title>PDF Preview</title>
<style nonce="${nonce}">
* { box-sizing: border-box; }
html, body { margin: 0; width: 100%; height: 100%; background: var(--vscode-editor-background); }
#viewport {
width: 100%; height: 100%;
overflow: auto;
display: flex;
flex-direction: column;
align-items: center;
padding: 16px;
}
#pages {
display: flex;
flex-direction: column;
align-items: center;
gap: 16px;

}
.page-slot {
position: relative;
overflow: hidden;
display: flex;
justify-content: center;
align-items: flex-start;
}
canvas {
display: block;
box-shadow: 0 4px 20px rgba(0,0,0,0.3);
}
.textLayer {
position: absolute;
inset: 0;
overflow: hidden;
line-height: 1;
text-size-adjust: none;
-webkit-text-size-adjust: none;
transform-origin: 0 0;
z-index: 2;
user-select: text;
-webkit-user-select: text;
}
.textLayer span,
.textLayer br {
color: transparent;
position: absolute;
white-space: pre;
cursor: text;
transform-origin: 0 0;
user-select: text;
-webkit-user-select: text;
}
.textLayer ::selection {
background: rgba(0, 120, 215, 0.35);
}
#status {
position: fixed;
bottom: 8px;
left: 50%;
transform: translateX(-50%);
background: var(--vscode-editorWidget-background, #252526);
color: var(--vscode-editorWidget-foreground, #ccc);
padding: 4px 12px;
border-radius: 4px;
font-size: 12px;
font-family: var(--vscode-font-family, sans-serif);
pointer-events: none;
opacity: 0.9;
}
</style>
</head>
<body>
<div id="viewport">
<div id="pages"></div>
</div>
<div id="status">Loading...</div>
<script nonce="${nonce}" type="module">
import * as pdfjsLib from '${pdfjsUri}';
pdfjsLib.GlobalWorkerOptions.workerSrc = '${workerUri}';

const vscode = acquireVsCodeApi();
const viewportEl = document.getElementById('viewport');
const pagesEl = document.getElementById('pages');
const statusEl = document.getElementById('status');

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4.0;
const RERENDER_DELAY_MS = 400;
const LARGE_PDF_PAGE_COUNT = 200;
const LARGE_PDF_RERENDER_DELAY_MS = 650;
const VISIBLE_BUFFER_PAGES = 8;
const VISIBLE_RENDER_DEBOUNCE_MS = 120;
const UNLOAD_BUFFER_PAGES = 24;
const PAGE_CACHE_LIMIT = 256;
const TEXT_CACHE_LIMIT = 256;

let pdfDoc = null;
let zoom = 1.0;
let renderedAtZoom = 1.0;
let rerenderTimer = null;
let visibleRenderTimer = null;
let renderGeneration = 0;
let pendingZoomAnchor = null;
let previewScaleCurrent = 1.0;
let previewScaleTarget = 1.0;
let previewScaleRaf = null;
let pagePromiseCache = new Map();
let textContentCache = new Map();
let estimatedPageWidthAtScale1 = 800;
let estimatedPageHeightAtScale1 = 1131;
let pageSizeScale1ByIndex = new Map();
let renderedScaleByPage = new Map();

function pruneCache(cache, maxSize) {
while (cache.size > maxSize) {
const firstKey = cache.keys().next().value;
cache.delete(firstKey);
}
}

function clearRenderCaches() {
pagePromiseCache = new Map();
textContentCache = new Map();
pageSizeScale1ByIndex = new Map();
renderedScaleByPage = new Map();
}

function getPageCached(pageNumber) {
if (pagePromiseCache.has(pageNumber)) {
return pagePromiseCache.get(pageNumber);
}

const pagePromise = pdfDoc.getPage(pageNumber);
pagePromiseCache.set(pageNumber, pagePromise);
pruneCache(pagePromiseCache, PAGE_CACHE_LIMIT);
return pagePromise;
}

async function getTextContentCached(pageNumber) {
if (textContentCache.has(pageNumber)) {
return textContentCache.get(pageNumber);
}

const page = await getPageCached(pageNumber);
const textContentPromise = page.getTextContent();
textContentCache.set(pageNumber, textContentPromise);
pruneCache(textContentCache, TEXT_CACHE_LIMIT);
return textContentPromise;
}

function buildFallbackTextLayer(textLayer, textContent, viewport) {
if (!textContent?.items?.length) { return; }

for (const item of textContent.items) {
if (!item?.str) { continue; }

const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
const angle = Math.atan2(tx[1], tx[0]);
const fontHeight = Math.max(1, Math.hypot(tx[2], tx[3]));

const span = document.createElement('span');
span.textContent = item.str;
span.style.left = '0px';
span.style.top = '0px';
span.style.fontSize = fontHeight + 'px';
span.style.transform =
'translate(' + tx[4] + 'px,' + (tx[5] - fontHeight) + 'px) rotate(' + angle + 'rad)';

textLayer.appendChild(span);
}
}

// --- rendering ---

function getFirstVisiblePageIndex() {
const slots = pagesEl.children;
if (!slots.length) { return 0; }
const top = viewportEl.scrollTop;
const bottom = top + viewportEl.clientHeight;
const center = top + viewportEl.clientHeight / 2;
let best = 0, bestVis = -1;
let nearest = 0;
let nearestDistance = Number.POSITIVE_INFINITY;
for (let i = 0; i < slots.length; i++) {
const el = slots[i];
const elTop = el.offsetTop;
const elBot = elTop + el.offsetHeight;
const vis = Math.max(0, Math.min(elBot, bottom) - Math.max(elTop, top));
if (vis > bestVis) { bestVis = vis; best = i; }

const localCenter = elTop + el.offsetHeight / 2;
const dist = Math.abs(localCenter - center);
if (dist < nearestDistance) {
nearestDistance = dist;
nearest = i;
}
}
return bestVis > 0 ? best : nearest;
}

function getCurrentPageNumber() {
return getFirstVisiblePageIndex() + 1;
}

function getTotalPages() {
return pdfDoc?.numPages ?? 0;
}

function goToPage(pageNumber) {
if (!pdfDoc) { return; }
const target = Math.max(1, Math.min(pageNumber, pdfDoc.numPages));
const slot = pagesEl.children[target - 1];
if (!slot) { return; }

const viewportRect = viewportEl.getBoundingClientRect();
const slotRect = slot.getBoundingClientRect();
const nextScrollTop = viewportEl.scrollTop + (slotRect.top - viewportRect.top) - 8;
viewportEl.scrollTop = Math.max(0, nextScrollTop);
statusEl.textContent = 'Page ' + target + '/' + pdfDoc.numPages + ' - ' + Math.round(zoom * 100) + '%';
scheduleVisibleRender();
}

function requestNativeGoToPageDialog() {
if (!pdfDoc) { return; }
vscode.postMessage({
type: 'openGoToPageDialog',
currentPage: getCurrentPageNumber(),
totalPages: getTotalPages()
});
}

function hasActiveSelectionInPages() {
const selection = window.getSelection();
if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
return false;
}

const range = selection.getRangeAt(0);
const { startContainer, endContainer } = range;
return pagesEl.contains(startContainer) || pagesEl.contains(endContainer);
}

function getPageSlotFromNode(node) {
let el = node && node.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
while (el && !el.classList?.contains('page-slot')) {
el = el.parentElement;
}
return el || null;
}

function serializeRangePoint(node, offset) {
const slot = getPageSlotFromNode(node);
if (!slot) { return null; }

const textLayer = slot.querySelector('.textLayer');
if (!textLayer) { return null; }

const pageIndex = Number(slot.dataset.pageIndex || '-1');
if (pageIndex < 0) { return null; }

const probe = document.createRange();
try {
probe.setStart(textLayer, 0);
probe.setEnd(node, offset);
} catch {
return null;
}

return {
pageIndex,
charOffset: probe.toString().length
};
}

function captureSelectionState() {
if (!hasActiveSelectionInPages()) { return null; }
const selection = window.getSelection();
if (!selection || selection.rangeCount === 0) { return null; }

const range = selection.getRangeAt(0);
const start = serializeRangePoint(range.startContainer, range.startOffset);
const end = serializeRangePoint(range.endContainer, range.endOffset);
if (!start || !end) { return null; }

return { start, end };
}

function resolveRangePoint(point) {
const slot = pagesEl.querySelector('.page-slot[data-page-index="' + point.pageIndex + '"]');
if (!slot) { return null; }

const textLayer = slot.querySelector('.textLayer');
if (!textLayer) { return null; }

const walker = document.createTreeWalker(textLayer, NodeFilter.SHOW_TEXT);
let remaining = Math.max(0, point.charOffset);
let lastText = null;
while (walker.nextNode()) {
const node = walker.currentNode;
const len = node.textContent?.length || 0;
lastText = node;
if (remaining <= len) {
return { node, offset: remaining };
}
remaining -= len;
}

if (lastText) {
const len = lastText.textContent?.length || 0;
return { node: lastText, offset: len };
}

return null;
}

function restoreSelectionState(state) {
if (!state) { return; }
const start = resolveRangePoint(state.start);
const end = resolveRangePoint(state.end);
if (!start || !end) { return; }

const selection = window.getSelection();
if (!selection) { return; }

const range = document.createRange();
try {
range.setStart(start.node, start.offset);
range.setEnd(end.node, end.offset);
selection.removeAllRanges();
selection.addRange(range);
} catch {
// Ignore invalid range restoration.
}
}

function runRerenderNow() {
void rerenderAtCurrentZoom();
}

function ensureSlots(pageCount) {
while (pagesEl.children.length < pageCount) {
const slot = document.createElement('div');
slot.className = 'page-slot';
pagesEl.appendChild(slot);
}
while (pagesEl.children.length > pageCount) {
pagesEl.lastChild.remove();
}
for (let i = 0; i < pagesEl.children.length; i++) {
const slot = pagesEl.children[i];
slot.className = 'page-slot';
slot.dataset.pageIndex = String(i);
}
}

function applyLayoutForScale(scale) {
for (let i = 0; i < pagesEl.children.length; i++) {
const slot = pagesEl.children[i];
const baseSize = pageSizeScale1ByIndex.get(i);
const baseWidth = baseSize?.width ?? estimatedPageWidthAtScale1;
const baseHeight = baseSize?.height ?? estimatedPageHeightAtScale1;
slot.style.width = Math.max(1, Math.floor(baseWidth * scale)) + 'px';
slot.style.height = Math.max(1, Math.floor(baseHeight * scale)) + 'px';
}
}

function syncPageContentScaleCompensation() {
for (let i = 0; i < pagesEl.children.length; i++) {
const slot = pagesEl.children[i];
if (!slot) { continue; }

const content = slot.firstElementChild;
if (!content || !content.classList?.contains('page-content')) { continue; }

const pageScale = renderedScaleByPage.get(i);
if (!pageScale || Math.abs(pageScale - renderedAtZoom) < 0.0001) {
content.style.transform = '';
content.style.transformOrigin = '';
continue;
}

const compensation = renderedAtZoom / Math.max(0.0001, pageScale);
content.style.transformOrigin = 'top center';
content.style.transform = 'scale(' + compensation + ')';
}
}

function applyPreviewScaleTransform(scale) {
if (Math.abs(scale - 1.0) < 0.0001) {
pagesEl.style.transform = '';
pagesEl.style.transformOrigin = '';
return;
}
pagesEl.style.transformOrigin = 'top center';
pagesEl.style.transform = 'scale(' + scale + ')';
}

function getPreviewCenterX() {
return pagesEl.clientWidth / 2;
}

function baseToPreviewX(baseX, scale) {
const cx = getPreviewCenterX();
return baseX * scale + cx * (1 - scale);
}

function previewToBaseX(previewX, scale) {
const cx = getPreviewCenterX();
return (previewX - cx * (1 - scale)) / Math.max(0.0001, scale);
}

function syncPreviewScrollToAnchor() {
if (!pendingZoomAnchor) { return; }
const scale = Math.max(0.0001, previewScaleCurrent);
const left = baseToPreviewX(pendingZoomAnchor.docBaseX, scale) - pendingZoomAnchor.mouseX;
const top = pendingZoomAnchor.docBaseY * scale - pendingZoomAnchor.mouseY;
viewportEl.scrollLeft = Math.max(0, left);
viewportEl.scrollTop = Math.max(0, top);
}

function animatePreviewScale() {
if (previewScaleRaf !== null) { return; }

const tick = () => {
const delta = previewScaleTarget - previewScaleCurrent;
if (Math.abs(delta) < 0.001) {
previewScaleCurrent = previewScaleTarget;
applyPreviewScaleTransform(previewScaleCurrent);
syncPreviewScrollToAnchor();
previewScaleRaf = null;
return;
}

previewScaleCurrent += delta * 0.28;
applyPreviewScaleTransform(previewScaleCurrent);
syncPreviewScrollToAnchor();
previewScaleRaf = requestAnimationFrame(tick);
};

previewScaleRaf = requestAnimationFrame(tick);
}

function syncPreviewScaleTarget() {
previewScaleTarget = zoom / Math.max(0.0001, renderedAtZoom);
animatePreviewScale();
}

function getVisiblePageIndices() {
const indices = [];
const top = viewportEl.scrollTop;
const bottom = top + viewportEl.clientHeight;
for (let i = 0; i < pagesEl.children.length; i++) {
const slot = pagesEl.children[i];
const slotTop = slot.offsetTop;
const slotBottom = slotTop + slot.offsetHeight;
if (slotBottom >= top && slotTop <= bottom) {
indices.push(i);
}
}

if (!indices.length) {
indices.push(getFirstVisiblePageIndex());
}

const min = Math.max(0, Math.min(...indices) - VISIBLE_BUFFER_PAGES);
const max = Math.min(pagesEl.children.length - 1, Math.max(...indices) + VISIBLE_BUFFER_PAGES);
const out = [];
for (let i = min; i <= max; i++) {
out.push(i);
}
return out;
}

function unloadDistantSlots(visibleIndices) {
if (!visibleIndices.length) { return; }
if (!pdfDoc || pdfDoc.numPages < LARGE_PDF_PAGE_COUNT) { return; }
if (Math.abs(zoom - renderedAtZoom) > 0.0001) { return; }

const keepMin = Math.max(0, Math.min(...visibleIndices) - UNLOAD_BUFFER_PAGES);
const keepMax = Math.min(pagesEl.children.length - 1, Math.max(...visibleIndices) + UNLOAD_BUFFER_PAGES);
const viewportTop = viewportEl.scrollTop;
const viewportBottom = viewportTop + viewportEl.clientHeight;

for (let i = 0; i < pagesEl.children.length; i++) {
if (i >= keepMin && i <= keepMax) { continue; }
if (!renderedScaleByPage.has(i)) { continue; }

const slot = pagesEl.children[i];
if (!slot) { continue; }

const slotTop = slot.offsetTop;
const slotBottom = slotTop + slot.offsetHeight;
const intersectsViewport = slotBottom >= viewportTop && slotTop <= viewportBottom;
if (intersectsViewport) { continue; }

slot.replaceChildren();
renderedScaleByPage.delete(i);
}
}

async function renderPageIntoSlot(pageIndex, targetZoom, gen) {
if (gen !== renderGeneration) { return null; }
if (renderedScaleByPage.get(pageIndex) === targetZoom) { return null; }

const slot = pagesEl.children[pageIndex];
if (!slot) { return null; }

const content = document.createElement('div');
content.className = 'page-content';
content.style.position = 'relative';
content.style.margin = '0 auto';
const canvas = document.createElement('canvas');
const textLayer = document.createElement('div');
textLayer.className = 'textLayer';

const pageNumber = pageIndex + 1;
const page = await getPageCached(pageNumber);
const vp = page.getViewport({ scale: targetZoom });

const scale1Width = Math.max(1, vp.width / Math.max(0.0001, targetZoom));
const scale1Height = Math.max(1, vp.height / Math.max(0.0001, targetZoom));
pageSizeScale1ByIndex.set(pageIndex, {
width: scale1Width,
height: scale1Height
});

if (pageNumber === 1) {
const vpScale1 = page.getViewport({ scale: 1.0 });
estimatedPageWidthAtScale1 = Math.max(1, vpScale1.width);
estimatedPageHeightAtScale1 = Math.max(1, vpScale1.height);
}

canvas.width = Math.floor(vp.width);
canvas.height = Math.floor(vp.height);
// Keep slot layout size stable; only inner content follows exact page bitmap size.
content.style.width = canvas.width + 'px';
content.style.height = canvas.height + 'px';
textLayer.style.width = canvas.width + 'px';
textLayer.style.height = canvas.height + 'px';

const ctx = canvas.getContext('2d');
if (!ctx) { return null; }
await page.render({ canvasContext: ctx, viewport: vp }).promise;

try {
const textContent = await getTextContentCached(pageNumber);
if (typeof pdfjsLib.renderTextLayer === 'function') {
const textLayerTask = pdfjsLib.renderTextLayer({
textContent,
textContentSource: textContent,
container: textLayer,
viewport: vp,
textDivs: []
});
if (textLayerTask?.promise) {
await textLayerTask.promise;
}
}
if (textLayer.childNodes.length === 0) {
buildFallbackTextLayer(textLayer, textContent, vp);
}
} catch (textLayerError) {
console.warn('text layer disabled for page', pageNumber, textLayerError);
}

if (gen !== renderGeneration) { return null; }

if (textLayer.childNodes.length > 0) {
content.replaceChildren(canvas, textLayer);
} else {
content.replaceChildren(canvas);
}
return {
pageIndex,
slotWidth: canvas.width,
slotHeight: canvas.height,
content
};
}

function commitRenderedPages(renderedEntries, targetZoom) {
for (const entry of renderedEntries) {
const slot = pagesEl.children[entry.pageIndex];
if (!slot) { continue; }
slot.style.width = entry.slotWidth + 'px';
slot.style.height = entry.slotHeight + 'px';
slot.replaceChildren(entry.content);
renderedScaleByPage.set(entry.pageIndex, targetZoom);
}

syncPageContentScaleCompensation();
}

async function renderVisiblePages(targetZoom, gen, transitionCommit = false) {
const selectionState = captureSelectionState();
const indices = getVisiblePageIndices();
unloadDistantSlots(indices);
const renderedEntries = [];
for (const pageIndex of indices) {
if (gen !== renderGeneration) { return; }
try {
const renderedEntry = await renderPageIntoSlot(pageIndex, targetZoom, gen);
if (renderedEntry) {
renderedEntries.push(renderedEntry);
}
} catch (error) {
console.error('render page', pageIndex + 1, error);
}
}
if (gen !== renderGeneration) { return; }

if (renderedEntries.length > 0) {
await new Promise((resolve) => requestAnimationFrame(resolve));
if (gen !== renderGeneration) { return; }

// Do not commit pages rendered for an outdated zoom target.
if (Math.abs(zoom - targetZoom) > 0.0001) {
return;
}

if (transitionCommit) {
renderedAtZoom = targetZoom;
pagesEl.style.gap = (16 * renderedAtZoom) + 'px';
applyLayoutForScale(renderedAtZoom);
syncPageContentScaleCompensation();
}

commitRenderedPages(renderedEntries, targetZoom);
}

restoreSelectionState(selectionState);
statusEl.textContent = Math.round(zoom * 100) + '%';
}

async function rerenderAtCurrentZoom() {
if (!pdfDoc) { return; }
const targetZoom = zoom;
const gen = ++renderGeneration;
const fromRenderedZoom = renderedAtZoom;
const anchorSnapshot = pendingZoomAnchor
? {
mouseX: pendingZoomAnchor.mouseX,
mouseY: pendingZoomAnchor.mouseY,
docBaseX: pendingZoomAnchor.docBaseX,
docBaseY: pendingZoomAnchor.docBaseY,
fromRenderedZoom: pendingZoomAnchor.fromRenderedZoom
}
: null;

if (visibleRenderTimer) {
clearTimeout(visibleRenderTimer);
visibleRenderTimer = null;
}

const anchorX = viewportEl.clientWidth / 2;
const anchorY = viewportEl.clientHeight / 2;
const oldScrollWidth = Math.max(1, viewportEl.scrollWidth);
const oldScrollHeight = Math.max(1, viewportEl.scrollHeight);
const docX = viewportEl.scrollLeft + anchorX;
const docY = viewportEl.scrollTop + anchorY;

await renderVisiblePages(targetZoom, gen, true);
if (gen !== renderGeneration) { return; }

if (anchorSnapshot) {
const committedFromZoom = Math.max(0.0001, anchorSnapshot.fromRenderedZoom ?? fromRenderedZoom);
const commitRatio = targetZoom / committedFromZoom;
const newDocX = anchorSnapshot.docBaseX * commitRatio;
const newDocY = anchorSnapshot.docBaseY * commitRatio;
viewportEl.scrollLeft = Math.max(0, newDocX - anchorSnapshot.mouseX);
viewportEl.scrollTop = Math.max(0, newDocY - anchorSnapshot.mouseY);
pendingZoomAnchor = null;
} else {
const newScrollWidth = Math.max(1, viewportEl.scrollWidth);
const newScrollHeight = Math.max(1, viewportEl.scrollHeight);
viewportEl.scrollLeft = docX * (newScrollWidth / oldScrollWidth) - anchorX;
viewportEl.scrollTop = docY * (newScrollHeight / oldScrollHeight) - anchorY;
}

if (previewScaleRaf !== null) {
cancelAnimationFrame(previewScaleRaf);
previewScaleRaf = null;
}
previewScaleCurrent = 1.0;
previewScaleTarget = 1.0;
applyPreviewScaleTransform(1.0);
}

function scheduleRerender() {
if (rerenderTimer) { clearTimeout(rerenderTimer); }

const delay =
pdfDoc && pdfDoc.numPages >= LARGE_PDF_PAGE_COUNT
? LARGE_PDF_RERENDER_DELAY_MS
: RERENDER_DELAY_MS;

rerenderTimer = setTimeout(() => {
rerenderTimer = null;
runRerenderNow();
}, delay);
}

function scheduleVisibleRender() {
if (visibleRenderTimer) { clearTimeout(visibleRenderTimer); }

// Never render visible pages while zoom transition is in progress.
if (Math.abs(zoom - renderedAtZoom) > 0.0001) {
return;
}

visibleRenderTimer = setTimeout(() => {
visibleRenderTimer = null;
if (!pdfDoc) { return; }
if (Math.abs(zoom - renderedAtZoom) > 0.0001) { return; }
const gen = ++renderGeneration;
void renderVisiblePages(renderedAtZoom, gen);
}, VISIBLE_RENDER_DEBOUNCE_MS);
}

// --- zoom ---

function applyZoom(newZoom, mouseClientX, mouseClientY) {
const prev = zoom;
zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
if (zoom === prev) { return; }

// Cancel any in-flight render pipeline from previous zoom level.
renderGeneration += 1;
if (visibleRenderTimer) {
clearTimeout(visibleRenderTimer);
visibleRenderTimer = null;
}

const rect = viewportEl.getBoundingClientRect();
const mouseX = mouseClientX !== undefined ? mouseClientX - rect.left : viewportEl.clientWidth / 2;
const mouseY = mouseClientY !== undefined ? mouseClientY - rect.top : viewportEl.clientHeight / 2;
const currentScale = Math.max(0.0001, previewScaleCurrent);
const previewX = viewportEl.scrollLeft + mouseX;
const docBaseX = previewToBaseX(previewX, currentScale);
const docBaseY = (viewportEl.scrollTop + mouseY) / currentScale;
pendingZoomAnchor = {
mouseX,
mouseY,
docBaseX,
docBaseY,
fromRenderedZoom: renderedAtZoom
};

syncPreviewScaleTarget();
statusEl.textContent = Math.round(zoom * 100) + '%';
scheduleRerender();
}

viewportEl.addEventListener('wheel', (e) => {
if (!e.ctrlKey) { return; }
e.preventDefault();
const factor = Math.exp(-e.deltaY * 0.002);
applyZoom(zoom * factor, e.clientX, e.clientY);
}, { passive: false });

viewportEl.addEventListener('scroll', () => {
scheduleVisibleRender();
});

window.addEventListener('keydown', (e) => {
const isGoTo = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'g';
if (!isGoTo) { return; }
e.preventDefault();

requestNativeGoToPageDialog();
});

// --- message from extension ---

window.addEventListener('message', async (event) => {
const msg = event.data;
if (msg.type === 'error') { statusEl.textContent = 'Error: ' + msg.message; return; }
if (msg.type === 'requestNativeGoToPageDialog') {
requestNativeGoToPageDialog();
return;
}
if (msg.type === 'goToPage') {
const page = Number(msg.page);
if (Number.isFinite(page)) {
goToPage(page);
}
return;
}
if (msg.type !== 'loadPdf' || !msg.base64) { return; }

statusEl.textContent = 'Opening PDF...';
try {
const binary = atob(msg.base64);
const data = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) { data[i] = binary.charCodeAt(i); }
pdfDoc = await pdfjsLib.getDocument({ data }).promise;
clearRenderCaches();
zoom = 1.0;
renderedAtZoom = 1.0;
pendingZoomAnchor = null;
if (previewScaleRaf !== null) {
cancelAnimationFrame(previewScaleRaf);
previewScaleRaf = null;
}
previewScaleCurrent = 1.0;
previewScaleTarget = 1.0;
applyPreviewScaleTransform(1.0);
renderGeneration += 1;
pagesEl.style.gap = '16px';
ensureSlots(pdfDoc.numPages);
const firstPage = await getPageCached(1);
const firstVp = firstPage.getViewport({ scale: 1.0 });
estimatedPageWidthAtScale1 = Math.max(1, firstVp.width);
estimatedPageHeightAtScale1 = Math.max(1, firstVp.height);
applyLayoutForScale(1.0);
if (pdfDoc.numPages >= LARGE_PDF_PAGE_COUNT) {
statusEl.textContent = 'Opening large PDF (' + pdfDoc.numPages + ' pages)...';
}
await rerenderAtCurrentZoom();
} catch (e) {
statusEl.textContent = 'Failed: ' + (e instanceof Error ? e.message : String(e));
}
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
}

class PdfDocument implements vscode.CustomDocument {
private constructor(public readonly uri: vscode.Uri) {}
public static async create(uri: vscode.Uri): Promise<PdfDocument> {
return new PdfDocument(uri);
}
public dispose(): void {}
}
