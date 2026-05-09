# vscode-pdf-docs-comments

PDF reading and referencing extension for VS Code.

It adds a custom PDF preview with smooth zoom, navigation, dark-mode reading, outline tools, and comment references from source code to PDF pages/sections.

![vscode-pdf-docs-comments presentation](resources/readme-presentation.gif)

## Features

- Custom editor for `*.pdf` with performant rendering.
- Page navigation command:
	- `PDF: Go to Page`
	- Shortcut: `Alt+G` in PDF preview.
- Clickable PDF links:
	- Internal PDF destinations.
	- External URLs (`http`, `https`, `mailto`).
- PDF outline support:
	- `PDF Outline` tree in Explorer (for active PDF preview).
	- Quick outline picker via `Ctrl+Shift+O` (in active PDF preview).
	- Context menu actions in outline tree:
		- Copy Section Name
		- Copy Full Section Name
		- Copy Section Path
		- Copy Full Section Path
- Code comment references to PDFs:
	- `@pdf(docs/spec.pdf#page=12)`
	- `@pdf(docs/spec.pdf#outline=Chapter 2 > Rendering)`
- Dark mode for PDF reading with setting-based control.

## Commands

- `PDF: Go to Page`
- `PDF: Show Outline`
- `PDF: Toggle Dark Mode`
- `PDF: Refresh Outline`

## Settings

- `vscode-pdf-docs.darkMode`
	- `off`: Always light PDF rendering.
	- `on`: Always dark PDF rendering.
	- `auto` (default): Follows current VS Code theme.

## Using PDF References in Code

References are detected through `@pdf(...)` tokens anywhere in text (commonly in comments).

Examples:

- `@pdf(docs/architecture.pdf)`
- `@pdf(docs/architecture.pdf#page=42)`
- `@pdf(docs/architecture.pdf#p=42)`
- `@pdf(docs/architecture.pdf#42)`
- `@pdf(docs/architecture.pdf#outline=Rendering Pipeline)`

When clicked, the extension opens the target PDF and navigates to the resolved page.

## Development

### Build and run

1. Install dependencies:
	 - `npm install`
2. Compile:
	 - `npm run compile`
3. Watch mode:
	 - `npm run watch`
4. Run extension host:
	 - Press `F5` in VS Code.

### Dev container

This repository includes a dev container configuration at `.devcontainer/devcontainer.json`.

To use it:

1. Open repository in VS Code.
2. Run **Dev Containers: Reopen in Container**.
3. Use `npm run watch` or `F5`.
