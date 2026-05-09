import * as vscode from "vscode";
import * as path from "node:path";
import * as pdfjsModule from "pdfjs-dist";

export type PdfOutlineEntry = {
  title: string;
  fullPath: string;
  label: string;
  pageNumber: number;
};

export type PdfCommentReferencePayload = {
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

type PdfOutlineNode = {
  title: string;
  indentedTitle: string;
  fullPath: string;
  pdfAbsolutePath: string;
  pageNumber: number;
  children: PdfOutlineNode[];
};

export class PdfCommentReferenceLinkProvider
  implements vscode.DocumentLinkProvider
{
  public provideDocumentLinks(
    document: vscode.TextDocument,
  ): vscode.DocumentLink[] {
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
      const range = new vscode.Range(
        document.positionAt(startOffset),
        document.positionAt(endOffset),
      );

      const payload: PdfCommentReferencePayload = {
        pdfPath: parsed.pdfPath,
        pageNumber: parsed.pageNumber,
        outlineTitle: parsed.outlineTitle,
        sourceUri: document.uri.toString(),
      };

      const target = vscode.Uri.parse(
        `command:vscode-pdf-docs.openPdfCommentReference?${encodeURIComponent(JSON.stringify([payload]))}`,
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

function parsePdfReferenceSpec(
  specRaw: string,
): ParsedPdfReference | undefined {
  const spec = specRaw.trim();
  if (!spec) {
    return undefined;
  }

  const hashIndex = spec.indexOf("#");
  const pdfPath = (hashIndex >= 0 ? spec.slice(0, hashIndex) : spec).trim();
  if (!pdfPath.toLowerCase().endsWith(".pdf")) {
    return undefined;
  }

  const fragmentRaw = hashIndex >= 0 ? spec.slice(hashIndex + 1).trim() : "";
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

export async function resolvePdfReferenceUri(
  pdfPath: string,
  sourceUri: vscode.Uri,
): Promise<vscode.Uri | undefined> {
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
      candidates.push(
        vscode.Uri.file(path.resolve(folder.uri.fsPath, trimmed)),
      );
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

export function findOutlineEntryByTitle(
  entries: PdfOutlineEntry[],
  title: string,
): PdfOutlineEntry | undefined {
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/\s*>\s*/g, " > ");
  const target = normalize(title);
  if (!target) {
    return undefined;
  }

  const exact = entries.find(
    (entry) =>
      normalize(entry.title) === target || normalize(entry.fullPath) === target,
  );
  if (exact) {
    return exact;
  }

  return entries.find((entry) => {
    const titleNorm = normalize(entry.title);
    const pathNorm = normalize(entry.fullPath);
    return titleNorm.includes(target) || pathNorm.includes(target);
  });
}

export function toWorkspaceRelativePdfPath(uri: vscode.Uri): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return uri.fsPath;
  }
  const relative = path.relative(workspaceFolder.uri.fsPath, uri.fsPath);
  return relative || path.basename(uri.fsPath);
}

export class PdfOutlineTreeItem extends vscode.TreeItem {
  constructor(public readonly node: PdfOutlineNode) {
    super(
      node.title,
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    this.description = `Page ${node.pageNumber}`;
    this.tooltip = `${node.title} (Page ${node.pageNumber})`;
    this.contextValue = "pdfOutlineItem";
    this.command = {
      command: "vscode-pdf-docs.revealOutlinePage",
      title: "Go to outline page",
      arguments: [this],
    };
  }

  get pageNumber(): number {
    return this.node.pageNumber;
  }
}

export class PdfOutlineTreeProvider implements vscode.TreeDataProvider<PdfOutlineTreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<
    PdfOutlineTreeItem | undefined
  >();
  public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  private loadedUriKey: string | undefined;
  private rootItems: PdfOutlineTreeItem[] = [];

  constructor(private readonly getActiveUri: () => vscode.Uri | undefined) {}

  public refresh(): void {
    this.loadedUriKey = undefined;
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  public getTreeItem(element: PdfOutlineTreeItem): vscode.TreeItem {
    return element;
  }

  public async getChildren(
    element?: PdfOutlineTreeItem,
  ): Promise<PdfOutlineTreeItem[]> {
    if (element) {
      return element.node.children.map(
        (child) => new PdfOutlineTreeItem(child),
      );
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

export async function extractPdfOutlineEntries(
  uri: vscode.Uri,
): Promise<PdfOutlineEntry[]> {
  const data = await vscode.workspace.fs.readFile(uri);
  const bytes = new Uint8Array(data);
  const pdfDoc = await (pdfjsModule as any).getDocument({ data: bytes })
    .promise;
  const outline = await pdfDoc.getOutline();
  if (!outline || !Array.isArray(outline)) {
    return [];
  }

  const pageIndexCache = new Map<string, number>();

  const resolvePageNumber = async (
    destRaw: unknown,
  ): Promise<number | undefined> => {
    if (!destRaw) {
      return undefined;
    }

    let dest = destRaw as any;
    if (typeof dest === "string") {
      dest = await pdfDoc.getDestination(dest);
    }

    if (!Array.isArray(dest) || dest.length < 1) {
      return undefined;
    }

    const pageRef = dest[0];
    if (typeof pageRef === "number") {
      return pageRef + 1;
    }

    if (pageRef && typeof pageRef === "object") {
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

  const collect = async (
    items: any[],
    level: number,
    parentPath: string,
  ): Promise<void> => {
    for (const item of items) {
      if (!item || typeof item.title !== "string" || !item.title.trim()) {
        continue;
      }

      const pageNumber = (await resolvePageNumber(item.dest)) ?? 1;
      const title = item.title.trim();
      const fullPath = parentPath ? `${parentPath} > ${title}` : title;
      const prefix = "  ".repeat(Math.min(level, 6));
      entries.push({
        title,
        fullPath,
        label: `${prefix}${title}`,
        pageNumber,
      });

      if (Array.isArray(item.items) && item.items.length > 0) {
        await collect(item.items, level + 1, fullPath);
      }
    }
  };

  await collect(outline, 0, "");
  return entries;
}

async function extractPdfOutlineTree(
  uri: vscode.Uri,
): Promise<PdfOutlineNode[]> {
  const data = await vscode.workspace.fs.readFile(uri);
  const bytes = new Uint8Array(data);
  const pdfDoc = await (pdfjsModule as any).getDocument({ data: bytes })
    .promise;
  const outline = await pdfDoc.getOutline();
  if (!outline || !Array.isArray(outline)) {
    return [];
  }

  const pageIndexCache = new Map<string, number>();

  const resolvePageNumber = async (
    destRaw: unknown,
  ): Promise<number | undefined> => {
    if (!destRaw) {
      return undefined;
    }

    let dest = destRaw as any;
    if (typeof dest === "string") {
      dest = await pdfDoc.getDestination(dest);
    }

    if (!Array.isArray(dest) || dest.length < 1) {
      return undefined;
    }

    const pageRef = dest[0];
    if (typeof pageRef === "number") {
      return pageRef + 1;
    }

    if (pageRef && typeof pageRef === "object") {
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

  const mapNodes = async (
    items: any[],
    level: number,
    parentPath: string,
  ): Promise<PdfOutlineNode[]> => {
    const out: PdfOutlineNode[] = [];
    for (const item of items) {
      if (!item || typeof item.title !== "string" || !item.title.trim()) {
        continue;
      }

      const title = item.title.trim();
      const fullPath = parentPath ? `${parentPath} > ${title}` : title;
      const indent = "  ".repeat(Math.min(level, 8));
      const children =
        Array.isArray(item.items) && item.items.length > 0
          ? await mapNodes(item.items, level + 1, fullPath)
          : [];

      out.push({
        title,
        indentedTitle: `${indent}${title}`,
        fullPath,
        pdfAbsolutePath: uri.fsPath,
        pageNumber: (await resolvePageNumber(item.dest)) ?? 1,
        children,
      });
    }
    return out;
  };

  return mapNodes(outline, 0, "");
}
