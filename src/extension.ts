import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

export function activate(context: vscode.ExtensionContext) {
	console.log('vscode-pdf-docs activated');

	const providerRegistration = vscode.window.registerCustomEditorProvider(
		'vscode-pdf-docs.pdfPreview',
		new PdfReadonlyEditorProvider(context),
		{
			webviewOptions: {
				retainContextWhenHidden: true
			},
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
		const documentDir = vscode.Uri.file(dirname(document.uri.fsPath));
		const pdfUri = webviewPanel.webview.asWebviewUri(document.uri);

		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionContext.extensionUri, documentDir]
		};

		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		const postDocument = async () => {
			try {
				await webviewPanel.webview.postMessage({
					type: 'loadPdf',
					pdfUri: pdfUri.toString(),
					fileName: getFileName(document.uri)
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await webviewPanel.webview.postMessage({
					type: 'error',
					message: `Could not open PDF: ${message}`
				});
			}
		};

		const messageSubscription = webviewPanel.webview.onDidReceiveMessage(async (event) => {
			if (event?.type === 'ready') {
				await postDocument();
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
		:root {
			color-scheme: light dark;
		}
		body {
			margin: 0;
			font-family: var(--vscode-font-family);
			background: var(--vscode-editor-background);
			color: var(--vscode-editor-foreground);
			display: flex;
			flex-direction: column;
			min-height: 100vh;
		}
		.toolbar {
			display: flex;
			align-items: center;
			gap: 8px;
			padding: 8px;
			border-bottom: 1px solid var(--vscode-editorWidget-border);
			position: sticky;
			top: 0;
			background: var(--vscode-editor-background);
			z-index: 1;
		}
		.toolbar button {
			border: 1px solid var(--vscode-button-border, transparent);
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			padding: 4px 8px;
			cursor: pointer;
		}
		.toolbar button:hover {
			background: var(--vscode-button-hoverBackground);
		}
		.toolbar input {
			width: 56px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			padding: 3px 6px;
		}
		.filename {
			margin-left: auto;
			opacity: 0.8;
			font-size: 0.9em;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			max-width: 40vw;
		}
		.viewport {
			flex: 1;
			overflow: auto;
			display: grid;
			place-items: center;
			padding: 16px;
		}
		canvas {
			box-shadow: 0 8px 30px rgba(0, 0, 0, 0.24);
			background: white;
			max-width: 100%;
			height: auto;
		}
		.status {
			padding: 10px 12px;
			border-top: 1px solid var(--vscode-editorWidget-border);
			opacity: 0.85;
			min-height: 24px;
		}
	</style>
</head>
<body>
	<div class="toolbar">
		<button id="prev">Prev</button>
		<button id="next">Next</button>
		<label for="page">Page</label>
		<input id="page" type="number" min="1" value="1" />
		<span id="pageCount">/ 0</span>
		<button id="zoomOut">-</button>
		<button id="zoomIn">+</button>
		<button id="fit">Fit Width</button>
		<span id="zoomLabel">100%</span>
		<span id="filename" class="filename"></span>
	</div>
	<div class="viewport" id="viewport">
		<canvas id="canvas"></canvas>
	</div>
	<div class="status" id="status">Loading...</div>

	<script nonce="${nonce}" type="module">
		import * as pdfjsLib from '${pdfjsUri}';

		const vscode = acquireVsCodeApi();
		pdfjsLib.GlobalWorkerOptions.workerSrc = '${workerUri}';

		const statusEl = document.getElementById('status');
		const pageInput = document.getElementById('page');
		const pageCount = document.getElementById('pageCount');
		const zoomLabel = document.getElementById('zoomLabel');
		const filenameEl = document.getElementById('filename');
		const viewportEl = document.getElementById('viewport');
		const canvas = document.getElementById('canvas');
		const ctx = canvas.getContext('2d');

		let pdfDoc = null;
		let pageNum = 1;
		let zoom = 1.0;
		let fitMode = false;
		let renderTask = null;

		const updateStatus = (text) => {
			statusEl.textContent = text;
		};

		const updateToolbar = () => {
			pageInput.value = String(pageNum);
			pageCount.textContent = pdfDoc ? '/ ' + String(pdfDoc.numPages) : '/ 0';
			zoomLabel.textContent = Math.round(zoom * 100) + '%';
		};

		const renderPage = async () => {
			if (!pdfDoc || !ctx) {
				return;
			}

			if (renderTask) {
				try {
					renderTask.cancel();
				} catch {
					// Ignore cancellation race conditions.
				}
			}

			const page = await pdfDoc.getPage(pageNum);
			let scale = zoom;

			if (fitMode) {
				const viewportAt1 = page.getViewport({ scale: 1 });
				const padding = 32;
				scale = Math.max((viewportEl.clientWidth - padding) / viewportAt1.width, 0.2);
			}

			const viewport = page.getViewport({ scale });
			canvas.width = Math.floor(viewport.width);
			canvas.height = Math.floor(viewport.height);

			renderTask = page.render({ canvasContext: ctx, viewport });
			await renderTask.promise;
			renderTask = null;

			updateToolbar();
			updateStatus('Page ' + pageNum + ' of ' + pdfDoc.numPages);
		};

		const goToPage = async (targetPage) => {
			if (!pdfDoc) {
				return;
			}
			const bounded = Math.min(Math.max(targetPage, 1), pdfDoc.numPages);
			pageNum = bounded;
			await renderPage();
		};

		document.getElementById('prev').addEventListener('click', async () => {
			fitMode = false;
			await goToPage(pageNum - 1);
		});

		document.getElementById('next').addEventListener('click', async () => {
			fitMode = false;
			await goToPage(pageNum + 1);
		});

		document.getElementById('zoomOut').addEventListener('click', async () => {
			fitMode = false;
			zoom = Math.max(0.25, zoom - 0.1);
			await renderPage();
		});

		document.getElementById('zoomIn').addEventListener('click', async () => {
			fitMode = false;
			zoom = Math.min(4, zoom + 0.1);
			await renderPage();
		});

		document.getElementById('fit').addEventListener('click', async () => {
			fitMode = true;
			await renderPage();
		});

		pageInput.addEventListener('change', async () => {
			fitMode = false;
			const value = Number(pageInput.value);
			if (Number.isFinite(value)) {
				await goToPage(Math.round(value));
			}
		});

		window.addEventListener('resize', async () => {
			if (fitMode) {
				await renderPage();
			}
		});

		window.addEventListener('message', async (event) => {
			const message = event.data;

			if (message.type === 'error') {
				updateStatus(message.message || 'Unknown error');
				return;
			}

			if (message.type !== 'loadPdf' || !message.pdfUri) {
				return;
			}

			try {
				updateStatus('Opening PDF...');
				filenameEl.textContent = message.fileName || '';

				const loadingTask = pdfjsLib.getDocument(message.pdfUri);
				pdfDoc = await loadingTask.promise;
				pageNum = 1;
				zoom = 1;
				fitMode = false;
				await renderPage();
			} catch (error) {
				const messageText = error instanceof Error ? error.message : String(error);
				updateStatus('Failed to render PDF: ' + messageText);
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

	public dispose(): void {
		// No resources to release for readonly documents.
	}
}

function getFileName(uri: vscode.Uri): string {
	const lastSegment = uri.path.split('/').pop();
	return lastSegment ?? uri.path;
}
