# DeepSeek Provider for GitHub Copilot Chat (Custom)

DeepSeek Provider for GitHub Copilot Chat brings DeepSeek models into the GitHub Copilot Chat model picker through VS Code's official Language Model Chat Provider API.

This extension does not patch or replace GitHub Copilot. It contributes DeepSeek as a first-class language model provider that works with the existing Copilot Chat experience.

## Features

- Exposes DeepSeek models directly in the GitHub Copilot Chat model selector
- Connects to DeepSeek through the official OpenAI-compatible API
- Streams text responses in real time
- Supports tool calling so Copilot Chat features that depend on tools can keep working
- Exposes both standard and thinking variants for DeepSeek V4 models
- Preserves compatibility with the legacy DeepSeek aliases deepseek-chat and deepseek-reasoner

## Requirements

- VS Code 1.104 or newer
- GitHub Copilot Chat
- A valid DeepSeek API key

## Quick Start

1. Open the Command Palette.
2. Run Manage DeepSeek Provider.
3. Save your DeepSeek API key.
4. Open GitHub Copilot Chat and pick a DeepSeek model from the model selector.

## Settings

- `languageModelChatProvider.deepseek.baseUrl`
- `languageModelChatProvider.deepseek.modelIds`
- `languageModelChatProvider.deepseek.reasoningEffort`

The default API base URL is https://api.deepseek.com.

## Development

```powershell
npm install
npm run compile
```

Press F5 in VS Code to launch an Extension Development Host.

## Packaging

```powershell
npm install
npm run package
```
