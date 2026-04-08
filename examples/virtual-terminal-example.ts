/**
 * Virtual Terminal Tool - Usage Examples
 *
 * This file demonstrates how to use the virtual_terminal tool
 * in Crack Code for persistent shell execution with maintained state.
 */

// ────────────────────────────────────────────────────────────────
// EXAMPLE 1: Basic Navigation
// ────────────────────────────────────────────────────────────────

// Instead of:
// run_command "cd src && ls -la"
// run_command "cd src && cat index.ts"

// Use virtual_terminal for persistent context:
const example1Commands = [
  "virtual_terminal: cd src",
  "virtual_terminal: pwd",          // outputs: /path/to/project/src
  "virtual_terminal: ls -la",
  "virtual_terminal: cd components",
  "virtual_terminal: pwd",          // outputs: /path/to/project/src/components
];

// ────────────────────────────────────────────────────────────────
// EXAMPLE 2: Environment Variables
// ────────────────────────────────────────────────────────────────

const example2Commands = [
  "virtual_terminal: env DATABASE_URL=postgres://localhost:5432/mydb",
  "virtual_terminal: env NODE_ENV=production",
  "virtual_terminal: npm run migrate",     // uses DATABASE_URL
  "virtual_terminal: npm run seed",        // uses DATABASE_URL
  "virtual_terminal: env",                 // list all env vars
];

// ────────────────────────────────────────────────────────────────
// EXAMPLE 3: Multi-Step Build Process
// ────────────────────────────────────────────────────────────────

const example3Commands = [
  "virtual_terminal: cd packages/api",
  "virtual_terminal: npm install",
  "virtual_terminal: npm run build",
  "virtual_terminal: npm run test",
  "virtual_terminal: npm run lint",
];

// ────────────────────────────────────────────────────────────────
// EXAMPLE 4: History Tracking
// ────────────────────────────────────────────────────────────────

const example4Commands = [
  "virtual_terminal: cd src/auth",
  "virtual_terminal: ls -la",
  "virtual_terminal: cat login.ts",
  "virtual_terminal: grep -n 'password' auth.ts",
  "virtual_terminal: history",      // shows all recent commands
  "virtual_terminal: history clear", // clears history
];

// ────────────────────────────────────────────────────────────────
// EXAMPLE 5: Real-world Audit Scenario
// ────────────────────────────────────────────────────────────────

const example5Scenario = {
  userRequest: "Scan src/auth for vulnerabilities and run tests",
  agentWorkflow: [
    // 1. Navigate to target directory
    {
      tool: "virtual_terminal",
      command: "cd src/auth",
      output: "Changed directory to: /path/to/project/src/auth"
    },

    // 2. List files for analysis
    {
      tool: "virtual_terminal",
      command: "ls -la",
      output: "total 48\n-rw-r--r-- 1 user user 2048 Jan 15 10:00 login.ts\n-rw-r--r-- 1 user user 1024 Jan 15 10:00 verify.ts\n..."
    },

    // 3. Read key file
    {
      tool: "read_file",
      path: "login.ts",  // can use relative path now
      output: "import crypto from 'crypto';\n..."
    },

    // 4. Check dependencies
    {
      tool: "virtual_terminal",
      command: "npm list",
      output: "crypto-js@4.1.0\njwt-simple@0.5.6\n..."
    },

    // 5. Run security tests
    {
      tool: "virtual_terminal",
      command: "npm run test:security",
      output: "Exit code: 0\nstdout:\n✓ All security tests passed"
    },
  ]
};

// ────────────────────────────────────────────────────────────────
// EXAMPLE 6: Error Handling
// ────────────────────────────────────────────────────────────────

const example6Commands = [
  // This fails - can't escape project root
  {
    command: "virtual_terminal: cd /etc",
    expectedError: "Error: Cannot cd outside project root. Attempted: /etc"
  },

  // This fails - directory doesn't exist
  {
    command: "virtual_terminal: cd nonexistent",
    expectedError: "Error: Directory not found: nonexistent"
  },

  // This fails - invalid env assignment
  {
    command: "virtual_terminal: env INVALID",
    expectedError: "Error: invalid env assignment. Use 'env KEY=VALUE'"
  },
];

// ────────────────────────────────────────────────────────────────
// EXAMPLE 7: Comparing with run_command
// ────────────────────────────────────────────────────────────────

const comparisonExample = {
  "Problem: Run tests in src/tests directory": {
    "With run_command (old way)": [
      "run_command: cd src/tests && npm test",    // path repeated
      "run_command: cd src/tests && npm run lint", // path repeated again
      "run_command: cd src/tests && cat jest.config.js" // path repeated
    ],
    "With virtual_terminal (new way)": [
      "virtual_terminal: cd src/tests",    // change once
      "virtual_terminal: npm test",         // path maintained
      "virtual_terminal: npm run lint",     // path maintained
      "virtual_terminal: cat jest.config.js" // path maintained
    ]
  }
};

// ────────────────────────────────────────────────────────────────
// EXAMPLE 8: Built-in Commands Reference
// ────────────────────────────────────────────────────────────────

const builtInCommands = {
  navigation: {
    "cd <path>": "Change directory (must be within project root)",
    "pwd": "Print working directory"
  },

  environment: {
    "env": "List all environment variables",
    "env KEY=VALUE": "Set an environment variable",
    "unset KEY": "Delete an environment variable"
  },

  history: {
    "history": "Show recent 20 commands executed",
    "history clear": "Clear command history"
  },

  shell: {
    "<any shell command>": "Execute regular shell command in current context"
  }
};

// ────────────────────────────────────────────────────────────────
// EXAMPLE 9: Complex Workflow
// ────────────────────────────────────────────────────────────────

const complexWorkflow = {
  goal: "Setup, build, test, and deploy staging environment",
  steps: [
    // Setup environment
    "virtual_terminal: cd packages/api",
    "virtual_terminal: env ENVIRONMENT=staging",
    "virtual_terminal: env LOG_LEVEL=debug",

    // Install and build
    "virtual_terminal: npm install",
    "virtual_terminal: npm run build",
    "virtual_terminal: npm run compile",

    // Run tests
    "virtual_terminal: npm test",
    "virtual_terminal: npm run test:integration",

    // Check git status
    "virtual_terminal: git status",

    // Deploy
    "virtual_terminal: npm run deploy",  // Uses ENVIRONMENT=staging from earlier

    // Verify
    "virtual_terminal: npm run health-check",

    // View history of what was done
    "virtual_terminal: history"
  ]
};

// ────────────────────────────────────────────────────────────────
// EXAMPLE 10: Per-Session Persistence
// ────────────────────────────────────────────────────────────────

const persistenceNotes = {
  "Session Lifecycle": {
    "✓ Persists within": "Single agent/REPL session",
    "✓ Persists across": "Multiple tool invocations in same session",
    "✗ Does NOT persist": "Between separate CLI invocations or new sessions"
  },

  "Example Timeline": {
    "Session 1": {
      "command 1": "virtual_terminal: cd src",
      "command 2": "virtual_terminal: pwd",
      "result": "pwd returns /path/to/project/src (state maintained)"
    },
    "Session 2 (new REPL)": {
      "command 1": "virtual_terminal: pwd",
      "result": "pwd returns /path/to/project (fresh state, back to root)"
    }
  }
};

// ────────────────────────────────────────────────────────────────
// IMPLEMENTATION ARCHITECTURE
// ────────────────────────────────────────────────────────────────

const architecture = {
  "VirtualTerminal Class (virtual-terminal-state.ts)": {
    "Responsibilities": [
      "Track current working directory",
      "Maintain environment variables",
      "Store command history",
      "Validate paths (prevent escaping project root)",
      "Provide state snapshots"
    ],
    "Key Methods": [
      "getCwd() - Get current directory",
      "changeDir(path) - Change directory with validation",
      "setEnv(key, value) - Set environment variable",
      "getEnv() - Get all environment variables",
      "addToHistory(command) - Add to command history",
      "getHistory() - Get full history",
      "reset() - Reset to initial state"
    ]
  },

  "Virtual Terminal Tool (virtual-terminal.ts)": {
    "Responsibilities": [
      "Parse and execute tool calls",
      "Handle built-in commands (cd, pwd, env, history)",
      "Delegate to shell for regular commands",
      "Format output (exit code, stdout, stderr)",
      "Track command in history"
    ],
    "Integration": "Registered in index.ts tool registry"
  },

  "Global Instance Pattern": {
    "Pattern": "Singleton instance per session",
    "Access": "getGlobalTerminal() function",
    "Scope": "Shared across all tool invocations in session",
    "Cleanup": "destroyGlobalTerminal() for testing"
  }
};

// ────────────────────────────────────────────────────────────────
// When to use which tool
// ────────────────────────────────────────────────────────────────

const toolSelection = {
  "use virtual_terminal when": [
    "Running multiple commands in the same directory",
    "Need environment variables to persist",
    "Building multi-step workflows",
    "Exploring project structure with navigation",
    "Working with related files in same location"
  ],

  "use run_command when": [
    "Just need to execute a single command",
    "Don't care about environment state",
    "Running independent operations",
    "Working across different directories",
    "Each command is completely isolated"
  ]
};

export {
  example1Commands,
  example2Commands,
  example3Commands,
  example4Commands,
  example5Scenario,
  example6Commands,
  comparisonExample,
  builtInCommands,
  complexWorkflow,
  persistenceNotes,
  architecture,
  toolSelection
};
