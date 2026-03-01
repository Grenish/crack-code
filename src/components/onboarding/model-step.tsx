import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { Provider } from "./provider-step";

interface ModelStepProps {
  provider: Provider;
  onSubmit: (model: string) => void;
}

const getModelsForProvider = (provider: Provider) => {
  switch (provider) {
    case "Google":
      return [
        { label: "gemini-2.5-pro", value: "gemini-2.5-pro" },
        { label: "gemini-2.0-flash", value: "gemini-2.0-flash" },
        { label: "gemini-3-pro", value: "gemini-3-pro" },
        { label: "gemini-3.1-flash", value: "gemini-3.1-flash" },
        { label: "gemini-3-flash", value: "gemini-3-flash" },
      ];
    case "OpenAI":
      return [
        { label: "gpt-4o", value: "gpt-4o" },
        { label: "gpt-4-turbo", value: "gpt-4-turbo" },
        { label: "gpt-3.5-turbo", value: "gpt-3.5-turbo" },
      ];
    case "Anthropic":
      return [
        { label: "claude-3-opus-20240229", value: "claude-3-opus-20240229" },
        {
          label: "claude-3-sonnet-20240229",
          value: "claude-3-sonnet-20240229",
        },
        { label: "claude-3-haiku-20240307", value: "claude-3-haiku-20240307" },
      ];
    case "VertexAI":
      return [
        { label: "gemini-1.5-pro-002", value: "gemini-1.5-pro-002" },
        { label: "gemini-1.5-flash-002", value: "gemini-1.5-flash-002" },
      ];
    case "Ollama":
      return [
        { label: "deepseek-coder-v2", value: "deepseek-coder-v2" },
        { label: "qwen2.5-coder", value: "qwen2.5-coder" },
        { label: "llama3.1", value: "llama3.1" },
      ];
    default:
      return [];
  }
};

export const ModelStep: React.FC<ModelStepProps> = ({ provider, onSubmit }) => {
  const items = getModelsForProvider(provider);

  if (items.length === 0) {
    // Should not happen as we skip this step if Skip is chosen, but just in case
    return <Text color="yellow">No models available for this provider.</Text>;
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="grey">Select your default model</Text>
      <Box paddingLeft={2} marginY={1}>
        <SelectInput items={items} onSelect={(item) => onSubmit(item.value)} />
      </Box>
    </Box>
  );
};
