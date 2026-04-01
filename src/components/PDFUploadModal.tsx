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

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("projectId", projectId);

      const response = await fetch("/api/parse-pdf", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => null);
        throw new Error(errData?.error || `Upload failed (${response.status})`);
      }

      const result = await response.json();
      onSuccess();
      onClose();
      if (result.unmatchedSets) {
        console.warn('Some hardware sets could not be matched:', result.unmatchedSets);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
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
              className="w-full px-4 py-2 bg-slate-800 border border-slate-700 rounded text-white cursor-pointer file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-600 file:text-white hover:file:bg-blue-700"
            />
            {file && (
              <p className="mt-2 text-sm text-slate-400">{file.name}</p>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || !file}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-700 text-white rounded transition-colors"
            >
              {loading ? "Analyzing submittal... (may take 1-2 min)" : "Upload"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
