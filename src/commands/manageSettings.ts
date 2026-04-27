import * as vscode from "vscode";
import {
  ProviderConfig,
  ProviderType,
  CustomProviderEntry,
  CUSTOM_PROVIDERS_CONFIG_KEY,
  BUILTIN_PROVIDERS,
  getCustomProviders,
  getApiKey,
  setApiKey,
  clearApiKey,
} from "../config";

// ── Manage a single provider ─────────────────────────────────

export async function manageSettings(
  secrets: vscode.SecretStorage,
  provider: ProviderConfig
): Promise<void> {
  const apiKey = await getApiKey(secrets, provider);
  const config = vscode.workspace.getConfiguration();
  const currentBaseUrl = config.get<string>(`${provider.configSection}.baseUrl`) || provider.baseUrl;

  const action = await vscode.window.showQuickPick(
    [
      {
        label: apiKey ? "Update API Key" : "Set API Key",
        value: "set-api-key",
        description: apiKey
          ? `API key already configured for ${provider.label}`
          : `Required for using ${provider.label} models`,
      },
      {
        label: "Clear API Key",
        value: "clear-api-key",
        description: apiKey
          ? `Remove the stored ${provider.label} API key`
          : `No API key stored for ${provider.label}`,
      },
      {
        label: "Set Base URL",
        value: "set-base-url",
        description: `Current: ${currentBaseUrl}`,
      },
      {
        label: "Open Settings",
        value: "open-settings",
        description: `Configure base URL and other ${provider.label} settings`,
      },
    ],
    {
      title: `Manage ${provider.label} Provider`,
      placeHolder: "Choose an action",
      ignoreFocusOut: true,
    }
  );

  if (!action) return;

  if (action.value === "set-api-key") {
    const nextValue = await vscode.window.showInputBox({
      title: `${provider.label} API Key`,
      prompt: `Enter your ${provider.label} API key. It will be stored in VS Code SecretStorage.`,
      password: true,
      ignoreFocusOut: true,
      placeHolder: apiKey ? "A key is already configured" : "Enter API key…",
      value: apiKey,
    });
    if (nextValue === undefined) return;
    if (!nextValue.trim()) {
      vscode.window.showWarningMessage(`${provider.label} API key cannot be empty.`);
      return;
    }
    await setApiKey(secrets, provider, nextValue);
    vscode.window.showInformationMessage(`${provider.label} API key saved.`);
    return;
  }

  if (action.value === "clear-api-key") {
    if (!apiKey) {
      vscode.window.showInformationMessage(`No ${provider.label} API key is currently stored.`);
      return;
    }
    await clearApiKey(secrets, provider);
    vscode.window.showInformationMessage(`${provider.label} API key cleared.`);
    return;
  }

  if (action.value === "set-base-url") {
    const nextUrl = await vscode.window.showInputBox({
      title: `${provider.label} Base URL`,
      prompt: `Enter the base URL for the ${provider.label} API.`,
      ignoreFocusOut: true,
      placeHolder: currentBaseUrl,
      value: currentBaseUrl,
    });
    if (nextUrl === undefined) return;
    const normalized = nextUrl.trim().replace(/\/+$/, "");
    if (!normalized) {
      vscode.window.showWarningMessage(`${provider.label} base URL cannot be empty.`);
      return;
    }
    await config.update(
      `${provider.configSection}.baseUrl`,
      normalized,
      vscode.ConfigurationTarget.Global
    );
    vscode.window.showInformationMessage(`${provider.label} base URL updated to ${normalized}.`);
    return;
  }

  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    provider.configSection || "multiProvider"
  );
}

// ── Manage all providers + custom providers ──────────────────

export async function manageAllProviders(secrets: vscode.SecretStorage): Promise<void> {
  while (true) {
    const builtInItems = BUILTIN_PROVIDERS.map((p) => ({
      label: `$(key) ${p.label}`,
      value: `manage:${p.label}`,
      description: `${p.type} — ${p.baseUrl}`,
    }));

    const customProviders = getCustomProviders();
    const customItems = customProviders.map((cp) => ({
      label: `$(gist) ${cp.label}`,
      value: `manage:${cp.label}`,
      description: `${cp.type} — ${cp.baseUrl} (custom)`,
    }));

    const items = [
      ...builtInItems,
      ...customItems,
      {
        label: "$(add) Add Custom Provider",
        value: "add-custom",
        description: "Add a new OpenAI-compatible, Anthropic, or Codex provider",
      },
    ];

    // Add remove options for custom providers
    for (const cp of customProviders) {
      items.push({
        label: `$(trash) Remove ${cp.label}`,
        value: `remove:${cp.label}`,
        description: "Remove this custom provider",
      });
    }

    const choice = await vscode.window.showQuickPick(items, {
      title: "Manage All Providers",
      placeHolder: "Choose a provider to manage, or add a custom one",
      ignoreFocusOut: true,
    });

    if (!choice) return;

    if (choice.value === "add-custom") {
      await addCustomProvider();
      continue; // refresh list
    }

    if (choice.value.startsWith("remove:")) {
      const label = choice.value.slice("remove:".length);
      await removeCustomProvider(label);
      continue;
    }

    if (choice.value.startsWith("manage:")) {
      const label = choice.value.slice("manage:".length);
      // Find in builtin or custom
      let provider = BUILTIN_PROVIDERS.find((p) => p.label === label);
      if (!provider) {
        const cp = customProviders.find((p) => p.label === label);
        if (cp) {
          provider = {
            label: cp.label,
            type: cp.type,
            baseUrl: cp.baseUrl,
            apiKeySecretKey: `multi-provider.custom.${cp.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.apiKey`,
            vendor: `multi-provider-custom-${cp.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            chatProviderDisplayName: cp.label,
            commandPrefix: `custom-${cp.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            configSection: `multiProvider.custom.${cp.label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
            defaultFallbackModels: [],
          };
        }
      }
      if (provider) {
        await manageSettings(secrets, provider);
      }
    }
  }
}

// ── Add / Remove custom providers ────────────────────────────

async function addCustomProvider(): Promise<void> {
  const label = await vscode.window.showInputBox({
    title: "Custom Provider — Label",
    prompt: "Enter a display name for this provider (e.g., My LLM Server)",
    ignoreFocusOut: true,
    placeHolder: "My LLM Server",
  });
  if (!label || !label.trim()) return;

  const typePick = await vscode.window.showQuickPick(
    [
      { label: "OpenAI Compatible", value: "openai" as ProviderType, description: "OpenAI / DeepSeek compatible API (/chat/completions)" },
      { label: "Anthropic", value: "anthropic" as ProviderType, description: "Anthropic Messages API (/v1/messages)" },
      { label: "OpenAI Codex", value: "codex" as ProviderType, description: "OpenAI Codex API (/v1/chat/completions, x-api-key header)" },
    ],
    {
      title: "Custom Provider — API Type",
      placeHolder: "Choose the API type",
      ignoreFocusOut: true,
    }
  );
  if (!typePick) return;

  const baseUrl = await vscode.window.showInputBox({
    title: "Custom Provider — Base URL",
    prompt: "Enter the base URL for the API (e.g., https://api.myprovider.com)",
    ignoreFocusOut: true,
    placeHolder: "https://api.myprovider.com",
  });
  if (!baseUrl || !baseUrl.trim()) return;

  const current = getCustomProviders();
  // Avoid duplicates
  if (current.some((cp) => cp.label === label.trim())) {
    vscode.window.showWarningMessage(`A custom provider named "${label}" already exists.`);
    return;
  }

  const newEntry: CustomProviderEntry = {
    label: label.trim(),
    type: typePick.value,
    baseUrl: baseUrl.trim().replace(/\/+$/, ""),
  };

  const updated = [...current, newEntry];

  await vscode.workspace.getConfiguration().update(
    CUSTOM_PROVIDERS_CONFIG_KEY,
    updated,
    vscode.ConfigurationTarget.Global
  );

  vscode.window.showInformationMessage(
    `Custom provider "${newEntry.label}" added. Set its API key to see models.`
  );
}

async function removeCustomProvider(label: string): Promise<void> {
  const current = getCustomProviders();
  const updated = current.filter((cp) => cp.label !== label);
  if (updated.length === current.length) {
    vscode.window.showWarningMessage(`Custom provider "${label}" not found.`);
    return;
  }
  await vscode.workspace.getConfiguration().update(
    CUSTOM_PROVIDERS_CONFIG_KEY,
    updated,
    vscode.ConfigurationTarget.Global
  );
  // Also clear its API key — note: secrets aren't accessible from this scope,
  // the user can clear it manually via the per-provider manage command.
  vscode.window.showInformationMessage(`Custom provider "${label}" removed.`);
}
