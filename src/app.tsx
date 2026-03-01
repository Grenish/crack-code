import React, { useState } from "react";
import { Onboarding } from "./components/onboarding";
import { Dashboard } from "./components/dashboard";
import { config } from "./config";

export const App: React.FC = () => {
  const [setupComplete, setSetupComplete] = useState<boolean>(
    config.get("setupComplete") || false,
  );

  return setupComplete ? (
    <Dashboard />
  ) : (
    <Onboarding onComplete={() => setSetupComplete(true)} />
  );
};
