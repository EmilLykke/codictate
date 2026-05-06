import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { Provider as TooltipProvider } from "@radix-ui/react-tooltip";
import "@fontsource/iceland/400.css";
import "@fontsource/iceberg/400.css";
import "./index.css";
import App from "./App";
import { ThemeProvider } from "./hooks/useTheme";
// Importing queryClient also triggers the Electroview bridge initialisation in rpc.ts
import { queryClient } from "./rpc";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delayDuration={0} skipDelayDuration={300}>
          <App />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
