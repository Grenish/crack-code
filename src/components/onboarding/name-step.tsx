import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface NameStepProps {
  onSubmit: (name: string) => void;
}

export const NameStep: React.FC<NameStepProps> = ({ onSubmit }) => {
  const [name, setName] = useState("");

  return (
    <Box flexDirection="column" marginY={1}>
      <Box>
        <Text color="grey">What should crack code call you? </Text>
      </Box>
      <Box>
        <TextInput
          value={name}
          onChange={setName}
          onSubmit={() => onSubmit(name || "John Doe")}
          placeholder="John Doe"
        />
      </Box>
    </Box>
  );
};
