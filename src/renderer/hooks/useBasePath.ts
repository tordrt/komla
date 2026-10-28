import { useEffect, useState } from 'react';

/**
 * Resolves the Komla data directory once on mount. Returns null until it lands.
 * Onboarding prompts need it so the agent can recover the live HTTP port from
 * `<komlaDir>/port` if the bound port has changed.
 */
export function useBasePath(): string | null {
  const [basePath, setBasePath] = useState<string | null>(null);
  useEffect(() => {
    void window.api.getBasePath().then(setBasePath);
  }, []);
  return basePath;
}
