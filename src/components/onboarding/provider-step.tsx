import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";

export type Provider =
  | "OpenAI"
  | "Google"
  | "Anthropic"
  | "VertexAI"
  | "Ollama"
  | "Skip";

interface ProviderStepProps {
  onSubmit: (provider: Provider) => void;
}

const items = [
  { label: "OpenAI      ChatGPT(gpt-5.1, gpt-5.2, etc)", value: "OpenAI" },
  {
    label: "Google      Gemini(gemini-2.5-pro, gemini-3-pro, etc)",
    value: "Google",
  },
  {
    label: "Anthropic   Claude(claude-opus-4, claude-opus-4.5, etc)",
    value: "Anthropic",
  },
  {
    label: "VertexAI    Gemini(gemini-2.5-pro, gemini-3-pro, etc)",
    value: "VertexAI",
  },
  {
    label:
      "Ollama      Local LLMs with tool calling(deepseek-v3, qwen3-32b, etc)",
    value: "Ollama",
  },
  { label: "Skip", value: "Skip" },
];

export const ProviderStep: React.FC<ProviderStepProps> = ({ onSubmit }) => {
  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="grey">
        Select your provider (You can configure it later as well)
      </Text>
      <Box paddingLeft={2} marginY={1}>
        <SelectInput
          items={items}
          onSelect={(item) => onSubmit(item.value as Provider)}
        />
      </Box>
    </Box>
  );
};
