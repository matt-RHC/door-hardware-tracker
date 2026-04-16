"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen flex items-center justify-center bg-background text-foreground">
        <div className="text-center p-8">
          <h2 className="text-xl font-bold mb-4">Something went wrong</h2>
          <p className="text-secondary mb-6">
            An unexpected error occurred. The error has been reported automatically.
          </p>
          <button
            onClick={reset}
            className="glow-btn--primary px-6 py-2"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
