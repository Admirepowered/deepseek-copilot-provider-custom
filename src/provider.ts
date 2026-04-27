import * as vscode from "vscode";
import { getSettings, getApiKey } from "./config";
import { DeepSeekClient } from "./deepseekClient";

const DEFAULT_MAX_INPUT_TOKENS = 200000;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

interface KnownModel {
  name: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportsThinking: boolean;
  legacy?: boolean;
}

const KNOWN_MODELS: Record<string, KnownModel> = {
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
  },
  "deepseek-chat": {
    name: "DeepSeek Chat",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: false,
    legacy: true,
  },
  "deepseek-reasoner": {
    name: "DeepSeek Reasoner",
    maxInputTokens: 1_000_000,
    maxOutputTokens: 384_000,
    supportsThinking: true,
    legacy: true,
  },
};

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

export class DeepSeekChatModelProvider
  implements vscode.LanguageModelChatProvider<vscode.LanguageModelChatInformation>
{
  private onDidChangeEmitter = new vscode.EventEmitter<void>();
  onDidChangeLanguageModelChatInformation = this.onDidChangeEmitter.event;

  private client: DeepSeekClient;
  private modelsById = new Map<string, ProviderModel>();
  private reasoningByAssistantSignature = new Map<string, string>();

  constructor(
    private secrets: vscode.SecretStorage,
    private output: vscode.OutputChannel
  ) {
    this.client = new DeepSeekClient(output);
  }

  dispose(): void {
    this.onDidChangeEmitter.dispose();
  }

  notifyModelInformationChanged(reason?: string): void {
    const suffix = reason ? `: ${reason}` : "";
    this.output.appendLine(`[DeepSeek] Refreshing model list${suffix}`);
    this.onDidChangeEmitter.fire();
  }

  async provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const apiKey = await getApiKey(this.secrets);
    if (!apiKey) {
      if (!options.silent) {
        const action = await vscode.window.showInformationMessage(
          "DeepSeek Provider requires an API key before its models can appear in GitHub Copilot Chat.",
          "Configure DeepSeek"
        );
        if (action === "Configure DeepSeek") {
          await vscode.commands.executeCommand("deepseek.manage");
        }
      }
      return [];
    }

    const settings = getSettings();
    let remoteModelIds: string[] = [];
    try {
      remoteModelIds = await this.client.listModels(settings.baseUrl, apiKey, token);
    } catch (error) {
      this.output.appendLine(
        `[DeepSeek] Failed to fetch /models. Falling back to configured model IDs. ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      if (!options.silent) {
        vscode.window.showWarningMessage(
          `DeepSeek model discovery failed, using fallback model IDs instead. ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    const providerModels = buildProviderModels([...remoteModelIds, ...settings.modelIds]);
    this.modelsById.clear();
    for (const providerModel of providerModels) {
      this.modelsById.set(providerModel.providerId, providerModel);
    }

    return providerModels.map((providerModel) => ({
      id: providerModel.providerId,
      name: providerModel.name,
      detail: providerModel.detail,
      tooltip: providerModel.tooltip,
      family: providerModel.family,
      version: "2026.04",
      maxInputTokens: providerModel.maxInputTokens,
      maxOutputTokens: providerModel.maxOutputTokens,
      capabilities: {
        toolCalling: providerModel.toolCalling,
      },
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const apiKey = await getApiKey(this.secrets);
    if (!apiKey) {
      throw new Error("DeepSeek API key is not configured.");
    }

    const settings = getSettings();
    const providerModel =
      this.modelsById.get(model.id) ?? buildProviderModels([model.id])[0];

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
      request.stop = modelOptions.stop.filter(
        (value: unknown) => typeof value === "string"
      );
    }

    if (providerModel.thinkingToggleSupported) {
      request.thinking = {
        type: providerModel.thinkingEnabled ? "enabled" : "disabled",
      };
    }

    if (providerModel.thinkingEnabled) {
      request.reasoning_effort = settings.reasoningEffort;
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
    let responseText = "";
    let reasoningContent = "";

    for await (const chunk of this.client.streamChatCompletion(
      settings.baseUrl,
      apiKey,
      request,
      token
    )) {
      for (const choice of (chunk.choices as Array<Record<string, unknown>>) ?? []) {
        const delta = choice.delta as Record<string, unknown> | undefined;
        if (!delta) {
          continue;
        }

        if (typeof delta.reasoning_content === "string") {
          reasoningContent += delta.reasoning_content;
        }

        if (typeof delta.content === "string" && delta.content.length > 0) {
          responseText += delta.content;
          progress.report(new vscode.LanguageModelTextPart(delta.content));
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls as Array<Record<string, unknown>>) {
            const buffer = bufferedToolCalls.get(toolCall.index as number) ?? {
              argumentsText: "",
            };
            if (toolCall.id) {
              buffer.id = toolCall.id as string;
            }
            const fn = toolCall.function as Record<string, unknown> | undefined;
            if (fn?.name) {
              buffer.name = fn.name as string;
            }
            if (fn?.arguments) {
              buffer.argumentsText += fn.arguments as string;
            }
            bufferedToolCalls.set(toolCall.index as number, buffer);
          }
        }

        if (choice.finish_reason === "tool_calls") {
          for (const toolCall of flushBufferedToolCalls(bufferedToolCalls, progress)) {
            emittedToolCalls.push(toolCall);
          }
        }
      }
    }

    for (const toolCall of flushBufferedToolCalls(bufferedToolCalls, progress)) {
      emittedToolCalls.push(toolCall);
    }

    if (
      providerModel.thinkingEnabled &&
      emittedToolCalls.length > 0 &&
      reasoningContent.trim().length > 0
    ) {
      const signature = createAssistantSignature(responseText, emittedToolCalls);
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

function buildProviderModels(modelIds: string[]): ProviderModel[] {
  const uniqueModelIds = modelIds
    .map((modelId) => modelId.trim())
    .filter(
      (modelId, index, list) =>
        modelId.length > 0 && list.indexOf(modelId) === index
    );

  const providerModels: ProviderModel[] = [];

  for (const modelId of uniqueModelIds) {
    const metadata = KNOWN_MODELS[modelId];

    if (modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro") {
      providerModels.push({
        providerId: modelId,
        apiModel: modelId,
        name: metadata.name,
        detail: "DeepSeek • Standard",
        tooltip: `${metadata.name} with thinking explicitly disabled. Use this when you want tool use to behave predictably in Copilot Chat.`,
        family: "deepseek",
        maxInputTokens: metadata.maxInputTokens,
        maxOutputTokens: metadata.maxOutputTokens,
        toolCalling: true,
        thinkingEnabled: false,
        thinkingToggleSupported: true,
      });
      providerModels.push({
        providerId: `${modelId}-thinking`,
        apiModel: modelId,
        name: `${metadata.name} (Thinking)`,
        detail: "DeepSeek • Reasoning",
        tooltip: `${metadata.name} with thinking enabled.`,
        family: "deepseek",
        maxInputTokens: metadata.maxInputTokens,
        maxOutputTokens: metadata.maxOutputTokens,
        toolCalling: true,
        thinkingEnabled: true,
        thinkingToggleSupported: true,
      });
      continue;
    }

    if (modelId === "deepseek-chat") {
      providerModels.push({
        providerId: modelId,
        apiModel: "deepseek-v4-flash",
        name: "DeepSeek Chat (Legacy Alias)",
        detail: "DeepSeek • Legacy standard alias",
        tooltip:
          "Compatibility alias that maps to DeepSeek V4 Flash with thinking disabled. DeepSeek plans to deprecate this alias on 2026-07-24.",
        family: "deepseek",
        maxInputTokens: metadata.maxInputTokens,
        maxOutputTokens: metadata.maxOutputTokens,
        toolCalling: true,
        thinkingEnabled: false,
        thinkingToggleSupported: true,
      });
      continue;
    }

    if (modelId === "deepseek-reasoner") {
      providerModels.push({
        providerId: modelId,
        apiModel: "deepseek-v4-flash",
        name: "DeepSeek Reasoner (Legacy Alias)",
        detail: "DeepSeek • Legacy reasoning alias",
        tooltip:
          "Compatibility alias that maps to DeepSeek V4 Flash with thinking enabled. DeepSeek plans to deprecate this alias on 2026-07-24.",
        family: "deepseek",
        maxInputTokens: metadata.maxInputTokens,
        maxOutputTokens: metadata.maxOutputTokens,
        toolCalling: true,
        thinkingEnabled: true,
        thinkingToggleSupported: true,
      });
      continue;
    }

    providerModels.push({
      providerId: modelId,
      apiModel: modelId,
      name: metadata?.name ?? humanizeModelName(modelId),
      detail: metadata?.legacy ? "DeepSeek • Legacy" : "DeepSeek • Custom",
      tooltip: metadata?.legacy
        ? `${metadata.name} legacy model`
        : `Custom DeepSeek model ID: ${modelId}`,
      family: "deepseek",
      maxInputTokens: metadata?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
      maxOutputTokens: metadata?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      toolCalling: true,
      thinkingEnabled: false,
      thinkingToggleSupported: false,
    });
  }

  providerModels.sort((left, right) =>
    compareModels(left.providerId, right.providerId)
  );
  return providerModels;
}

function compareModels(left: string, right: string): number {
  const order: Record<string, number> = {
    "deepseek-v4-flash": 0,
    "deepseek-v4-flash-thinking": 1,
    "deepseek-v4-pro": 2,
    "deepseek-v4-pro-thinking": 3,
    "deepseek-chat": 4,
    "deepseek-reasoner": 5,
  };
  const leftOrder = order[left] ?? 100;
  const rightOrder = order[right] ?? 100;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.localeCompare(right);
}

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
