import React, { useState } from "react";
import { Box, Text } from "ink";
import { AsciiLogo } from "../ascii-logo";
import { NameStep } from "./name-step";
import { ProviderStep } from "./provider-step";
import type { Provider } from "./provider-step";
import { ModelStep } from "./model-step";
import { config } from "../../config";

type Step = "name" | "provider" | "model" | "completed";

interface OnboardingProps {
  onComplete: () => void;
}

export const Onboarding: React.FC<OnboardingProps> = ({ onComplete }) => {
  const [currentStep, setCurrentStep] = useState<Step>("name");

  const [name, setName] = useState<string>("");
  const [provider, setProvider] = useState<Provider | null>(null);
  const [model, setModel] = useState<string>("");

  const handleNameSubmit = (inputName: string) => {
    setName(inputName);
    setCurrentStep("provider");
  };

  const handleProviderSubmit = (inputProvider: Provider) => {
    setProvider(inputProvider);
    if (inputProvider === "Skip") {
      finishOnboarding(name, "Skip", "");
    } else {
      setCurrentStep("model");
    }
  };

  const handleModelSubmit = (inputModel: string) => {
    setModel(inputModel);
    finishOnboarding(name, provider!, inputModel);
  };

  const finishOnboarding = (
    finalName: string,
    finalProvider: string,
    finalModel: string,
  ) => {
    config.set("name", finalName);
    config.set("provider", finalProvider);
    config.set("model", finalModel);
    config.set("setupComplete", true);

    setCurrentStep("completed");

    setTimeout(() => {
      onComplete();
    }, 1500);
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <AsciiLogo />

      {currentStep !== "completed" && (
        <Box marginBottom={1}>
          <Text>Let's set you up!</Text>
        </Box>
      )}

      {/* Render completed steps as locked-in text to match the wireframe flow */}
      {(currentStep === "provider" ||
        currentStep === "model" ||
        currentStep === "completed") && (
        <Box marginBottom={1}>
          <Text color="grey">What should crack code call you? </Text>
          <Text>{name}</Text>
        </Box>
      )}

      {(currentStep === "model" || currentStep === "completed") &&
        provider !== "Skip" && (
          <Box marginBottom={1}>
            <Text color="grey">
              Select your provider (You can configure it later as well){" "}
            </Text>
            <Text>{provider}</Text>
          </Box>
        )}

      {currentStep === "completed" && provider !== "Skip" && model && (
        <Box marginBottom={1}>
          <Text color="grey">Select your default model </Text>
          <Text>{model}</Text>
        </Box>
      )}

      {/* Render the active step */}
      {currentStep === "name" && <NameStep onSubmit={handleNameSubmit} />}
      {currentStep === "provider" && (
        <ProviderStep onSubmit={handleProviderSubmit} />
      )}
      {currentStep === "model" && provider && (
        <ModelStep provider={provider} onSubmit={handleModelSubmit} />
      )}

      {currentStep === "completed" && (
        <Box marginY={1}>
          <Text color="green">You're all set now! Happy Cracking!</Text>
        </Box>
      )}
    </Box>
  );
};
