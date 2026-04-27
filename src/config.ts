import * as vscode from "vscode";

// ── Provider types ──────────────────────────────────────────────

export type ProviderType = "openai" | "anthropic" | "codex";

export interface ProviderConfig {
  /** User-facing label shown in the UI */
  label: string;
  /** API type: openai (DeepSeek, OpenAI-compatible), anthropic, or codex */
  type: ProviderType;
  /** Base URL for the API */
  baseUrl: string;
  /** API key stored in SecretStorage under this key */
  apiKeySecretKey: string;
  /** VS Code languageModelChatProviders vendor ID */
  vendor: string;
  /** Display name for the chat provider */
  chatProviderDisplayName: string;
  /** Command prefix for this provider (e.g. "deepseek" → "deepseek.manage") */
  commandPrefix: string;
  /** Configuration section prefix */
  configSection: string;
  /** Default model IDs to show before /models is fetched */
  defaultFallbackModels: string[];
}

// ── Built-in providers ──────────────────────────────────────────

export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  {
    label: "DeepSeek",
    type: "openai",
    baseUrl: "https://api.deepseek.com",
    apiKeySecretKey: "multi-provider.deepseek.apiKey",
    vendor: "multi-provider-deepseek",
    chatProviderDisplayName: "DeepSeek",
    commandPrefix: "deepseek",
    configSection: "multiProvider.deepseek",
    defaultFallbackModels: ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner"],
  },
  {
    label: "Anthropic",
    type: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeySecretKey: "multi-provider.anthropic.apiKey",
    vendor: "multi-provider-anthropic",
    chatProviderDisplayName: "Anthropic",
    commandPrefix: "anthropic",
    configSection: "multiProvider.anthropic",
    defaultFallbackModels: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-haiku-3-5-20250514"],
  },
  {
    label: "OpenAI Codex",
    type: "codex",
    baseUrl: "https://api.openai.com",
    apiKeySecretKey: "multi-provider.codex.apiKey",
    vendor: "multi-provider-codex",
    chatProviderDisplayName: "OpenAI Codex",
    commandPrefix: "codex",
    configSection: "multiProvider.codex",
    defaultFallbackModels: ["gpt-5", "gpt-5-mini", "gpt-5-nano", "o4-mini"],
  },
];

// ── Custom providers (user-added) ───────────────────────────────

export interface CustomProviderEntry {
  label: string;
  type: ProviderType;
  baseUrl: string;
}

export const CUSTOM_PROVIDERS_CONFIG_KEY = "multiProvider.customProviders";

export function getCustomProviders(): CustomProviderEntry[] {
  const config = vscode.workspace.getConfiguration();
  return (config.get<CustomProviderEntry[]>(CUSTOM_PROVIDERS_CONFIG_KEY) ?? []).filter(
    (p) => p.label && p.baseUrl && p.type
  );
}

/** Generate a stable vendor id from a custom provider label */
export function customProviderVendor(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `multi-provider-custom-${slug}`;
}

/** Generate a secret key for a custom provider */
export function customProviderSecretKey(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `multi-provider.custom.${slug}.apiKey`;
}

/** Build a full ProviderConfig from a CustomProviderEntry */
export function buildCustomProviderConfig(entry: CustomProviderEntry): ProviderConfig {
  return {
    label: entry.label,
    type: entry.type,
    baseUrl: normalizeBaseUrl(entry.baseUrl),
    apiKeySecretKey: customProviderSecretKey(entry.label),
    vendor: customProviderVendor(entry.label),
    chatProviderDisplayName: entry.label,
    commandPrefix: `custom-${customProviderVendor(entry.label)}`,
    configSection: `multiProvider.custom.${customProviderVendor(entry.label)}`,
    defaultFallbackModels: [],
  };
}

// ── All providers ───────────────────────────────────────────────

/** Read the configured base URL for a built-in provider, falling back to its default */
function resolveBaseUrl(section: string, defaultBaseUrl: string): string {
  const config = vscode.workspace.getConfiguration();
  const url = config.get<string>(`${section}.baseUrl`);
  return normalizeBaseUrl(url || defaultBaseUrl);
}

/** Read configured fallback model IDs for a built-in provider, falling back to its hardcoded defaults */
function resolveFallbackModels(section: string, defaults: string[]): string[] {
  const config = vscode.workspace.getConfiguration();
  const configured = config.get<string[]>(`${section}.defaultFallbackModels`);
  return configured ?? defaults;
}

export function getAllProviders(): ProviderConfig[] {
  const custom = getCustomProviders().map(buildCustomProviderConfig);
  const builtin = BUILTIN_PROVIDERS.map((p) => ({
    ...p,
    baseUrl: resolveBaseUrl(p.configSection, p.baseUrl),
    defaultFallbackModels: resolveFallbackModels(p.configSection, p.defaultFallbackModels),
  }));
  return [...builtin, ...custom];
}

// ── Helpers ─────────────────────────────────────────────────────

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

export async function getApiKey(secrets: vscode.SecretStorage, provider: ProviderConfig): Promise<string | undefined> {
  const value = await secrets.get(provider.apiKeySecretKey);
  return value?.trim() || undefined;
}

export async function setApiKey(secrets: vscode.SecretStorage, provider: ProviderConfig, apiKey: string): Promise<void> {
  await secrets.store(provider.apiKeySecretKey, apiKey.trim());
}

export async function clearApiKey(secrets: vscode.SecretStorage, provider: ProviderConfig): Promise<void> {
  await secrets.delete(provider.apiKeySecretKey);
}

// ── Legacy re-export for backward compat ────────────────────────

export const CONFIG_SECTION = "multiProvider";
export const DEEPSEEK_API_KEY_SECRET = BUILTIN_PROVIDERS[0].apiKeySecretKey;
