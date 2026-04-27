import * as vscode from "vscode";

export const CONFIG_SECTION = "languageModelChatProvider.deepseek-copilot-provider-custom";
export const DEEPSEEK_API_KEY_SECRET = "deepseek-copilot-provider-custom.apiKey";

export interface DeepSeekSettings {
  baseUrl: string;
  modelIds: string[];
  reasoningEffort: string;
}

export function getSettings(): DeepSeekSettings {
  const configuration = vscode.workspace.getConfiguration(CONFIG_SECTION);
  const configuredModelIds: string[] = configuration.get("modelIds") ?? [];
  const modelIds = configuredModelIds
    .map((value) => value.trim())
    .filter((value, index, list) => value.length > 0 && list.indexOf(value) === index);
  return {
    baseUrl: normalizeBaseUrl(configuration.get("baseUrl") ?? "https://api.deepseek.com"),
    modelIds,
    reasoningEffort: configuration.get("reasoningEffort") ?? "high",
  };
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function getApiKey(secrets: vscode.SecretStorage): Promise<string | undefined> {
  const value = await secrets.get(DEEPSEEK_API_KEY_SECRET);
  return value?.trim() || undefined;
}

export async function setApiKey(secrets: vscode.SecretStorage, apiKey: string): Promise<void> {
  await secrets.store(DEEPSEEK_API_KEY_SECRET, apiKey.trim());
}

export async function clearApiKey(secrets: vscode.SecretStorage): Promise<void> {
  await secrets.delete(DEEPSEEK_API_KEY_SECRET);
}
