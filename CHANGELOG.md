# Change Log

All notable changes to the "vscode-pdf-docs" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- No changes yet.

## [1.0.0] - 2026-05-09

### Added

- Custom PDF preview editor for `*.pdf` files.
- Smooth zoom pipeline with stable anchor behavior.
- Page navigation support:
	- `PDF: Go to Page` command.
	- `Alt+G` shortcut in PDF preview.
- PDF links support:
	- Internal destination links (`dest`) in documents.
	- External links (`http`, `https`, `mailto`).
- PDF outline support:
	- `PDF Outline` tree view in Explorer for active PDF preview.
	- `Ctrl+Shift+O` outline picker for active PDF preview.
	- Right-click copy actions for outline nodes:
		- Copy Section Name
		- Copy Full Section Name
		- Copy Section Path
		- Copy Full Section Path
- Comment reference support for code files via `@pdf(...)` links:
	- Page targets (`#page=12`, `#p=12`, `#12`).
	- Outline targets (`#outline=...`).
	- Relative and absolute PDF path resolution.
- Dark mode reading support for PDF preview.
- Settings support for dark mode behavior:
	- `vscode-pdf-docs.darkMode = off | on | auto`.
	- `auto` follows current VS Code color theme.

### Changed

- Extension architecture refactored into multiple modules for maintainability:
	- `src/extension.ts` (activation and command wiring)
	- `src/config.ts` (configuration and theme helpers)
	- `src/pdfFeatures.ts` (outline and comment-reference features)
	- `src/pdfReadonlyEditorProvider.ts` (custom editor provider and webview)