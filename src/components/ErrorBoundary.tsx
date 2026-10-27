import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AppError } from '../utils/errorHandling';

/**
 * Props for ErrorBoundary component.
 */
interface ErrorBoundaryProps {
  /** Child components to render */
  children: ReactNode;
  
  /** Optional custom fallback UI */
  fallback?: (error: Error, resetError: () => void) => ReactNode;
}

/**
 * State for ErrorBoundary component.
 */
interface ErrorBoundaryState {
  /** Caught error, if any */
  error: Error | null;
  
  /** Error metadata */
  errorInfo: ErrorInfo | null;
}

/**
 * Error boundary component that catches React rendering errors.
 * Prevents the entire app from crashing when a component throws an error.
 * 
 * Usage:
 * ```tsx
 * <ErrorBoundary>
 *   <App />
 * </ErrorBoundary>
 * ```
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      error: null,
      errorInfo: null,
    };
  }

  /**
   * Lifecycle method called when a child component throws an error.
   */
  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  /**
   * Lifecycle method called after an error has been caught.
   * Used for error logging and reporting.
   */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Log error to console in development
    console.error('ErrorBoundary caught an error:', error, errorInfo);
    
    this.setState({
      error,
      errorInfo,
    });
  }

  /**
   * Resets the error boundary state to allow recovery.
   */
  resetError = (): void => {
    this.setState({
      error: null,
      errorInfo: null,
    });
  };

  render(): ReactNode {
    const { error, errorInfo } = this.state;
    const { children, fallback } = this.props;

    // If there's an error, show fallback UI
    if (error) {
      // Use custom fallback if provided
      if (fallback) {
        return fallback(error, this.resetError);
      }

      // Default fallback UI
      const appError = error instanceof AppError 
        ? error 
        : new AppError(
            'An unexpected error occurred. Please refresh the page and try again.',
            'error',
            error
          );

      return (
        <div
          style={{
            padding: '40px 20px',
            maxWidth: '800px',
            margin: '0 auto',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          <div
            style={{
              padding: '24px',
              backgroundColor: '#fee2e2',
              border: '2px solid #ef4444',
              borderRadius: '8px',
              marginBottom: '20px',
            }}
          >
            <h1 style={{ margin: '0 0 12px 0', color: '#991b1b', fontSize: '24px' }}>
              Something went wrong
            </h1>
            <p style={{ margin: '0 0 16px 0', color: '#374151', fontSize: '16px' }}>
              {appError.userMessage}
            </p>
            <button
              onClick={this.resetError}
              style={{
                padding: '10px 20px',
                backgroundColor: '#ef4444',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                fontSize: '14px',
                fontWeight: '600',
                cursor: 'pointer',
              }}
            >
              Try Again
            </button>
          </div>

          {/* Show technical details in development */}
          {import.meta.env.DEV && errorInfo && (
            <details style={{ marginTop: '20px' }}>
              <summary
                style={{
                  cursor: 'pointer',
                  padding: '10px',
                  backgroundColor: '#f3f4f6',
                  borderRadius: '4px',
                  fontWeight: '600',
                  color: '#374151',
                }}
              >
                Technical Details (Development Only)
              </summary>
              <div
                style={{
                  marginTop: '10px',
                  padding: '16px',
                  backgroundColor: '#1f2937',
                  color: '#f3f4f6',
                  borderRadius: '4px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '12px',
                  overflow: 'auto',
                  maxHeight: '400px',
                }}
              >
                <div style={{ marginBottom: '16px' }}>
                  <strong style={{ color: '#ef4444' }}>Error:</strong>
                  <pre style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>
                    {error.toString()}
                  </pre>
                </div>
                <div>
                  <strong style={{ color: '#f59e0b' }}>Component Stack:</strong>
                  <pre style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>
                    {errorInfo.componentStack}
                  </pre>
                </div>
              </div>
            </details>
          )}
        </div>
      );
    }

    // No error, render children normally
    return children;
  }
}
