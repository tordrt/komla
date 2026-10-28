import React, { Component, ErrorInfo, ReactNode, useState } from 'react';

import { Button } from '@/components/ui/button';
import { reportError } from '@/lib/error-reporting';

interface Props {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error) => ReactNode);
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    reportError(error, 'errorBoundary', {
      componentStack: errorInfo.componentStack ?? undefined,
    });
  }

  render() {
    if (this.state.hasError) {
      const { fallback } = this.props;
      if (typeof fallback === 'function') {
        return fallback(this.state.error ?? new Error('Unknown error'));
      }
      if (fallback) {
        return fallback;
      }
      return (
        <div className="flex h-full items-center justify-center p-4">
          <div className="text-center">
            <h2 className="text-lg font-semibold text-error">Something went wrong</h2>
            <p className="mt-2 text-sm text-muted-foreground">{this.state.error?.message}</p>
            <Button
              size="sm"
              className="mt-4"
              onClick={() => this.setState({ hasError: false, error: null })}
            >
              Try again
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

/** Whole-window fallback: re-rendering the same tree would just crash again. */
export function RootErrorFallback({ error }: { error: Error }) {
  const [copied, setCopied] = useState(false);

  const copyDetails = () => {
    window.api.copyToClipboard(error.stack || `${error.name}: ${error.message}`);
    setCopied(true);
  };

  return (
    <div className="flex h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-error">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Komla hit an unexpected error. Reloading the window usually fixes it.
        </p>
        <p className="mt-3 font-mono text-xs break-words text-muted-foreground">{error.message}</p>
        <div className="mt-5 flex justify-center gap-2">
          <Button size="sm" onClick={() => window.location.reload()}>
            Reload window
          </Button>
          <Button size="sm" variant="outline" onClick={copyDetails}>
            {copied ? 'Copied' : 'Copy error details'}
          </Button>
        </div>
      </div>
    </div>
  );
}
