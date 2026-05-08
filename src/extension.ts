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
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionContext.extensionUri]
		};

		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		const postDocument = async () => {
			try {
				const data = await vscode.workspace.fs.readFile(document.uri);
				const base64 = Buffer.from(data).toString('base64');
				await webviewPanel.webview.postMessage({
					type: 'loadPdf',
					base64,
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
		.toolbar input[type="range"] {
			width: 100px;
		}
		.filename {
			margin-right: auto;
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
			display: flex;
			flex-direction: column;
			align-items: center;
			padding: 16px;
			background: var(--vscode-editor-background);
		}
		canvas {
			box-shadow: 0 8px 30px rgba(0, 0, 0, 0.24);
			background: white;
			max-width: 100%;
			margin-bottom: 8px;
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
		<span id="filename" class="filename"></span>
		<button id="zoomOut">−</button>
		<input id="zoom" type="range" min="50" max="200" value="100" />
		<button id="zoomIn">+</button>
		<span id="zoomLabel">100%</span>
	</div>
	<div class="viewport" id="viewport"></div>
	<div class="status" id="status">Loading...</div>

	<script nonce="${nonce}" type="module">
		import * as pdfjsLib from '${pdfjsUri}';

		const vscode = acquireVsCodeApi();
		pdfjsLib.GlobalWorkerOptions.workerSrc = '${workerUri}';

		const statusEl = document.getElementById('status');
		const zoomLabel = document.getElementById('zoomLabel');
		const zoomInput = document.getElementById('zoom');
		const filenameEl = document.getElementById('filename');
		const viewportEl = document.getElementById('viewport');

		let pdfDoc = null;
		let zoom = 1.0;
		let renderTasks = [];

		const updateStatus = (text) => {
			statusEl.textContent = text;
		};

		const updateZoomLabel = () => {
			zoomLabel.textContent = Math.round(zoom * 100) + '%';
			zoomInput.value = Math.round(zoom * 100);
		};

		const renderAllPages = async () => {
			if (!pdfDoc) {
				return;
			}

			updateStatus('Rendering pages...');
			viewportEl.innerHTML = '';
			renderTasks = [];

			for (let pageIdx = 1; pageIdx <= pdfDoc.numPages; pageIdx += 1) {
				const pageDiv = document.createElement('div');
				pageDiv.style.textAlign = 'center';
				pageDiv.style.marginBottom = '16px';
				pageDiv.style.pageBreakAfter = 'always';

				const pageCanvas = document.createElement('canvas');
				viewportEl.appendChild(pageDiv);
				pageDiv.appendChild(pageCanvas);

				(async () => {
					try {
						const page = await pdfDoc.getPage(pageIdx);
						const viewport = page.getViewport({ scale: zoom });

						pageCanvas.width = Math.floor(viewport.width);
						pageCanvas.height = Math.floor(viewport.height);

						const ctx = pageCanvas.getContext('2d');
						if (!ctx) return;

						const renderTask = page.render({ canvasContext: ctx, viewport });
						renderTasks.push(renderTask);
						await renderTask.promise;
					} catch (error) {
						console.error('Failed to render page ' + pageIdx + ':', error);
					}
				})();
			}

			// Wait a bit for all renders to complete
			setTimeout(() => {
				updateStatus('Done');
			}, 1000);
		};

		document.getElementById('zoomOut').addEventListener('click', async () => {
			zoom = Math.max(0.25, zoom - 0.1);
			updateZoomLabel();
			await renderAllPages();
		});

		document.getElementById('zoomIn').addEventListener('click', async () => {
			zoom = Math.min(3, zoom + 0.1);
			updateZoomLabel();
			await renderAllPages();
		});

		zoomInput.addEventListener('change', async () => {
			zoom = Number(zoomInput.value) / 100;
			updateZoomLabel();
			await renderAllPages();
		});

		window.addEventListener('message', async (event) => {
			const message = event.data;

			if (message.type === 'error') {
				updateStatus(message.message || 'Unknown error');
				return;
			}

			if (message.type !== 'loadPdf' || !message.base64) {
				return;
			}

			try {
				updateStatus('Opening PDF...');
				filenameEl.textContent = message.fileName || '';

				const binary = atob(message.base64);
				const data = new Uint8Array(binary.length);
				for (let i = 0; i < binary.length; i += 1) {
					data[i] = binary.charCodeAt(i);
				}

				const loadingTask = pdfjsLib.getDocument({ data });
				pdfDoc = await loadingTask.promise;
				zoom = 1.0;
				updateZoomLabel();
				await renderAllPages();
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
