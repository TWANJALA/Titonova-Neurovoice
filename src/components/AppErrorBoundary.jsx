import React from "react";

export default class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, errorMessage: "" };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: error?.message ? String(error.message) : "Unknown runtime error",
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error("AppErrorBoundary caught an error:", error, errorInfo);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <main
        style={{
          minHeight: "100vh",
          display: "grid",
          placeItems: "center",
          padding: 20,
        }}
      >
        <section
          style={{
            width: "min(640px, 100%)",
            border: "1px solid rgba(255, 160, 160, 0.5)",
            borderRadius: 14,
            padding: 18,
            background: "rgba(32, 7, 17, 0.8)",
            color: "#ffe7ec",
          }}
        >
          <h1 style={{ marginTop: 0, marginBottom: 8, fontSize: 22 }}>App failed to render</h1>
          <p style={{ marginTop: 0, marginBottom: 10, color: "#ffc8d2" }}>
            A runtime error prevented this page from loading.
          </p>
          <p style={{ marginTop: 0, marginBottom: 14, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
            {this.state.errorMessage}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              borderRadius: 10,
              border: "1px solid rgba(255, 184, 184, 0.72)",
              background: "rgba(92, 22, 36, 0.9)",
              color: "#ffe9ee",
              padding: "8px 12px",
              cursor: "pointer",
            }}
          >
            Reload app
          </button>
        </section>
      </main>
    );
  }
}

