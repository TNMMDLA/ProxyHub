import { Component, type ErrorInfo, type PropsWithChildren } from 'react';
import { QueryErrorState } from './ui';

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ProxyHub render failure', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <QueryErrorState
          error={this.state.error}
          fullPage
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}
