import type { AppError } from '../utils/errorHandling';

/**
 * Props for ErrorDisplay component.
 */
interface ErrorDisplayProps {
  /** Error or warning to display */
  error: AppError | null;
  
  /** Optional callback when error is dismissed */
  onDismiss?: () => void;
  
  /** Additional CSS class name */
  className?: string;
}

/**
 * Inline error/warning display component.
 * Shows user-friendly error messages with severity-based styling.
 * 
 * @example
 * ```tsx
 * <ErrorDisplay 
 *   error={validationError} 
 *   onDismiss={() => setError(null)}
 * />
 * ```
 */
export default function ErrorDisplay({ error, onDismiss, className = '' }: ErrorDisplayProps) {
  if (!error) return null;

  const isError = error.severity === 'error';
  const color = isError ? '#ef4444' : '#f59e0b';
  
  return (
    <div
      className={className}
      role={isError ? 'alert' : undefined}
      aria-live={isError ? undefined : 'polite'}
      style={{
        color,
        marginTop: '10px',
        fontSize: '14px',
      }}
    >
      {error.userMessage}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            cursor: 'pointer',
            fontSize: '14px',
            marginLeft: '8px',
            padding: 0,
          }}
          aria-label="Dismiss"
        >
          ×
        </button>
      )}
    </div>
  );
}

