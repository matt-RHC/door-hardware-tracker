"use client";

import { useState, useEffect } from "react";
import { useRouter, useParams } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { Opening } from "@/lib/types/database";

export default function QRCodesPrintPage() {
  const params = useParams();
  const projectId = params.projectId as string;
  const router = useRouter();

  const [openings, setOpenings] = useState<Opening[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchOpenings();
  }, [projectId]);

  const fetchOpenings = async () => {
    try {
      const response = await fetch(
        `/api/projects/${projectId}/openings`
      );
      if (!response.ok) throw new Error("Failed to fetch openings");
      const data = await response.json();
      setOpenings(data);
    } catch (err) {
      console.error("Error fetching openings:", err);
    } finally {
      setLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="min-h-screen bg-background p-8">
      <style>{`
        @media print {
          body { margin: 0; padding: 0; background: white; }
          .no-print { display: none !important; }
          .qr-code-item { page-break-inside: avoid; }
          .qr-code-item { background: white !important; border: 1px solid #e0e0e0 !important; }
          .qr-code-item p { color: #1a1a1a !important; }
        }
      `}</style>

      <div className="no-print flex justify-between items-center mb-8 max-w-7xl mx-auto">
        <h1 className="text-3xl font-bold text-primary">QR Codes</h1>
        <div className="flex gap-4">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="px-4 py-2 bg-tint hover:bg-tint-strong border border-border-dim text-secondary rounded-lg transition-colors"
          >
            Back
          </button>
          <button
            onClick={handlePrint}
            className="px-4 py-2 bg-accent hover:bg-accent/90 text-white rounded-lg transition-colors"
          >
            Print
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-secondary">Loading...</div>
      ) : (
        <div className="max-w-7xl mx-auto grid grid-cols-4 gap-6">
          {openings.map((opening) => {
            const qrUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/project/${projectId}/door/${opening.id}`;
            return (
              <div
                key={opening.id}
                className="qr-code-item bg-tint border border-border-dim p-4 rounded-md flex flex-col items-center"
              >
                <QRCodeSVG
                  value={qrUrl}
                  size={150}
                  level="H"
                  includeMargin={true}
                />
                <div className="text-center mt-4 text-xs text-secondary">
                  <p className="font-bold text-primary">Door {opening.door_number}</p>
                  {opening.location && (
                    <p className="text-tertiary">{opening.location}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
