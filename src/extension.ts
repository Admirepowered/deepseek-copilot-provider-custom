import * as vscode from "vscode";
import { manageSettings } from "./commands/manageSettings";
import { CONFIG_SECTION } from "./config";
import { DeepSeekChatModelProvider } from "./provider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("DeepSeek Provider");
  const provider = new DeepSeekChatModelProvider(context.secrets, output);

  context.subscriptions.push(output);
  context.subscriptions.push(provider);
  context.subscriptions.push(
    vscode.lm.registerLanguageModelChatProvider("deepseek", provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.manage", async () => {
      await manageSettings(context.secrets);
      provider.notifyModelInformationChanged("settings updated");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.openSettings", async () => {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        CONFIG_SECTION
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.refreshModels", async () => {
      provider.notifyModelInformationChanged("manual refresh");
      vscode.window.showInformationMessage(
        "DeepSeek model list refresh requested."
      );
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        provider.notifyModelInformationChanged("configuration changed");
      }
    })
  );

  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      if (event.key === "deepseek.apiKey") {
        provider.notifyModelInformationChanged("API key changed");
      }
    })
  );
}

export function deactivate(): void {}
