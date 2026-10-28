import React from 'react';
import ReactDOM from 'react-dom/client';

import { ErrorBoundary, RootErrorFallback } from '@/components/ErrorBoundary';
import { reportError } from '@/lib/error-reporting';
import { ensureMonacoInitialized } from '@/lib/monaco-loader';
import { shouldSuppressRendererError } from '@/lib/non-actionable-error';
import { applyPalette, getActivePalette, readStoredPaletteId } from '@/lib/palette-runtime';
import { applyAccent, readStoredAccent } from '@/lib/primary-color';
import { startRendererDiagnostics } from '@/lib/renderer-diagnostics';

import App from './App';

import './styles/globals.css';

// Restore the experimental palette and accent before React mounts so the initial
// paint uses the chosen surface tokens. applyPalette also sets the `dark`/`light`
// class on documentElement based on the palette's mode.
applyPalette(readStoredPaletteId());
const storedAccent = readStoredAccent();
if (storedAccent) applyAccent(storedAccent, getActivePalette().mode);

// Global error handler for uncaught renderer errors
window.addEventListener('error', (event) => {
  if (event.error instanceof Error) {
    if (shouldSuppressRendererError(event.error)) {
      event.preventDefault();
      return;
    }
    reportError(event.error, 'uncaughtException');
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const error = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
  if (shouldSuppressRendererError(error)) {
    event.preventDefault();
    return;
  }
  reportError(error, 'unhandledRejection');
});

startRendererDiagnostics();

// In demo mode, warm Monaco eagerly so the first file viewer / inline preview
// mount during recording isn't blocked on the heavy first-time init.
if (window.__KOMLA_IS_DEMO__) {
  void ensureMonacoInitialized();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary fallback={(error) => <RootErrorFallback error={error} />}>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
