import React from "react";
import { Box } from "ink";
import Gradient from "ink-gradient";
import BigText from "ink-big-text";

export const AsciiLogo: React.FC = () => {
  return (
    <Box marginX={1} marginBottom={1}>
      <Gradient name="pastel">
        <BigText text="Crack Code" font="chrome" />
      </Gradient>
    </Box>
  );
};
