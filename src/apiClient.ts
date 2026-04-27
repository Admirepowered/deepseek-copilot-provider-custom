import * as vscode from "vscode";
import { ProviderType } from "./config";

/**
 * Unified API client that handles OpenAI-compatible, Anthropic Messages, and
 * OpenAI Codex endpoints — all streaming via SSE.
 */
export class ApiClient {
  constructor(private output: vscode.OutputChannel) {}

  // ── Model listing ──────────────────────────────────────────

  async listModels(
    baseUrl: string,
    apiKey: string,
    type: ProviderType,
    token: vscode.CancellationToken
  ): Promise<string[]> {
    if (type === "anthropic") {
      // Anthropic doesn't have a public /models endpoint; return empty so we use fallback
      this.output.appendLine(`[ApiClient] Anthropic type — skipping /models, using fallback models`);
      return [];
    }

    const url = `${baseUrl}/v1/models`;
    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    if (type === "codex") {
      headers["x-api-key"] = apiKey;
      headers["Authorization"] = `Bearer ${apiKey}`;
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const abortController = createAbortController(token);
    const timeoutId = setTimeout(() => abortController.abort(), 30_000);
    const response = await fetch(url, { headers, method: "GET", signal: abortController.signal }).finally(() => clearTimeout(timeoutId));

    if (!response.ok) {
      throw new Error(await buildErrorMessage(response, `Failed to list models from ${baseUrl}`));
    }

    const payload = (await response.json()) as { data?: { id: string }[]; models?: { id: string }[] };
    // OpenAI /v1/models returns { data: [...] } or { models: [...] }
    const models = payload.data ?? payload.models ?? [];
    return models
      .map((m: { id: string }) => m.id)
      .filter((id: string, i: number, arr: string[]) => id.length > 0 && arr.indexOf(id) === i);
  }

  // ── Streaming chat completion ──────────────────────────────

  async *streamChatCompletion(
    baseUrl: string,
    apiKey: string,
    type: ProviderType,
    request: Record<string, unknown>,
    token: vscode.CancellationToken
  ): AsyncGenerator<Record<string, unknown>> {
    if (type === "anthropic") {
      yield* this.streamAnthropic(baseUrl, apiKey, request, token);
    } else if (type === "codex") {
      yield* this.streamCodex(baseUrl, apiKey, request, token);
    } else {
      yield* this.streamOpenAI(baseUrl, apiKey, request, token);
    }
  }

  // ── OpenAI-compatible (DeepSeek, etc.) ─────────────────────

  private async *streamOpenAI(
    baseUrl: string,
    apiKey: string,
    request: Record<string, unknown>,
    token: vscode.CancellationToken
  ): AsyncGenerator<Record<string, unknown>> {
    const abortController = createAbortController(token);
    const timeoutId = setTimeout(() => abortController.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "x-api-key": apiKey,
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: abortController.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `OpenAI connection failed (${baseUrl}/chat/completions): ${msg}. ` +
        `Check your network, base URL, and proxy settings.`
      );
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(await buildErrorMessage(response, "OpenAI chat request failed"));
    }
    if (!response.body) {
      throw new Error("OpenAI returned no response body.");
    }

    for await (const eventData of iterateSse(response.body, token)) {
      if (eventData === "[DONE]") return;
      try {
        yield JSON.parse(eventData) as Record<string, unknown>;
      } catch (error) {
        this.output.appendLine(
          `[ApiClient] Failed to parse stream chunk: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  // ── Anthropic Messages API ─────────────────────────────────

  private async *streamAnthropic(
    baseUrl: string,
    apiKey: string,
    request: Record<string, unknown>,
    token: vscode.CancellationToken
  ): AsyncGenerator<Record<string, unknown>> {
    const body = convertToAnthropicRequest(request);
    const abortController = createAbortController(token);
    const anthropicVersion = "2023-06-01";

    const headers: Record<string, string> = {
      "x-api-key": apiKey,
      "anthropic-version": anthropicVersion,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    };
    if (body.thinking && (body.thinking as Record<string, unknown>).type === "enabled") {
      headers["anthropic-beta"] = "thinking-2025-04-15";
    }

    const timeoutId = setTimeout(() => abortController.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abortController.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Anthropic connection failed (${baseUrl}/v1/messages): ${msg}. ` +
        `Check your network, base URL, and proxy settings.`
      );
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(await buildErrorMessage(response, "Anthropic chat request failed"));
    }
    if (!response.body) {
      throw new Error("Anthropic returned no response body.");
    }

    // Anthropic SSE — yields events like:
    //   event: message_start / content_block_start / content_block_delta / message_delta / message_stop / ping
    // We convert each content_block_delta into the OpenAI shape { choices: [{ delta: { content: "..." } }] }
    // and message_stop into [DONE]
    for await (const rawEvent of iterateSseAnthropic(response.body, token)) {
      if (rawEvent === "[DONE]") return;

      try {
        const event = JSON.parse(rawEvent) as Record<string, unknown>;
        const eventType = event.type as string;

        if (eventType === "content_block_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta") {
            yield {
              choices: [{ delta: { content: delta.text as string } }],
            };
          } else if (delta?.type === "thinking_delta") {
            yield {
              choices: [{ delta: { reasoning_content: delta.thinking as string } }],
            };
          } else if (delta?.type === "input_json_delta") {
            // Tool use input JSON delta — accumulate into tool_calls
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: (event as Record<string, unknown>).index ?? 0,
                        function: { arguments: delta.partial_json as string },
                      },
                    ],
                  },
                },
              ],
            };
          }
        } else if (eventType === "content_block_start") {
          const contentBlock = event.content_block as Record<string, unknown> | undefined;
          if (contentBlock?.type === "tool_use") {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: (event as Record<string, unknown>).index ?? 0,
                        id: contentBlock.id as string,
                        function: { name: contentBlock.name as string, arguments: "" },
                      },
                    ],
                  },
                },
              ],
            };
          }
        } else if (eventType === "message_delta") {
          const delta = event.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason === "tool_use") {
            yield {
              choices: [{ finish_reason: "tool_calls", delta: {} }],
            };
          } else if (delta?.stop_reason) {
            yield {
              choices: [{ finish_reason: "stop", delta: {} }],
            };
          }
        }
      } catch (error) {
        this.output.appendLine(
          `[ApiClient] Failed to parse Anthropic stream chunk: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  // ── OpenAI Codex API ───────────────────────────────────────

  private async *streamCodex(
    baseUrl: string,
    apiKey: string,
    request: Record<string, unknown>,
    token: vscode.CancellationToken
  ): AsyncGenerator<Record<string, unknown>> {
    const abortController = createAbortController(token);
    const timeoutId = setTimeout(() => abortController.abort(), 120_000);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "x-api-key": apiKey,
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal: abortController.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Codex connection failed (${baseUrl}/v1/chat/completions): ${msg}. ` +
        `Check your network, base URL, and proxy settings.`
      );
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(await buildErrorMessage(response, "Codex chat request failed"));
    }
    if (!response.body) {
      throw new Error("Codex returned no response body.");
    }

    for await (const eventData of iterateSse(response.body, token)) {
      if (eventData === "[DONE]") return;
      try {
        yield JSON.parse(eventData) as Record<string, unknown>;
      } catch (error) {
        this.output.appendLine(
          `[ApiClient] Failed to parse Codex stream chunk: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
}

// ── Anthropic request converter ───────────────────────────────

function convertToAnthropicRequest(
  openAiRequest: Record<string, unknown>
): Record<string, unknown> {
  const messages = (openAiRequest.messages as Array<Record<string, unknown>>) ?? [];
  const model = openAiRequest.model as string;
  const maxTokens = (openAiRequest.max_tokens as number) ?? 8192;
  const temperature = openAiRequest.temperature as number | undefined;
  const topP = openAiRequest.top_p as number | undefined;
  const tools = openAiRequest.tools as Array<Record<string, unknown>> | undefined;

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: convertMessagesToAnthropic(messages),
    stream: true,
  };

  if (temperature !== undefined) body.temperature = temperature;
  if (topP !== undefined) body.top_p = topP;
  if (tools && tools.length > 0) {
    body.tools = tools.map(convertToolToAnthropic);
  }
  if (openAiRequest.tool_choice) {
    body.tool_choice = convertToolChoiceToAnthropic(openAiRequest.tool_choice);
  }
  if (openAiRequest.stop) {
    body.stop_sequences = Array.isArray(openAiRequest.stop)
      ? openAiRequest.stop
      : [openAiRequest.stop];
  }
  if (openAiRequest.thinking) {
    const thinking = openAiRequest.thinking as Record<string, unknown>;
    if (thinking.type === "enabled") {
      body.thinking = { type: "enabled", budget_tokens: 4000 };
    } else {
      body.thinking = { type: "disabled" };
    }
  }

  return body;
}

function convertMessagesToAnthropic(
  messages: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = msg.role as string;
    const content = msg.content as string | null;

    if (role === "user") {
      result.push({ role: "user", content: content ?? "" });
    } else if (role === "assistant") {
      const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;
      const reasoningContent = msg.reasoning_content as string | undefined;
      const hasToolCalls = toolCalls && toolCalls.length > 0;
      const hasReasoning = !!reasoningContent;
      const textContent = content || "";

      if (hasToolCalls || hasReasoning) {
        // Anthropic requires content to be an array of content blocks
        const contentBlocks: Array<Record<string, unknown>> = [];
        if (reasoningContent) {
          contentBlocks.push({ type: "thinking", thinking: reasoningContent });
        }
        if (textContent) {
          contentBlocks.push({ type: "text", text: textContent });
        }
        if (toolCalls) {
          for (const tc of toolCalls) {
            const fn = tc.function as Record<string, unknown>;
            contentBlocks.push({
              type: "tool_use",
              id: tc.id,
              name: fn?.name,
              input: safeParseJson(fn?.arguments as string),
            });
          }
        }
        result.push({ role: "assistant", content: contentBlocks });
      } else {
        result.push({ role: "assistant", content: textContent });
      }
    } else if (role === "tool") {
      result.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content: msg.content ?? "",
          },
        ],
      });
    }
  }

  return result;
}

function convertToolToAnthropic(
  tool: Record<string, unknown>
): Record<string, unknown> {
  const fn = tool.function as Record<string, unknown> | undefined;
  return {
    name: fn?.name ?? tool.name,
    description: fn?.description ?? tool.description,
    input_schema: fn?.parameters ?? tool.input_schema ?? { type: "object", properties: {} },
  };
}

function convertToolChoiceToAnthropic(
  toolChoice: unknown
): Record<string, unknown> {
  if (typeof toolChoice === "string") {
    if (toolChoice === "required") return { type: "any" };
    if (toolChoice === "auto") return { type: "auto" };
    return { type: "auto" };
  }
  return { type: "auto" };
}

function safeParseJson(raw: string | undefined): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

// ── SSE iteration ─────────────────────────────────────────────

async function* iterateSse(
  stream: ReadableStream<Uint8Array>,
  token: vscode.CancellationToken
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (token.isCancellationRequested) {
        await reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundaryIndex = buffer.indexOf("\n\n");
      while (boundaryIndex >= 0) {
        const rawEvent = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .filter((line) => line.length > 0);
        if (dataLines.length > 0) {
          yield dataLines.join("\n");
        }
        boundaryIndex = buffer.indexOf("\n\n");
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      yield tail.slice(5).trim();
    }
  } finally {
    reader.releaseLock();
  }
}

// Anthropic SSE is slightly different: event lines come before data lines
async function* iterateSseAnthropic(
  stream: ReadableStream<Uint8Array>,
  token: vscode.CancellationToken
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (token.isCancellationRequested) {
        await reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundaryIndex = buffer.indexOf("\n\n");
      while (boundaryIndex >= 0) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);

        const lines = block.split("\n");
        let eventType = "";
        let dataText = "";

        for (const line of lines) {
          if (line.startsWith("event:")) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            dataText = line.slice(5).trim();
          }
        }

        if (eventType === "message_stop" || eventType === "error") {
          yield "[DONE]";
        } else if (dataText.length > 0) {
          yield dataText;
        }

        boundaryIndex = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Helpers ───────────────────────────────────────────────────

function createAbortController(token: vscode.CancellationToken): AbortController {
  const abortController = new AbortController();
  token.onCancellationRequested(() => abortController.abort());
  return abortController;
}

async function buildErrorMessage(response: Response, prefix: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string }; message?: string };
    const message = payload.error?.message ?? payload.message;
    if (message) return `${prefix}: ${message}`;
  } catch {
    // ignore parse errors
  }
  return `${prefix}: ${response.status} ${response.statusText}`;
}
