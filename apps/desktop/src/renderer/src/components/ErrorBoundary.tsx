import { Component, type ReactNode } from 'react';

/**
 * Keeps one broken screen or panel from blanking the whole window: it says what went wrong and offers a retry.
 * `resetKey` clears the error when the person moves on (another screen, another task).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; label?: string },
  { error?: Error }
> {
  override state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(`[puff] ${this.props.label ?? 'a view'} failed:`, error);
  }

  override componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error)
      this.setState({ error: undefined });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-md">
          <p className="font-display text-base font-semibold text-ink">
            {this.props.label ?? 'This view'} hit an error
          </p>
          <p className="mt-2 font-mono text-xs break-words text-bad">{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: undefined })}
            className="mt-4 rounded border border-line-strong bg-surface-2 px-3 py-1.5 text-xs text-ink hover:bg-surface-3"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}
