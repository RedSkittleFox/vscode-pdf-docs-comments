import * as vscode from "vscode";

export type PdfDarkModePreference = "off" | "on" | "auto";

export const DARK_MODE_SETTING_KEY = "darkMode";

export function getDarkModePreference(
  configuration: vscode.WorkspaceConfiguration,
): PdfDarkModePreference {
  const raw = configuration.get<string>(DARK_MODE_SETTING_KEY, "auto");
  if (raw === "off" || raw === "on" || raw === "auto") {
    return raw;
  }
  return "auto";
}

export function isDarkThemeKind(kind: vscode.ColorThemeKind): boolean {
  return (
    kind === vscode.ColorThemeKind.Dark ||
    kind === vscode.ColorThemeKind.HighContrast
  );
}
