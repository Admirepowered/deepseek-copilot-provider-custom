import * as vscode from "vscode";
import { manageSettings, manageAllProviders } from "./commands/manageSettings";
import {
  ProviderConfig,
  getAllProviders,
  CONFIG_SECTION,
} from "./config";
import { MultiChatModelProvider } from "./provider";

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Multi-Provider");

  // ── Collect all providers ──────────────────────────────
  const allProviders = getAllProviders();

  // Map to track instantiated providers by vendor
  const providerInstances = new Map<string, MultiChatModelProvider>();

  for (const cfg of allProviders) {
    const provider = new MultiChatModelProvider(cfg, context.secrets, output);
    context.subscriptions.push(provider);
    context.subscriptions.push(
      vscode.lm.registerLanguageModelChatProvider(cfg.vendor, provider)
    );
    providerInstances.set(cfg.vendor, provider);

    // Register a per-provider manage command
    context.subscriptions.push(
      vscode.commands.registerCommand(`${cfg.commandPrefix}.manage`, async () => {
        await manageSettings(context.secrets, cfg);
        const instance = providerInstances.get(cfg.vendor);
        instance?.notifyModelInformationChanged("settings updated");
      })
    );

    // Register a per-provider open-settings command
    context.subscriptions.push(
      vscode.commands.registerCommand(`${cfg.commandPrefix}.openSettings`, async () => {
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          CONFIG_SECTION
        );
      })
    );

    // Register a per-provider refresh command
    context.subscriptions.push(
      vscode.commands.registerCommand(`${cfg.commandPrefix}.refreshModels`, async () => {
        const instance = providerInstances.get(cfg.vendor);
        instance?.notifyModelInformationChanged("manual refresh");
        vscode.window.showInformationMessage(
          `${cfg.label} model list refresh requested.`
        );
      })
    );
  }

  context.subscriptions.push(output);

  // ── Global "Manage All Providers" command ──────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("multiProvider.manageAll", async () => {
      await manageAllProviders(context.secrets);
      for (const inst of providerInstances.values()) {
        inst.notifyModelInformationChanged("providers list changed");
      }
    })
  );

  // ── Watch configuration changes ───────────────────────
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        // Re-read custom providers and refresh
        const updated = getAllProviders();
        for (const cfg of updated) {
          const inst = providerInstances.get(cfg.vendor);
          inst?.notifyModelInformationChanged("configuration changed");
        }
      }
    })
  );

  // ── Watch secret changes for all known providers ──────
  context.subscriptions.push(
    context.secrets.onDidChange((event) => {
      for (const cfg of allProviders) {
        if (event.key === cfg.apiKeySecretKey) {
          const inst = providerInstances.get(cfg.vendor);
          inst?.notifyModelInformationChanged("API key changed");
        }
      }
    })
  );

  // ── Legacy commands for backward compat ───────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.manage", async () => {
      const ds = allProviders.find((p) => p.commandPrefix === "deepseek");
      if (ds) {
        await manageSettings(context.secrets, ds);
        const inst = providerInstances.get(ds.vendor);
        inst?.notifyModelInformationChanged("settings updated");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.openSettings", async () => {
      await vscode.commands.executeCommand("workbench.action.openSettings", CONFIG_SECTION);
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("deepseek.refreshModels", async () => {
      const ds = allProviders.find((p) => p.commandPrefix === "deepseek");
      const inst = ds ? providerInstances.get(ds.vendor) : undefined;
      inst?.notifyModelInformationChanged("manual refresh");
      vscode.window.showInformationMessage("DeepSeek model list refresh requested.");
    })
  );
}

export function deactivate(): void {}
