// Without a boundary, one unexpected shape in one tab unmounts the whole app
// and the user gets a blank page with nothing to act on. This keeps the shell
// (filters, tabs, Admin) alive so they can switch range or agent and carry on,
// and shows what to report.

import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Remounts the boundary when this changes — switching tab/range clears a stuck error. */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[dashboard] render error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card">
        <div className="empty">
          <h4>This view hit an unexpected error</h4>
          <p>
            The rest of the dashboard still works — switch tab, agent, or time range to carry on. If it keeps happening, please open an
            issue with the message below.
          </p>
          <pre
            style={{
              textAlign: "left",
              whiteSpace: "pre-wrap",
              fontSize: 12,
              color: "var(--text-secondary)",
              background: "var(--page)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              padding: "10px 12px",
              marginTop: 10,
              overflowX: "auto",
            }}
          >
            {this.state.error.message}
          </pre>
        </div>
      </div>
    );
  }
}
