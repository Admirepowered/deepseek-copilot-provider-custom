import * as vscode from "vscode";
import { ApiClient } from "./apiClient";
import {
  ProviderConfig,
  ProviderType,
  getApiKey,
  normalizeBaseUrl,
} from "./config";

const DEFAULT_MAX_INPUT_TOKENS = 200000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

// ── Per-provider metadata for well-known models ──────────────

interface KnownModel {
  name: string;
  family: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  legacy?: boolean;
}

const KNOWN_MODELS: Record<string, KnownModel> = {
  // DeepSeek
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    family: "deepseek",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    family: "deepseek",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
  },
  "deepseek-chat": {
    name: "DeepSeek Chat",
    family: "deepseek",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: false,
    legacy: true,
  },
  "deepseek-reasoner": {
    name: "DeepSeek Reasoner",
    family: "deepseek",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    legacy: true,
  },
  // Anthropic
  "claude-sonnet-4-20250514": {
    name: "Claude Sonnet 4",
    family: "claude",
    maxInputTokens: 200_000,
    maxOutputTokens: 4096,
    supportsThinking: true,
  },
  "claude-opus-4-20250514": {
    name: "Claude Opus 4",
    family: "claude",
    maxInputTokens: 200_000,
    maxOutputTokens: 4096,
    supportsThinking: true,
  },
  "claude-haiku-3-5-20250514": {
    name: "Claude Haiku 3.5",
    family: "claude",
    maxInputTokens: 200_000,
    maxOutputTokens: 4096,
    supportsThinking: false,
  },
  // OpenAI Codex
  "gpt-5": {
    name: "GPT-5",
    family: "openai",
    maxInputTokens: 256_000,
    maxOutputTokens: 16384,
    supportsThinking: false,
  },
  "gpt-5-mini": {
    name: "GPT-5 Mini",
    family: "openai",
    maxInputTokens: 256_000,
    maxOutputTokens: 16384,
    supportsThinking: false,
  },
  "gpt-5-nano": {
    name: "GPT-5 Nano",
    family: "openai",
    maxInputTokens: 256_000,
    maxOutputTokens: 16384,
    supportsThinking: false,
  },
  "o4-mini": {
    name: "O4 Mini",
    family: "openai",
    maxInputTokens: 200_000,
    maxOutputTokens: 16384,
    supportsThinking: false,
  },
};

// ── Provider model shape ─────────────────────────────────────

interface ProviderModel {
  providerId: string;
  apiModel: string;
  name: string;
  detail: string;
  tooltip: string;
  family: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  thinkingEnabled: boolean;
  thinkingToggleSupported: boolean;
}

// ── The provider class (one per provider config) ─────────────

export class MultiChatModelProvider
  implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>
{
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  private client: ApiClient;
  private modelsById = new Map<string, ProviderModel>();
  private reasoningByAssistantSignature = new Map<string, string>();

  constructor(
    private providerConfig: ProviderConfig,
    private secrets: vscode.SecretStorage,
    private output: vscode.OutputChannel
  ) {
    this.client = new ApiClient(output);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  notifyModelInformationChanged(reason?: string): void {
    const label = this.providerConfig.label;
    const suffix = reason ? `: ${reason}` : "";
    this.output.appendLine(`[${label}] Refreshing model list${suffix}`);
    this.onDidChangeEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const apiKey = await getApiKey(this.secrets, this.providerConfig);
    if (!apiKey) {
      if (!options.silent) {
        const action = await vscode.window.showInformationMessage(
          `${this.providerConfig.label} Provider requires an API key before its models can appear in GitHub Copilot Chat.`,
          `Configure ${this.providerConfig.label}`
        );
        if (action === `Configure ${this.providerConfig.label}`) {
          await vscode.commands.executeCommand(`${this.providerConfig.commandPrefix}.manage`);
        }
      }
      return [];
    }

    const { baseUrl, type, defaultFallbackModels } = this.providerConfig;
    let remoteModelIds: string[] = [];
    try {
      remoteModelIds = await this.client.listModels(baseUrl, apiKey, type, token);
    } catch (error) {
      this.output.appendLine(
        `[${this.providerConfig.label}] Failed to fetch models list. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (!options.silent) {
        vscode.window.showWarningMessage(
          `${this.providerConfig.label} model discovery failed, using fallback model IDs. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const mergedModelIds = [...new Set([...remoteModelIds, ...defaultFallbackModels])];
    const providerModels = buildProviderModels(mergedModelIds, this.providerConfig);
    this.modelsById.clear();
    for (const pm of providerModels) {
      this.modelsById.set(pm.providerId, pm);
    }

    return providerModels.map((pm) => ({
      id: pm.providerId,
      name: pm.name,
      detail: pm.detail,
      tooltip: pm.tooltip,
      family: pm.family,
      version: "2026.04",
      maxInputTokens: pm.maxInputTokens,
      maxOutputTokens: pm.maxOutputTokens,
      capabilities: { toolCalling: pm.toolCalling },
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiKey = await getApiKey(this.secrets, this.providerConfig);
    if (!apiKey) {
      throw new Error(`${this.providerConfig.label} API key is not configured.`);
    }

    const providerModel =
      this.modelsById.get(model.id) ?? buildProviderModels([model.id], this.providerConfig)[0];

    const requestMessages = this.convertMessages(messages);
    const tools = convertTools(options.tools ?? []);

    const request: Record<string, unknown> = {
      model: providerModel.apiModel,
      messages: requestMessages,
      stream: true,
    };

    if (tools.length > 0) {
      request.tools = tools;
      const toolChoice = convertToolChoice(options.toolMode);
      if (toolChoice) {
        request.tool_choice = toolChoice;
      }
    }

    const modelOptions: Record<string, unknown> = options.modelOptions ?? {};

    if (!providerModel.thinkingEnabled) {
      if (typeof modelOptions.temperature === "number") {
        request.temperature = modelOptions.temperature;
      }
      if (typeof modelOptions.top_p === "number") {
        request.top_p = modelOptions.top_p;
      }
    }

    if (typeof modelOptions.max_tokens === "number") {
      request.max_tokens = Math.max(1, Math.floor(modelOptions.max_tokens));
    }

    if (typeof modelOptions.stop === "string") {
      request.stop = modelOptions.stop;
    } else if (Array.isArray(modelOptions.stop)) {
      request.stop = modelOptions.stop.filter((v: unknown) => typeof v === "string");
    }

    if (providerModel.thinkingToggleSupported) {
      request.thinking = {
        type: providerModel.thinkingEnabled ? "enabled" : "disabled",
      };
    }

    const bufferedToolCalls = new Map<
      number,
      { id?: string; name?: string; argumentsText: string }
    >();
    const emittedToolCalls: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }> = [];
    let reasoningContent = "";

    for await (const chunk of this.client.streamChatCompletion(
      this.providerConfig.baseUrl,
      apiKey,
      this.providerConfig.type,
      request,
      token
    )) {
      for (const choice of (chunk.choices as Array<Record<string, unknown>>) ?? []) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        if (typeof delta.reasoning_content === "string") {
          reasoningContent += delta.reasoning_content;
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          progress.report(new vscode.LanguageModelTextPart(delta.content));
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls as Array<Record<string, unknown>>) {
            const buffer = bufferedToolCalls.get(toolCall.index as number) ?? {
              argumentsText: "",
            };
            if (toolCall.id) buffer.id = toolCall.id as string;
            const fn = toolCall.function as Record<string, unknown> | undefined;
            if (fn?.name) buffer.name = fn.name as string;
            if (fn?.arguments) buffer.argumentsText += fn.arguments as string;
            bufferedToolCalls.set(toolCall.index as number, buffer);
          }
        }

        if (choice.finish_reason === "tool_calls") {
          for (const tc of flushBufferedToolCalls(bufferedToolCalls, progress)) {
            emittedToolCalls.push(tc);
          }
        }
      }
    }

    for (const tc of flushBufferedToolCalls(bufferedToolCalls, progress)) {
      emittedToolCalls.push(tc);
    }

    if (
      providerModel.thinkingEnabled &&
      emittedToolCalls.length > 0 &&
      reasoningContent.trim().length > 0
    ) {
      const signature = createAssistantSignature("", emittedToolCalls);
      this.rememberReasoning(signature, reasoningContent);
    }
  }

  async provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    if (typeof text === "string") {
      return estimateTokenCount(text);
    }
    let total = 0;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) {
        total += estimateTokenCount(part.value);
      }
      if (part instanceof vscode.LanguageModelToolCallPart) {
        total += estimateTokenCount(JSON.stringify(part.input));
      }
      if (part instanceof vscode.LanguageModelToolResultPart) {
        total += estimateTokenCount(serializeToolResultContent(part.content));
      }
    }
    return total;
  }

  private convertMessages(
    messages: readonly vscode.LanguageModelChatRequestMessage[]
  ): Array<Record<string, unknown>> {
    const converted: Array<Record<string, unknown>> = [];
    for (const message of messages) {
      const role = convertRole(message.role);
      const textParts: string[] = [];
      const toolCalls: Array<Record<string, unknown>> = [];
      const toolResults: Array<Record<string, unknown>> = [];

      for (const part of message.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textParts.push(part.value);
          continue;
        }
        if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: "function",
            function: {
              name: part.name,
              arguments:
                typeof part.input === "string"
                  ? part.input
                  : JSON.stringify(part.input ?? {}),
            },
          });
          continue;
        }
        if (part instanceof vscode.LanguageModelToolResultPart) {
          toolResults.push({
            role: "tool",
            tool_call_id: part.callId,
            content: serializeToolResultContent(part.content),
          });
          continue;
        }
        this.output.appendLine(
          `[DeepSeek] Ignoring unsupported message part: ${
            (part as { constructor?: { name?: string } })?.constructor?.name ??
            typeof part
          }`
        );
      }

      const combinedText = textParts.join("\n\n");

      if (toolCalls.length > 0) {
        const assistantMessage: Record<string, unknown> = {
          role: "assistant",
          content: combinedText.length > 0 ? combinedText : null,
          tool_calls: toolCalls,
        };
        const signature = createAssistantSignature(combinedText, toolCalls);
        const storedReasoning =
          this.reasoningByAssistantSignature.get(signature);
        if (storedReasoning) {
          assistantMessage.reasoning_content = storedReasoning;
        }
        converted.push(assistantMessage);
      } else if (combinedText.length > 0) {
        converted.push({
          role,
          content: combinedText.length > 0 ? combinedText : "",
          name: message.name,
        });
      }

      converted.push(...toolResults);
    }
    return converted;
  }

  private rememberReasoning(signature: string, reasoningContent: string): void {
    if (this.reasoningByAssistantSignature.has(signature)) {
      this.reasoningByAssistantSignature.delete(signature);
    }
    this.reasoningByAssistantSignature.set(signature, reasoningContent);
    while (this.reasoningByAssistantSignature.size > 100) {
      const firstKey = this.reasoningByAssistantSignature.keys().next().value;
      if (!firstKey) {
        break;
      }
      this.reasoningByAssistantSignature.delete(firstKey);
    }
  }
}

function buildProviderModels(
  modelIds: string[],
  providerConfig: ProviderConfig
): ProviderModel[] {
  const uniqueModelIds = modelIds
    .map((id) => id.trim())
    .filter((id, i, arr) => id.length > 0 && arr.indexOf(id) === i);

  const providerModels: ProviderModel[] = [];
  const type = providerConfig.type;

  for (const modelId of uniqueModelIds) {
    const metadata = KNOWN_MODELS[modelId];

    if (type === "openai" && metadata?.supportsThinking) {
      const label = metadata.name ?? humanizeModelName(modelId);
      const family = metadata?.family ?? providerConfig.label.toLowerCase();
      const maxIn = metadata?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
      const maxOut = metadata?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

      providerModels.push({
        providerId: modelId,
        apiModel: modelId,
        name: label,
        detail: `${providerConfig.label} • Standard`,
        tooltip: `${label} with thinking explicitly disabled.`,
        family,
        maxInputTokens: maxIn,
        maxOutputTokens: maxOut,
        toolCalling: true,
        thinkingEnabled: false,
        thinkingToggleSupported: true,
      });
      providerModels.push({
        providerId: `${modelId}-thinking`,
        apiModel: modelId,
        name: `${label} (Thinking)`,
        detail: `${providerConfig.label} • Reasoning`,
        tooltip: `${label} with thinking enabled.`,
        family,
        maxInputTokens: maxIn,
        maxOutputTokens: maxOut,
        toolCalling: true,
        thinkingEnabled: true,
        thinkingToggleSupported: true,
      });
      continue;
    }

    const label = metadata?.name ?? humanizeModelName(modelId);
    const family = metadata?.family ?? providerConfig.label.toLowerCase();
    const maxIn = metadata?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;
    const maxOut = metadata?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    providerModels.push({
      providerId: modelId,
      apiModel: modelId,
      name: label,
      detail: metadata?.legacy
        ? `${providerConfig.label} • Legacy`
        : `${providerConfig.label} • Chat`,
      tooltip: metadata?.legacy ? `${label} legacy model` : label,
      family,
      maxInputTokens: maxIn,
      maxOutputTokens: maxOut,
      toolCalling: true,
      thinkingEnabled: type === "anthropic" && !!metadata?.supportsThinking,
      thinkingToggleSupported: type === "openai" && !!metadata?.supportsThinking,
    });
  }

  providerModels.sort((a, b) => {
    const aKnown = KNOWN_MODELS[a.apiModel] ? 0 : 1;
    const bKnown = KNOWN_MODELS[b.apiModel] ? 0 : 1;
    if (aKnown !== bKnown) return aKnown - bKnown;
    return a.providerId.localeCompare(b.providerId);
  });
  return providerModels;
}

export { MultiChatModelProvider as DeepSeekChatModelProvider };

function humanizeModelName(modelId: string): string {
  return modelId
    .split(/[-_]/)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function convertRole(role: vscode.LanguageModelChatMessageRole): string {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return "assistant";
  }
  return "user";
}

function convertTools(
  tools: readonly vscode.LanguageModelChatTool[]
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: sanitizeSchema(tool.inputSchema),
    },
  }));
}

function sanitizeSchema(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {
    type: "object",
    properties: {},
  };
}

function convertToolChoice(
  toolMode: vscode.LanguageModelChatToolMode | undefined
): string | undefined {
  if (toolMode === undefined) {
    return undefined;
  }
  if (toolMode === vscode.LanguageModelChatToolMode.Required) {
    return "required";
  }
  if (toolMode === vscode.LanguageModelChatToolMode.Auto) {
    return "auto";
  }
  return undefined;
}

function flushBufferedToolCalls(
  bufferedToolCalls: Map<
    number,
    { id?: string; name?: string; argumentsText: string }
  >,
  progress: vscode.Progress<vscode.LanguageModelResponsePart>
): Array<{
  id: string;
  type: string;
  function: { name: string; arguments: string };
}> {
  const emitted: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }> = [];
  const sortedEntries = [...bufferedToolCalls.entries()].sort(
    (left, right) => left[0] - right[0]
  );
  for (const [index, toolCall] of sortedEntries) {
    if (!toolCall.id || !toolCall.name) {
      continue;
    }
    const parsedInput = parseToolArguments(toolCall.argumentsText);
    progress.report(
      new vscode.LanguageModelToolCallPart(
        toolCall.id,
        toolCall.name,
        parsedInput
      )
    );
    emitted.push({
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: toolCall.argumentsText,
      },
    });
    bufferedToolCalls.delete(index);
  }
  return emitted;
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  const trimmed = argumentsText.trim();
  if (trimmed.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: argumentsText };
  }
}

function serializeToolResultContent(
  content: unknown
): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((value) => {
        if (value instanceof vscode.LanguageModelTextPart) {
          return value.value;
        }
        try {
          return JSON.stringify(value);
        } catch {
          return String(value);
        }
      })
      .join("\n");
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function createAssistantSignature(
  text: string,
  toolCalls: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>
): string {
  return JSON.stringify({
    text,
    toolCalls: toolCalls.map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments,
    })),
  });
}

function estimateTokenCount(value: string): number {
  return Math.ceil(value.length / 4);
}
