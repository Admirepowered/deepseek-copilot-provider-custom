import * as vscode from "vscode";

/**
 * DeepSeek API client — standalone implementation with no OpenAI code reuse.
 */
export class DeepSeekApiClient {
  constructor(private output: vscode.OutputChannel) {}

  async listModels(
    baseUrl: string,
    apiKey: string,
    token: vscode.CancellationToken
  ): Promise<string[]> {
    const abortController = createAbortController(token);
    const response = await fetch(`${baseUrl}/models`, {
      headers: this.createHeaders(apiKey),
      method: "GET",
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(await this.buildErrorMessage(response, "Failed to list DeepSeek models"));
    }
    const payload = (await response.json()) as { data?: { id: string }[] };
    const models = payload.data ?? [];
    return models
      .map((model) => model.id)
      .filter((modelId, index, list) => modelId.length > 0 && list.indexOf(modelId) === index);
  }

  async *streamChatCompletion(
    baseUrl: string,
    apiKey: string,
    request: Record<string, unknown>,
    token: vscode.CancellationToken
  ): AsyncGenerator<Record<string, unknown>> {
    const abortController = createAbortController(token);
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        ...this.createHeaders(apiKey),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(await this.buildErrorMessage(response, "DeepSeek chat request failed"));
    }
    if (!response.body) {
      throw new Error("DeepSeek returned no response body.");
    }
    for await (const eventData of this.iterateSse(response.body, token)) {
      if (eventData === "[DONE]") {
        return;
      }
      try {
        yield JSON.parse(eventData) as Record<string, unknown>;
      } catch (error) {
        this.output.appendLine(
          `[DeepSeek] Failed to parse stream chunk: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  private createHeaders(apiKey: string): Record<string, string> {
    return {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
  }

  private async buildErrorMessage(response: Response, prefix: string): Promise<string> {
    try {
      const payload = (await response.json()) as { error?: { message?: string }; message?: string };
      const message = payload.error?.message ?? payload.message;
      if (message) {
        return `${prefix}: ${message}`;
      }
    } catch {
      // Ignore JSON parsing errors and fall back to status text.
    }
    return `${prefix}: ${response.status} ${response.statusText}`;
  }

  private async *iterateSse(
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
        if (done) {
          break;
        }
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
}

function createAbortController(token: vscode.CancellationToken): AbortController {
  const abortController = new AbortController();
  token.onCancellationRequested(() => abortController.abort());
  return abortController;
}
