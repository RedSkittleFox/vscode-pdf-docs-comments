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
transform-origin: top center;
}
canvas {
display: block;
box-shadow: 0 4px 20px rgba(0,0,0,0.3);
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

// --- rendering ---

async function renderAllPages(targetZoom) {
if (!pdfDoc) { return; }
const gen = ++renderGeneration;
statusEl.textContent = 'Rendering...';

const next = document.createDocumentFragment();
const canvases = [];

for (let i = 1; i <= pdfDoc.numPages; i++) {
if (gen !== renderGeneration) { return; }
const canvas = document.createElement('canvas');
canvases.push({ canvas, pageNum: i });
next.appendChild(canvas);
}

// swap immediately (blank canvases) so scrollHeight is correct
pagesEl.replaceChildren(next);
renderedAtZoom = targetZoom;
pagesEl.style.zoom = '1';

for (const { canvas, pageNum } of canvases) {
if (gen !== renderGeneration) { return; }
try {
const page = await pdfDoc.getPage(pageNum);
const vp = page.getViewport({ scale: targetZoom });
canvas.width = Math.floor(vp.width);
canvas.height = Math.floor(vp.height);
const ctx = canvas.getContext('2d');
if (!ctx) { continue; }
await page.render({ canvasContext: ctx, viewport: vp }).promise;
if (gen !== renderGeneration) { return; }
} catch (e) {
console.error('render page', pageNum, e);
}
}

if (gen === renderGeneration) {
// restore css zoom so visible scale stays correct
const cssZoom = zoom / renderedAtZoom;
pagesEl.style.zoom = String(cssZoom);
statusEl.textContent = Math.round(zoom * 100) + '%';
}
}

function scheduleRerender() {
if (rerenderTimer) { clearTimeout(rerenderTimer); }
rerenderTimer = setTimeout(() => {
rerenderTimer = null;
renderAllPages(zoom);
}, RERENDER_DELAY_MS);
}

// --- zoom ---

function applyZoom(newZoom, mouseClientY) {
const prev = zoom;
zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
if (zoom === prev) { return; }

// anchor: fraction of scrollHeight under mouse before scale change
const rect = viewportEl.getBoundingClientRect();
const mouseY = mouseClientY !== undefined ? mouseClientY - rect.top : viewportEl.clientHeight / 2;
const docY = viewportEl.scrollTop + mouseY;
const prevScrollHeight = viewportEl.scrollHeight;

// change css zoom (layout property - scrollHeight changes immediately)
const cssZoom = zoom / renderedAtZoom;
pagesEl.style.zoom = String(cssZoom);

// restore anchor
const newScrollHeight = viewportEl.scrollHeight;
const scale = newScrollHeight / Math.max(1, prevScrollHeight);
viewportEl.scrollTop = docY * scale - mouseY;

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
if (msg.type === 'error') {
statusEl.textContent = 'Error: ' + msg.message;
return;
}
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
await renderAllPages(zoom);
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
