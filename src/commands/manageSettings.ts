import * as vscode from "vscode";
import { getApiKey, setApiKey, clearApiKey, CONFIG_SECTION } from "../config";

export async function manageSettings(secrets: vscode.SecretStorage): Promise<void> {
  const apiKey = await getApiKey(secrets);

  const action = await vscode.window.showQuickPick(
    [
      {
        label: apiKey ? "Update API Key" : "Set API Key",
        value: "set-api-key",
        description: apiKey
          ? "API key already configured in SecretStorage"
          : "Required for listing and using DeepSeek models",
      },
      {
        label: "Clear API Key",
        value: "clear-api-key",
        description: apiKey ? "Remove the stored DeepSeek API key" : "No API key stored yet",
      },
      {
        label: "Open Settings",
        value: "open-settings",
        description: "Configure base URL, fallback model IDs, and reasoning effort",
      },
    ],
    {
      title: "Manage DeepSeek Provider",
      placeHolder: "Choose an action",
      ignoreFocusOut: true,
    }
  );

  if (!action) {
    return;
  }

  if (action.value === "set-api-key") {
    const nextValue = await vscode.window.showInputBox({
      title: "DeepSeek API Key",
      prompt: "Enter your DeepSeek API key. It will be stored in VS Code SecretStorage.",
      password: true,
      ignoreFocusOut: true,
      placeHolder: apiKey ? "A key is already configured" : "sk-...",
      value: apiKey,
    });
    if (nextValue === undefined) {
      return;
    }
    if (!nextValue.trim()) {
      vscode.window.showWarningMessage("DeepSeek API key cannot be empty.");
      return;
    }
    await setApiKey(secrets, nextValue);
    vscode.window.showInformationMessage("DeepSeek API key saved.");
    return;
  }

  if (action.value === "clear-api-key") {
    if (!apiKey) {
      vscode.window.showInformationMessage("No DeepSeek API key is currently stored.");
      return;
    }
    await clearApiKey(secrets);
    vscode.window.showInformationMessage("DeepSeek API key cleared.");
    return;
  }

  await vscode.commands.executeCommand("workbench.action.openSettings", CONFIG_SECTION);
}
