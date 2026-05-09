import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export function activate(context: vscode.ExtensionContext) {
const providerRegistration = vscode.window.registerCustomEditorProvider(
'vscode-pdf-docs.pdfPreview',
new PdfReadonlyEditorProvider(context),
{
webviewOptions: { retainContextWhenHidden: true },
supportsMultipleEditorsPerDocument: true
}
);
context.subscriptions.push(providerRegistration);
}

export function deactivate() {}

class PdfReadonlyEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
constructor(private readonly extensionContext: vscode.ExtensionContext) {}

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

const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (event) => {
if (event?.type !== 'ready') { return; }
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
});

webviewPanel.onDidDispose(() => {
messageSubscription.dispose();
document.dispose();
});
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

let pdfDoc = null;
let zoom = 1.0;
let renderedAtZoom = 1.0;
let rerenderTimer = null;
let renderGeneration = 0;

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
let best = 0, bestVis = -1;
for (let i = 0; i < slots.length; i++) {
const el = slots[i];
const elTop = el.offsetTop;
const elBot = elTop + el.offsetHeight;
const vis = Math.max(0, Math.min(elBot, bottom) - Math.max(elTop, top));
if (vis > bestVis) { bestVis = vis; best = i; }
}
return best;
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
const startIdx = getFirstVisiblePageIndex();
renderAllPages(zoom, startIdx);
}

async function renderAllPages(targetZoom, startIndex) {
if (!pdfDoc) { return; }
const gen = ++renderGeneration;
const selectionState = captureSelectionState();
const numPages = pdfDoc.numPages;
const first = Math.max(0, Math.min(startIndex !== undefined ? startIndex : 0, numPages - 1));

// Ensure correct number of slots (divs) in pagesEl - no layout change if count same
while (pagesEl.children.length < numPages) { pagesEl.appendChild(document.createElement('div')); }
while (pagesEl.children.length > numPages) { pagesEl.lastChild.remove(); }

// Render order: visible page first, then outward
const order = [first];
for (let d = 1; d < numPages; d++) {
if (first + d < numPages) { order.push(first + d); }
if (first - d >= 0) { order.push(first - d); }
}

// Render all pages into off-DOM canvases, then swap everything atomically
const rendered = new Map();
for (const idx of order) {
if (gen !== renderGeneration) { return; }

const slot = document.createElement('div');
slot.className = 'page-slot';
slot.dataset.pageIndex = String(idx);
const canvas = document.createElement('canvas');
const textLayer = document.createElement('div');
textLayer.className = 'textLayer';

try {
const page = await pdfDoc.getPage(idx + 1);
const vp = page.getViewport({ scale: targetZoom });

canvas.width = Math.floor(vp.width);
canvas.height = Math.floor(vp.height);
slot.style.width = canvas.width + 'px';
slot.style.height = canvas.height + 'px';
textLayer.style.width = canvas.width + 'px';
textLayer.style.height = canvas.height + 'px';
textLayer.style.setProperty('--scale-factor', String(targetZoom));

const ctx = canvas.getContext('2d');
if (!ctx) { continue; }
await page.render({ canvasContext: ctx, viewport: vp }).promise;

// Text layer is optional; it must not block image rendering.
try {
const textContent = await page.getTextContent();
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
console.warn('text layer disabled for page', idx + 1, textLayerError);
}
} catch (e) { console.error('render page', idx + 1, e); continue; }
if (gen !== renderGeneration) { return; }

if (textLayer.childNodes.length > 0) {
slot.replaceChildren(canvas, textLayer);
} else {
slot.replaceChildren(canvas);
}
rendered.set(idx, slot);
}
if (gen !== renderGeneration) { return; }
// All canvases ready - one synchronous block: update zoom, then swap all slots
renderedAtZoom = targetZoom;
pagesEl.style.gap = (16 * targetZoom) + 'px';
pagesEl.style.zoom = String(zoom / renderedAtZoom);
for (const [idx, slot] of rendered) {
pagesEl.children[idx].replaceChildren(slot);
}
restoreSelectionState(selectionState);
statusEl.textContent = Math.round(zoom * 100) + '%';
}

function scheduleRerender() {
if (rerenderTimer) { clearTimeout(rerenderTimer); }
rerenderTimer = setTimeout(() => {
rerenderTimer = null;
runRerenderNow();
}, RERENDER_DELAY_MS);
}

// --- zoom ---

function applyZoom(newZoom, mouseClientY) {
const prev = zoom;
zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
if (zoom === prev) { return; }

const rect = viewportEl.getBoundingClientRect();
const mouseY = mouseClientY !== undefined ? mouseClientY - rect.top : viewportEl.clientHeight / 2;
const docY = viewportEl.scrollTop + mouseY;
const prevScrollHeight = viewportEl.scrollHeight;

// CSS zoom is a layout property - scrollHeight updates synchronously
pagesEl.style.zoom = String(zoom / renderedAtZoom);

const newScrollHeight = viewportEl.scrollHeight;
viewportEl.scrollTop = docY * (newScrollHeight / Math.max(1, prevScrollHeight)) - mouseY;

statusEl.textContent = Math.round(zoom * 100) + '%';
scheduleRerender();
}

viewportEl.addEventListener('wheel', (e) => {
if (!e.ctrlKey) { return; }
e.preventDefault();
const factor = Math.exp(-e.deltaY * 0.002);
applyZoom(zoom * factor, e.clientY);
}, { passive: false });

// --- message from extension ---

window.addEventListener('message', async (event) => {
const msg = event.data;
if (msg.type === 'error') { statusEl.textContent = 'Error: ' + msg.message; return; }
if (msg.type !== 'loadPdf' || !msg.base64) { return; }

statusEl.textContent = 'Opening PDF...';
try {
const binary = atob(msg.base64);
const data = new Uint8Array(binary.length);
for (let i = 0; i < binary.length; i++) { data[i] = binary.charCodeAt(i); }
pdfDoc = await pdfjsLib.getDocument({ data }).promise;
zoom = 1.0;
renderedAtZoom = 1.0;
pagesEl.style.zoom = '1';
pagesEl.style.gap = '16px';
pagesEl.innerHTML = '';
await renderAllPages(zoom, 0);
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
