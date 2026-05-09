import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as pdfjsModule from 'pdfjs-dist';

type PdfDarkModePreference = 'off' | 'on' | 'auto';
const DARK_MODE_SETTING_KEY = 'darkMode';

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

const toggleDarkModeCommand = vscode.commands.registerCommand('vscode-pdf-docs.toggleDarkMode', async () => {
	const configuration = vscode.workspace.getConfiguration('vscode-pdf-docs');
	const current = getDarkModePreference(configuration);
	const next: PdfDarkModePreference = current === 'on' ? 'off' : 'on';
	await configuration.update(DARK_MODE_SETTING_KEY, next, vscode.ConfigurationTarget.Global);
});

const showOutlineCommand = vscode.commands.registerCommand('vscode-pdf-docs.showOutline', async () => {
	const uri = provider.getActiveDocumentUri();
	if (!uri) {
		void vscode.window.showInformationMessage('Open a PDF preview tab to use Outline.');
		return;
	}

	const entries = await extractPdfOutlineEntries(uri);
	if (!entries.length) {
		void vscode.window.showInformationMessage('No table of contents found in this PDF.');
		return;
	}

	const picked = await vscode.window.showQuickPick(
		entries.map((entry) => ({
			label: entry.label,
			description: `Page ${entry.pageNumber}`,
			entry
		})),
		{
			placeHolder: 'Go to heading in PDF outline',
			matchOnDescription: true
		}
	);

	if (!picked) {
		return;
	}

	await provider.goToPageInActiveEditor(picked.entry.pageNumber);
});

const outlineTreeProvider = new PdfOutlineTreeProvider(() => provider.getActiveDocumentUri());
const outlineTreeRegistration = vscode.window.registerTreeDataProvider('pdfOutlineExplorer', outlineTreeProvider);

const revealOutlinePageCommand = vscode.commands.registerCommand(
	'vscode-pdf-docs.revealOutlinePage',
	async (item: PdfOutlineTreeItem) => {
		await provider.goToPageInActiveEditor(item.pageNumber);
	}
);

const copyOutlineSectionNameCommand = vscode.commands.registerCommand(
	'vscode-pdf-docs.copyOutlineSectionName',
	async (item: PdfOutlineTreeItem | undefined) => {
		if (!item) {
			return;
		}
		await vscode.env.clipboard.writeText(item.node.title);
	}
);

const copyOutlineFullPathCommand = vscode.commands.registerCommand(
	'vscode-pdf-docs.copyOutlineFullPath',
	async (item: PdfOutlineTreeItem | undefined) => {
		if (!item) {
			return;
		}
		await vscode.env.clipboard.writeText(item.node.fullPath);
	}
);

const copyOutlineSectionPathCommand = vscode.commands.registerCommand(
	'vscode-pdf-docs.copyOutlineSectionPath',
	async (item: PdfOutlineTreeItem | undefined) => {
		if (!item) {
			return;
		}
		const relativePath = toWorkspaceRelativePdfPath(vscode.Uri.file(item.node.pdfAbsolutePath));
		const reference = `@pdf(${relativePath}#outline=${item.node.fullPath})`;
		await vscode.env.clipboard.writeText(reference);
	}
);

const copyOutlineFullSectionPathCommand = vscode.commands.registerCommand(
	'vscode-pdf-docs.copyOutlineFullSectionPath',
	async (item: PdfOutlineTreeItem | undefined) => {
		if (!item) {
			return;
		}
		const reference = `@pdf(${item.node.pdfAbsolutePath}#outline=${item.node.fullPath})`;
		await vscode.env.clipboard.writeText(reference);
	}
);

const refreshOutlineCommand = vscode.commands.registerCommand('vscode-pdf-docs.refreshOutline', () => {
	outlineTreeProvider.refresh();
});

const tabChangeSubscription = vscode.window.tabGroups.onDidChangeTabs(() => {
	outlineTreeProvider.refresh();
});

const darkModeConfigSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
	if (!event.affectsConfiguration(`vscode-pdf-docs.${DARK_MODE_SETTING_KEY}`)) {
		return;
	}
	void provider.refreshDarkModeForPanels();
});

const colorThemeSubscription = vscode.window.onDidChangeActiveColorTheme(() => {
	void provider.refreshDarkModeForPanels();
});

const openPdfCommentReferenceCommand = vscode.commands.registerCommand(
	'vscode-pdf-docs.openPdfCommentReference',
	async (payload: PdfCommentReferencePayload | undefined) => {
		if (!payload) {
			return;
		}

		const sourceUri = vscode.Uri.parse(payload.sourceUri);
		const targetPdfUri = await resolvePdfReferenceUri(payload.pdfPath, sourceUri);
		if (!targetPdfUri) {
			void vscode.window.showWarningMessage(`Referenced PDF not found: ${payload.pdfPath}`);
			return;
		}

		let pageNumber = payload.pageNumber;
		if (!pageNumber && payload.outlineTitle) {
			const entries = await extractPdfOutlineEntries(targetPdfUri);
			const matched = findOutlineEntryByTitle(entries, payload.outlineTitle);
			if (matched) {
				pageNumber = matched.pageNumber;
			}
		}

		await provider.openDocumentAtPage(targetPdfUri, pageNumber ?? 1);
	}
);

const commentReferenceLinkProvider = new PdfCommentReferenceLinkProvider();
const commentReferenceRegistration = vscode.languages.registerDocumentLinkProvider(
	{ scheme: 'file' },
	commentReferenceLinkProvider
);

context.subscriptions.push(providerRegistration);
context.subscriptions.push(goToPageCommand);
context.subscriptions.push(toggleDarkModeCommand);
context.subscriptions.push(showOutlineCommand);
context.subscriptions.push(outlineTreeRegistration);
context.subscriptions.push(revealOutlinePageCommand);
context.subscriptions.push(copyOutlineSectionNameCommand);
context.subscriptions.push(copyOutlineFullPathCommand);
context.subscriptions.push(copyOutlineSectionPathCommand);
context.subscriptions.push(copyOutlineFullSectionPathCommand);
context.subscriptions.push(refreshOutlineCommand);
context.subscriptions.push(tabChangeSubscription);
context.subscriptions.push(darkModeConfigSubscription);
context.subscriptions.push(colorThemeSubscription);
context.subscriptions.push(openPdfCommentReferenceCommand);
context.subscriptions.push(commentReferenceRegistration);
}

export function deactivate() {}

function getDarkModePreference(configuration: vscode.WorkspaceConfiguration): PdfDarkModePreference {
	const raw = configuration.get<string>(DARK_MODE_SETTING_KEY, 'auto');
	if (raw === 'off' || raw === 'on' || raw === 'auto') {
		return raw;
	}
	return 'auto';
}

type PdfOutlineEntry = {
	title: string;
	fullPath: string;
	label: string;
	pageNumber: number;
};

type PdfCommentReferencePayload = {
	pdfPath: string;
	pageNumber?: number;
	outlineTitle?: string;
	sourceUri: string;
};

type ParsedPdfReference = {
	pdfPath: string;
	pageNumber?: number;
	outlineTitle?: string;
};

class PdfCommentReferenceLinkProvider implements vscode.DocumentLinkProvider {
	public provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
		const text = document.getText();
		const links: vscode.DocumentLink[] = [];
		const regex = /@pdf\(([^)\n]+)\)/g;
		let match: RegExpExecArray | null;

		while ((match = regex.exec(text)) !== null) {
			const spec = match[1]?.trim();
			if (!spec) {
				continue;
			}

			const parsed = parsePdfReferenceSpec(spec);
			if (!parsed) {
				continue;
			}

			const fullMatch = match[0];
			const specStartInMatch = fullMatch.indexOf(spec);
			const startOffset = match.index + Math.max(0, specStartInMatch);
			const endOffset = startOffset + spec.length;
			const range = new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));

			const payload: PdfCommentReferencePayload = {
				pdfPath: parsed.pdfPath,
				pageNumber: parsed.pageNumber,
				outlineTitle: parsed.outlineTitle,
				sourceUri: document.uri.toString()
			};

			const target = vscode.Uri.parse(
				`command:vscode-pdf-docs.openPdfCommentReference?${encodeURIComponent(JSON.stringify([payload]))}`
			);
			const link = new vscode.DocumentLink(range, target);
			link.tooltip = parsed.pageNumber
				? `Open ${parsed.pdfPath} page ${parsed.pageNumber}`
				: parsed.outlineTitle
					? `Open ${parsed.pdfPath} outline ${parsed.outlineTitle}`
					: `Open ${parsed.pdfPath}`;
			links.push(link);
		}

		return links;
	}
}

function parsePdfReferenceSpec(specRaw: string): ParsedPdfReference | undefined {
	const spec = specRaw.trim();
	if (!spec) {
		return undefined;
	}

	const hashIndex = spec.indexOf('#');
	const pdfPath = (hashIndex >= 0 ? spec.slice(0, hashIndex) : spec).trim();
	if (!pdfPath.toLowerCase().endsWith('.pdf')) {
		return undefined;
	}

	const fragmentRaw = hashIndex >= 0 ? spec.slice(hashIndex + 1).trim() : '';
	if (!fragmentRaw) {
		return { pdfPath };
	}

	const fragment = decodeURIComponent(fragmentRaw);
	const pageMatch = fragment.match(/^(?:page=|p=)?(\d+)$/i);
	if (pageMatch) {
		const pageNumber = Number(pageMatch[1]);
		if (Number.isFinite(pageNumber) && pageNumber > 0) {
			return { pdfPath, pageNumber };
		}
		return { pdfPath };
	}

	const outlineMatch = fragment.match(/^outline=(.+)$/i);
	if (outlineMatch && outlineMatch[1].trim()) {
		return { pdfPath, outlineTitle: outlineMatch[1].trim() };
	}

	if (fragment.trim()) {
		return { pdfPath, outlineTitle: fragment.trim() };
	}

	return { pdfPath };
}

async function resolvePdfReferenceUri(pdfPath: string, sourceUri: vscode.Uri): Promise<vscode.Uri | undefined> {
	const trimmed = pdfPath.trim();
	if (!trimmed) {
		return undefined;
	}

	const candidates: vscode.Uri[] = [];
	if (path.isAbsolute(trimmed)) {
		candidates.push(vscode.Uri.file(trimmed));
	} else {
		const sourceDir = path.dirname(sourceUri.fsPath);
		candidates.push(vscode.Uri.file(path.resolve(sourceDir, trimmed)));
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			candidates.push(vscode.Uri.file(path.resolve(folder.uri.fsPath, trimmed)));
		}
	}

	for (const candidate of candidates) {
		try {
			const stat = await vscode.workspace.fs.stat(candidate);
			if (stat.type === vscode.FileType.File) {
				return candidate;
			}
		} catch {
			// Try next candidate.
		}
	}

	return undefined;
}

function findOutlineEntryByTitle(entries: PdfOutlineEntry[], title: string): PdfOutlineEntry | undefined {
	const normalize = (value: string) => value.trim().toLowerCase().replace(/\s*>\s*/g, ' > ');
	const target = normalize(title);
	if (!target) {
		return undefined;
	}

	const exact = entries.find((entry) => normalize(entry.title) === target || normalize(entry.fullPath) === target);
	if (exact) {
		return exact;
	}

	return entries.find((entry) => {
		const titleNorm = normalize(entry.title);
		const pathNorm = normalize(entry.fullPath);
		return titleNorm.includes(target) || pathNorm.includes(target);
	});
}

function toWorkspaceRelativePdfPath(uri: vscode.Uri): string {
	const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
	if (!workspaceFolder) {
		return uri.fsPath;
	}
	const relative = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
	return relative || path.basename(uri.fsPath);
}

type PdfOutlineNode = {
	title: string;
	indentedTitle: string;
	fullPath: string;
	pdfAbsolutePath: string;
	pageNumber: number;
	children: PdfOutlineNode[];
};

class PdfOutlineTreeItem extends vscode.TreeItem {
	constructor(public readonly node: PdfOutlineNode) {
		super(
			node.title,
			node.children.length > 0
				? vscode.TreeItemCollapsibleState.Collapsed
				: vscode.TreeItemCollapsibleState.None
		);
		this.description = `Page ${node.pageNumber}`;
		this.tooltip = `${node.title} (Page ${node.pageNumber})`;
		this.contextValue = 'pdfOutlineItem';
		this.command = {
			command: 'vscode-pdf-docs.revealOutlinePage',
			title: 'Go to outline page',
			arguments: [this]
		};
	}

	get pageNumber(): number {
		return this.node.pageNumber;
	}
}

class PdfOutlineTreeProvider implements vscode.TreeDataProvider<PdfOutlineTreeItem> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<PdfOutlineTreeItem | undefined>();
	public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private loadedUriKey: string | undefined;
	private rootItems: PdfOutlineTreeItem[] = [];

	constructor(private readonly getActiveUri: () => vscode.Uri | undefined) {}

	public refresh(): void {
		this.loadedUriKey = undefined;
		this._onDidChangeTreeData.fire(undefined);
	}

	public getTreeItem(element: PdfOutlineTreeItem): vscode.TreeItem {
		return element;
	}

	public async getChildren(element?: PdfOutlineTreeItem): Promise<PdfOutlineTreeItem[]> {
		if (element) {
			return element.node.children.map((child) => new PdfOutlineTreeItem(child));
		}

		const uri = this.getActiveUri();
		if (!uri) {
			this.rootItems = [];
			this.loadedUriKey = undefined;
			return [];
		}

		const key = uri.toString();
		if (this.loadedUriKey !== key) {
			const nodes = await extractPdfOutlineTree(uri);
			this.rootItems = nodes.map((node) => new PdfOutlineTreeItem(node));
			this.loadedUriKey = key;
		}

		return this.rootItems;
	}
}

async function extractPdfOutlineEntries(uri: vscode.Uri): Promise<PdfOutlineEntry[]> {
	const data = await vscode.workspace.fs.readFile(uri);
	const bytes = new Uint8Array(data);
	const pdfDoc = await (pdfjsModule as any).getDocument({ data: bytes }).promise;
	const outline = await pdfDoc.getOutline();
	if (!outline || !Array.isArray(outline)) {
		return [];
	}

	const pageIndexCache = new Map<string, number>();

	const resolvePageNumber = async (destRaw: unknown): Promise<number | undefined> => {
		if (!destRaw) {
			return undefined;
		}

		let dest = destRaw as any;
		if (typeof dest === 'string') {
			dest = await pdfDoc.getDestination(dest);
		}

		if (!Array.isArray(dest) || dest.length < 1) {
			return undefined;
		}

		const pageRef = dest[0];
		if (typeof pageRef === 'number') {
			return pageRef + 1;
		}

		if (pageRef && typeof pageRef === 'object') {
			const key = JSON.stringify(pageRef);
			const cached = pageIndexCache.get(key);
			if (cached !== undefined) {
				return cached + 1;
			}
			const resolved = await pdfDoc.getPageIndex(pageRef);
			pageIndexCache.set(key, resolved);
			return resolved + 1;
		}

		return undefined;
	};

	const entries: PdfOutlineEntry[] = [];

	const collect = async (items: any[], level: number, parentPath: string): Promise<void> => {
		for (const item of items) {
			if (!item || typeof item.title !== 'string' || !item.title.trim()) {
				continue;
			}

			const pageNumber = (await resolvePageNumber(item.dest)) ?? 1;
			const title = item.title.trim();
			const fullPath = parentPath ? `${parentPath} > ${title}` : title;
			const prefix = '  '.repeat(Math.min(level, 6));
			entries.push({
				title,
				fullPath,
				label: `${prefix}${title}`,
				pageNumber
			});

			if (Array.isArray(item.items) && item.items.length > 0) {
				await collect(item.items, level + 1, fullPath);
			}
		}
	};

	await collect(outline, 0, '');
	return entries;
}

async function extractPdfOutlineTree(uri: vscode.Uri): Promise<PdfOutlineNode[]> {
	const data = await vscode.workspace.fs.readFile(uri);
	const bytes = new Uint8Array(data);
	const pdfDoc = await (pdfjsModule as any).getDocument({ data: bytes }).promise;
	const outline = await pdfDoc.getOutline();
	if (!outline || !Array.isArray(outline)) {
		return [];
	}

	const pageIndexCache = new Map<string, number>();

	const resolvePageNumber = async (destRaw: unknown): Promise<number | undefined> => {
		if (!destRaw) {
			return undefined;
		}

		let dest = destRaw as any;
		if (typeof dest === 'string') {
			dest = await pdfDoc.getDestination(dest);
		}

		if (!Array.isArray(dest) || dest.length < 1) {
			return undefined;
		}

		const pageRef = dest[0];
		if (typeof pageRef === 'number') {
			return pageRef + 1;
		}

		if (pageRef && typeof pageRef === 'object') {
			const key = JSON.stringify(pageRef);
			const cached = pageIndexCache.get(key);
			if (cached !== undefined) {
				return cached + 1;
			}
			const resolved = await pdfDoc.getPageIndex(pageRef);
			pageIndexCache.set(key, resolved);
			return resolved + 1;
		}

		return undefined;
	};

	const mapNodes = async (items: any[], level: number, parentPath: string): Promise<PdfOutlineNode[]> => {
		const out: PdfOutlineNode[] = [];
		for (const item of items) {
			if (!item || typeof item.title !== 'string' || !item.title.trim()) {
				continue;
			}

			const title = item.title.trim();
			const fullPath = parentPath ? `${parentPath} > ${title}` : title;
			const indent = '  '.repeat(Math.min(level, 8));
			const children = Array.isArray(item.items) && item.items.length > 0
				? await mapNodes(item.items, level + 1, fullPath)
				: [];

			out.push({
				title,
				indentedTitle: `${indent}${title}`,
				fullPath,
				pdfAbsolutePath: uri.fsPath,
				pageNumber: (await resolvePageNumber(item.dest)) ?? 1,
				children
			});
		}
		return out;
	};

	return mapNodes(outline, 0, '');
}

class PdfReadonlyEditorProvider implements vscode.CustomReadonlyEditorProvider<PdfDocument> {
constructor(private readonly extensionContext: vscode.ExtensionContext) {}

	private activePanel: vscode.WebviewPanel | undefined;
	private readonly panelDocumentByPanel = new Map<vscode.WebviewPanel, vscode.Uri>();
	private readonly pendingPageByDocumentKey = new Map<string, number>();

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

this.panelDocumentByPanel.set(webviewPanel, document.uri);

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
const key = document.uri.toString();
const initialPage = this.pendingPageByDocumentKey.get(key);
const darkModePreference = getDarkModePreference(vscode.workspace.getConfiguration('vscode-pdf-docs'));
const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
	|| vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
if (initialPage !== undefined) {
	this.pendingPageByDocumentKey.delete(key);
}
await webviewPanel.webview.postMessage({
type: 'loadPdf',
base64,
fileName: document.uri.path.split('/').pop() ?? '',
initialPage,
darkModePreference,
isDarkTheme
});
} catch (error) {
const message = error instanceof Error ? error.message : String(error);
await webviewPanel.webview.postMessage({ type: 'error', message });
}
return;
}

if (event?.type === 'openExternalUrl') {
const rawUrl = typeof event.url === 'string' ? event.url.trim() : '';
if (!rawUrl) {
return;
}

try {
const uri = vscode.Uri.parse(rawUrl);
if (!['http', 'https', 'mailto'].includes(uri.scheme)) {
return;
}
await vscode.env.openExternal(uri);
} catch {
// Ignore malformed URLs from PDF annotations.
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
	this.panelDocumentByPanel.delete(webviewPanel);
messageSubscription.dispose();
document.dispose();
});
}

public getActiveDocumentUri(): vscode.Uri | undefined {
	if (!this.activePanel) {
		return undefined;
	}
	return this.panelDocumentByPanel.get(this.activePanel);
}

private getPanelForDocument(uri: vscode.Uri): vscode.WebviewPanel | undefined {
	for (const [panel, panelUri] of this.panelDocumentByPanel) {
		if (panelUri.toString() === uri.toString()) {
			return panel;
		}
	}
	return undefined;
}

public async openDocumentAtPage(uri: vscode.Uri, page: number): Promise<void> {
	const targetPage = Math.max(1, Math.floor(page));
	const existing = this.getPanelForDocument(uri);
	if (existing) {
		this.activePanel = existing;
		existing.reveal(existing.viewColumn, false);
		await existing.webview.postMessage({ type: 'goToPage', page: targetPage });
		return;
	}

	this.pendingPageByDocumentKey.set(uri.toString(), targetPage);
	await vscode.commands.executeCommand('vscode.openWith', uri, 'vscode-pdf-docs.pdfPreview');
}

public async goToPageInActiveEditor(page: number): Promise<boolean> {
	if (!this.activePanel) {
		return false;
	}

	await this.activePanel.webview.postMessage({
		type: 'goToPage',
		page
	});
	return true;
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

public async refreshDarkModeForPanels(): Promise<void> {
	const darkModePreference = getDarkModePreference(vscode.workspace.getConfiguration('vscode-pdf-docs'));
	const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark
		|| vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;

	for (const panel of this.panelDocumentByPanel.keys()) {
		await panel.webview.postMessage({
			type: 'setDarkModePreference',
			darkModePreference,
			isDarkTheme
		});
	}
}

public async triggerNativeToggleDarkModeForActiveEditor(): Promise<boolean> {
	if (!this.activePanel) {
		return false;
	}

	await this.activePanel.webview.postMessage({
		type: 'toggleDarkMode'
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
padding: 16px;
}
#pages {
display: flex;
flex-direction: column;
align-items: center;
width: max-content;
margin: 0 auto;
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
body.dark-mode {
background: #0e0e0e;
}
body.dark-mode #viewport {
background: #0e0e0e;
}
body.dark-mode .page-slot canvas {
filter: invert(1) hue-rotate(180deg) contrast(0.92) brightness(0.96);
}
body.dark-mode #status {
background: rgba(20, 20, 20, 0.92);
color: #d4d4d4;
}
.linkLayer {
position: absolute;
inset: 0;
z-index: 3;
pointer-events: none;
}
.linkLayer a {
position: absolute;
display: block;
pointer-events: auto;
cursor: pointer;
text-decoration: none;
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
let destinationPageIndexCache = new Map();
let pagePromiseCache = new Map();
let textContentCache = new Map();
let estimatedPageWidthAtScale1 = 800;
let estimatedPageHeightAtScale1 = 1131;
let pageSizeScale1ByIndex = new Map();
let renderedScaleByPage = new Map();
let darkModePreference = 'auto';
let hostDarkTheme = false;

function isDarkModeActive() {
if (darkModePreference === 'on') { return true; }
if (darkModePreference === 'off') { return false; }
return hostDarkTheme;
}

function applyDarkModeState() {
document.body.classList.toggle('dark-mode', isDarkModeActive());
}

function setDarkModePreference(nextPreference, isDarkTheme) {
if (nextPreference === 'on' || nextPreference === 'off' || nextPreference === 'auto') {
darkModePreference = nextPreference;
}
hostDarkTheme = !!isDarkTheme;
applyDarkModeState();
}

function pruneCache(cache, maxSize) {
while (cache.size > maxSize) {
const firstKey = cache.keys().next().value;
cache.delete(firstKey);
}
}

function clearRenderCaches() {
pagePromiseCache = new Map();
textContentCache = new Map();
destinationPageIndexCache = new Map();
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

function updateStatus() {
if (!pdfDoc) { return; }
const current = Math.max(1, Math.min(getCurrentPageNumber(), getTotalPages()));
const total = Math.max(1, getTotalPages());
const zoomPercent = Math.round(zoom * 100);
statusEl.textContent = current + '/' + total + ' ' + zoomPercent + '%';
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
updateStatus();
scheduleVisibleRender();
}

async function goToPdfDestination(destRaw) {
if (!pdfDoc || !destRaw) { return; }

let dest = destRaw;
if (typeof dest === 'string') {
dest = await pdfDoc.getDestination(dest);
}
if (!Array.isArray(dest) || dest.length < 2) {
return;
}

const pageRef = dest[0];
let pageIndex = -1;
if (typeof pageRef === 'number') {
pageIndex = pageRef;
} else {
const key = JSON.stringify(pageRef);
if (destinationPageIndexCache.has(key)) {
pageIndex = destinationPageIndexCache.get(key);
} else {
pageIndex = await pdfDoc.getPageIndex(pageRef);
destinationPageIndexCache.set(key, pageIndex);
}
}

if (!Number.isFinite(pageIndex) || pageIndex < 0 || pageIndex >= pdfDoc.numPages) {
return;
}

const pageNumber = pageIndex + 1;
const destType = dest[1] && typeof dest[1] === 'object' ? dest[1].name : '';
let topPdf = null;
if (destType === 'XYZ' && typeof dest[3] === 'number') {
topPdf = dest[3];
} else if ((destType === 'FitH' || destType === 'FitBH') && typeof dest[2] === 'number') {
topPdf = dest[2];
}

if (topPdf === null) {
goToPage(pageNumber);
return;
}

const slot = pagesEl.children[pageIndex];
if (!slot) {
goToPage(pageNumber);
return;
}

const page = await getPageCached(pageNumber);
const scale = renderedScaleByPage.get(pageIndex) ?? renderedAtZoom;
const vp = page.getViewport({ scale: Math.max(0.0001, scale) });
const point = vp.convertToViewportPoint(0, topPdf);
const targetScrollTop = slot.offsetTop + point[1] - 8;
viewportEl.scrollTop = Math.max(0, targetScrollTop);
updateStatus();
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
slot.style.width = Math.max(1, baseWidth * scale) + 'px';
slot.style.height = Math.max(1, baseHeight * scale) + 'px';
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
const linkLayer = document.createElement('div');
linkLayer.className = 'linkLayer';

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
linkLayer.style.width = canvas.width + 'px';
linkLayer.style.height = canvas.height + 'px';

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

try {
const annotations = await page.getAnnotations();
for (const annotation of annotations) {
if (!annotation || annotation.subtype !== 'Link' || !Array.isArray(annotation.rect)) { continue; }

const rect = vp.convertToViewportRectangle(annotation.rect);
if (!Array.isArray(rect) || rect.length < 4) { continue; }
const left = Math.min(rect[0], rect[2]);
const top = Math.min(rect[1], rect[3]);
const width = Math.abs(rect[2] - rect[0]);
const height = Math.abs(rect[3] - rect[1]);
if (width < 1 || height < 1) { continue; }

const linkEl = document.createElement('a');
linkEl.href = '#';
linkEl.style.left = left + 'px';
linkEl.style.top = top + 'px';
linkEl.style.width = width + 'px';
linkEl.style.height = height + 'px';

const externalUrl = typeof annotation.url === 'string'
? annotation.url
: (typeof annotation.unsafeUrl === 'string' ? annotation.unsafeUrl : null);
if (externalUrl) {
linkEl.title = externalUrl;
linkEl.addEventListener('click', (event) => {
event.preventDefault();
vscode.postMessage({ type: 'openExternalUrl', url: externalUrl });
});
} else if (annotation.dest) {
linkEl.addEventListener('click', (event) => {
event.preventDefault();
void goToPdfDestination(annotation.dest);
});
} else {
continue;
}

linkLayer.appendChild(linkEl);
}
} catch (annotationError) {
console.warn('link annotations disabled for page', pageNumber, annotationError);
}

if (gen !== renderGeneration) { return null; }

if (textLayer.childNodes.length > 0 || linkLayer.childNodes.length > 0) {
if (textLayer.childNodes.length > 0 && linkLayer.childNodes.length > 0) {
content.replaceChildren(canvas, textLayer, linkLayer);
} else if (textLayer.childNodes.length > 0) {
content.replaceChildren(canvas, textLayer);
} else {
content.replaceChildren(canvas, linkLayer);
}
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
} else if (transitionCommit) {
// Important: even without freshly rendered pages, advance committed zoom state.
// Otherwise the viewer can stay in a stale renderedAtZoom and skip HQ rerenders.
renderedAtZoom = targetZoom;
pagesEl.style.gap = (16 * renderedAtZoom) + 'px';
applyLayoutForScale(renderedAtZoom);
syncPageContentScaleCompensation();
}

restoreSelectionState(selectionState);
updateStatus();
}

async function rerenderAtCurrentZoom() {
if (!pdfDoc) { return; }
const targetZoom = zoom;
const gen = ++renderGeneration;
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

await renderVisiblePages(targetZoom, gen, true);
if (gen !== renderGeneration) { return; }

if (anchorSnapshot) {
pendingZoomAnchor = null;
}

// Let the committed layout settle for one frame before removing preview transform.
await new Promise((resolve) => requestAnimationFrame(resolve));
if (gen !== renderGeneration) { return; }

if (previewScaleRaf !== null) {
cancelAnimationFrame(previewScaleRaf);
previewScaleRaf = null;
}
previewScaleCurrent = 1.0;
previewScaleTarget = 1.0;
applyPreviewScaleTransform(1.0);

// Ensure visible pages are refreshed at committed scale even without user scroll.
scheduleVisibleRender();
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
updateStatus();
scheduleRerender();
}

viewportEl.addEventListener('wheel', (e) => {
if (!e.ctrlKey) { return; }
e.preventDefault();
const factor = Math.exp(-e.deltaY * 0.002);
applyZoom(zoom * factor, e.clientX, e.clientY);
}, { passive: false });

viewportEl.addEventListener('scroll', () => {
updateStatus();
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
if (msg.type === 'setDarkModePreference') {
setDarkModePreference(msg.darkModePreference, msg.isDarkTheme);
return;
}
if (msg.type !== 'loadPdf' || !msg.base64) { return; }

statusEl.textContent = 'Opening PDF...';
try {
setDarkModePreference(msg.darkModePreference, msg.isDarkTheme);
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
const initialPage = Number(msg.initialPage ?? 0);
if (Number.isFinite(initialPage) && initialPage > 0) {
	goToPage(initialPage);
}
updateStatus();
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
