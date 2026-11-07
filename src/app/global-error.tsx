"use client";

// Replaces the root layout when it fails, so globals.css and fonts may be missing: inline styles only.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", background: "#07090D", color: "#F3F6FA", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ maxWidth: 520, padding: 24 }}>
          <p style={{ fontSize: 11, letterSpacing: "0.14em", color: "#7D8899", textTransform: "uppercase" }}>Kestrel · system fault</p>
          <p style={{ marginTop: 12, fontSize: 22, lineHeight: 1.3 }}>
            <span style={{ color: "#91D982" }}>&gt;_</span> Kestrel hit an unexpected error.
          </p>
          <p style={{ marginTop: 8, fontSize: 13, color: "#9BA7B8", lineHeight: 1.6 }}>No data was shown in place of the live read. Try again in a moment.</p>
          <button onClick={reset} style={{ marginTop: 20, background: "#91D982", color: "#07090D", border: 0, borderRadius: 2, padding: "8px 16px", fontFamily: "inherit", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
            RETRY
          </button>
        </div>
      </body>
    </html>
  );
}
