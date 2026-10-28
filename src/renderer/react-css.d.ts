import 'react';

declare module 'react' {
  interface CSSProperties {
    /** Electron's drag region for frameless windows. */
    WebkitAppRegion?: 'drag' | 'no-drag';
  }
}
