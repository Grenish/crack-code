#!/usr/bin/env bun
import React from "react";
import { render } from "ink";
import { App } from "./app";

const clearTerminal = () => {
  process.stdout.write(
    process.platform === "win32" ? "\x1B[2J\x1B[0f" : "\x1B[2J\x1B[3J\x1B[H",
  );
};

clearTerminal();
render(<App />);
