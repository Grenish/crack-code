import React from "react";
import { Box, Text } from "ink";
import { AsciiLogo } from "../ascii-logo";
import { config } from "../../config";

export const Dashboard: React.FC = () => {
  const name = config.get("name") || "user";
  const provider = config.get("provider");
  const model = config.get("model");

  // A placeholder matching the ui-main.png conceptually
  return (
    <Box flexDirection="column" paddingX={1}>
      <AsciiLogo />
      <Box flexDirection="row" justifyContent="space-between" marginY={1}>
        <Box flexDirection="column">
          <Text>host: {name}</Text>
          <Text>git : no/yes (branch name)</Text>
        </Box>
        <Box>
          <Text>{model || "No model selected"}</Text>
        </Box>
      </Box>
      <Box marginY={1}>
        <Text color="grey">Hello {name}, What are we cracking today?</Text>
      </Box>
      <Box padding={1} borderStyle="single">
        <Text color="grey">type `@` for files, `/` for commands</Text>
      </Box>
    </Box>
  );
};
