import * as vscode from "vscode";
import {
  DARK_MODE_SETTING_KEY,
  PdfDarkModePreference,
  getDarkModePreference,
} from "./config";
import {
  PdfCommentReferenceLinkProvider,
  PdfCommentReferencePayload,
  PdfOutlineTreeItem,
  PdfOutlineTreeProvider,
  extractPdfOutlineEntries,
  findOutlineEntryByTitle,
  resolvePdfReferenceUri,
  toWorkspaceRelativePdfPath,
} from "./pdfFeatures";
import { PdfReadonlyEditorProvider } from "./pdfReadonlyEditorProvider";

export function activate(context: vscode.ExtensionContext) {
  const provider = new PdfReadonlyEditorProvider(context);

  const providerRegistration = vscode.window.registerCustomEditorProvider(
    "vscode-pdf-docs.pdfPreview",
    provider,
    {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    },
  );

  const goToPageCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.goToPage",
    async () => {
      const handled = await provider.triggerNativeGoToPageForActiveEditor();
      if (!handled) {
        void vscode.window.showInformationMessage(
          "Open a PDF preview tab to use Go to Page.",
        );
      }
    },
  );

  const toggleDarkModeCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.toggleDarkMode",
    async () => {
      const configuration =
        vscode.workspace.getConfiguration("vscode-pdf-docs");
      const current = getDarkModePreference(configuration);
      const next: PdfDarkModePreference = current === "on" ? "off" : "on";
      await configuration.update(
        DARK_MODE_SETTING_KEY,
        next,
        vscode.ConfigurationTarget.Global,
      );
    },
  );

  const showOutlineCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.showOutline",
    async () => {
      const uri = provider.getActiveDocumentUri();
      if (!uri) {
        void vscode.window.showInformationMessage(
          "Open a PDF preview tab to use Outline.",
        );
        return;
      }

      const entries = await extractPdfOutlineEntries(uri);
      if (!entries.length) {
        void vscode.window.showInformationMessage(
          "No table of contents found in this PDF.",
        );
        return;
      }

      const picked = await vscode.window.showQuickPick(
        entries.map((entry) => ({
          label: entry.label,
          description: `Page ${entry.pageNumber}`,
          entry,
        })),
        {
          placeHolder: "Go to heading in PDF outline",
          matchOnDescription: true,
        },
      );

      if (!picked) {
        return;
      }

      await provider.goToPageInActiveEditor(picked.entry.pageNumber);
    },
  );

  const outlineTreeProvider = new PdfOutlineTreeProvider(() =>
    provider.getActiveDocumentUri(),
  );
  const outlineTreeRegistration = vscode.window.registerTreeDataProvider(
    "pdfOutlineExplorer",
    outlineTreeProvider,
  );

  const revealOutlinePageCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.revealOutlinePage",
    async (item: PdfOutlineTreeItem) => {
      await provider.goToPageInActiveEditor(item.pageNumber);
    },
  );

  const copyOutlineSectionNameCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.copyOutlineSectionName",
    async (item: PdfOutlineTreeItem | undefined) => {
      if (!item) {
        return;
      }
      await vscode.env.clipboard.writeText(item.node.title);
    },
  );

  const copyOutlineFullPathCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.copyOutlineFullPath",
    async (item: PdfOutlineTreeItem | undefined) => {
      if (!item) {
        return;
      }
      await vscode.env.clipboard.writeText(item.node.fullPath);
    },
  );

  const copyOutlineSectionPathCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.copyOutlineSectionPath",
    async (item: PdfOutlineTreeItem | undefined) => {
      if (!item) {
        return;
      }
      const relativePath = toWorkspaceRelativePdfPath(
        vscode.Uri.file(item.node.pdfAbsolutePath),
      );
      const reference = `@pdf(${relativePath}#outline=${item.node.fullPath})`;
      await vscode.env.clipboard.writeText(reference);
    },
  );

  const copyOutlineFullSectionPathCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.copyOutlineFullSectionPath",
    async (item: PdfOutlineTreeItem | undefined) => {
      if (!item) {
        return;
      }
      const reference = `@pdf(${item.node.pdfAbsolutePath}#outline=${item.node.fullPath})`;
      await vscode.env.clipboard.writeText(reference);
    },
  );

  const refreshOutlineCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.refreshOutline",
    () => {
      outlineTreeProvider.refresh();
    },
  );

  const tabChangeSubscription = vscode.window.tabGroups.onDidChangeTabs(() => {
    outlineTreeProvider.refresh();
  });

  const darkModeConfigSubscription = vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (
        !event.affectsConfiguration(`vscode-pdf-docs.${DARK_MODE_SETTING_KEY}`)
      ) {
        return;
      }
      void provider.refreshDarkModeForPanels();
    },
  );

  const colorThemeSubscription = vscode.window.onDidChangeActiveColorTheme(
    () => {
      void provider.refreshDarkModeForPanels();
    },
  );

  const openPdfCommentReferenceCommand = vscode.commands.registerCommand(
    "vscode-pdf-docs.openPdfCommentReference",
    async (payload: PdfCommentReferencePayload | undefined) => {
      if (!payload) {
        return;
      }

      const sourceUri = vscode.Uri.parse(payload.sourceUri);
      const targetPdfUri = await resolvePdfReferenceUri(
        payload.pdfPath,
        sourceUri,
      );
      if (!targetPdfUri) {
        void vscode.window.showWarningMessage(
          `Referenced PDF not found: ${payload.pdfPath}`,
        );
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
    },
  );

  const commentReferenceLinkProvider = new PdfCommentReferenceLinkProvider();
  const commentReferenceRegistration =
    vscode.languages.registerDocumentLinkProvider(
      { scheme: "file" },
      commentReferenceLinkProvider,
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
