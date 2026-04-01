"use client";

import { useState, useRef, ChangeEvent, FormEvent } from "react";

interface PDFUploadModalProps {
  projectId: string;
  onClose: () => void;
  onSuccess: () => void;
}

export default function PDFUploadModal({
  projectId,
  onClose,
  onSuccess,
}: PDFUploadModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      if (selectedFile.type !== "application/pdf") {
        setError("Please select a PDF file");
        return;
      }
      setFile(selectedFile);
      setError(null);
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!file) {
      setError("Please select a file");
      return;
    }

    setLoading(true);
    setError(null);
    setProgress(0);
    setStatus("Starting upload...");

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("projectId", projectId);

      const response = await fetch("/api/parse-pdf", {
        method: "POST",
        body: formData,
      });

      if (!response.ok && !response.body) {
        throw new Error(`Upload failed (${response.status})`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("No response stream");
      }

      const decoder = new TextDecoder();
      let buffer = "";
      let lastEvent: { progress: number; status: string; error?: string; result?: Record<string, unknown> } | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            lastEvent = event;
            setProgress(event.progress);
            setStatus(event.status);
            if (event.error) {
              setError(event.error);
            }
          } catch {
            // skip malformed lines
          }
        }
      }

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer);
          lastEvent = event;
          setProgress(event.progress);
          setStatus(event.status);
          if (event.error) {
            setError(event.error);
          }
        } catch {
          // skip
        }
      }

      if (lastEvent?.error) {
        throw new Error(lastEvent.error);
      }

      if (lastEvent?.result?.success) {
        // Brief pause so user sees 100% before closing
        await new Promise((resolve) => setTimeout(resolve, 1500));
        onSuccess();
        onClose();
      } else {
        throw new Error("Upload completed but no success response received");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setProgress(0);
      setStatus("");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-slate-900 rounded-lg border border-slate-800 p-6 max-w-md w-full">
        <h2 className="text-xl font-bold text-white mb-4">Upload PDF</h2>

        {error && (
          <div className="mb-4 p-3 bg-red-900/20 border border-red-900 rounded text-red-200 text-sm">
            {error}
          </div>
        )}

        {loading && (
          <div className="mb-4">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-slate-300">{status}</span>
              <span className="text-slate-400">{progress}%</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-3 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500 ease-out"
                style={{
                  width: `${progress}%`,
                  backgroundColor: progress === 100 ? '#22c55e' : '#3b82f6',
                }}
              />
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-sm font-medium text-slate-200 mb-2">
              PDF File
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf"
              onChange={handleFileChange}
              disabled={loading}
              className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded text-white cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700 disabled:opacity-50"
            />
            {file && !loading && (
              <p className="mt-2 text-sm text-slate-400">{file.name}</p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-white rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !file}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white rounded transition-colors"
            >
              {loading ? "Processing..." : "Upload"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
