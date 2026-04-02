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
    <div className="min-h-screen bg-black p-8">
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
        <h1 className="text-3xl font-bold text-[#f5f5f7]">QR Codes</h1>
        <div className="flex gap-4">
          <button
            onClick={() => router.push(`/project/${projectId}`)}
            className="px-4 py-2 bg-white/[0.04] hover:bg-white/[0.1] border border-white/[0.08] text-[#a1a1a6] rounded-lg transition-colors"
          >
            Back
          </button>
          <button
            onClick={handlePrint}
            className="px-4 py-2 bg-[#0a84ff] hover:bg-[#0a84ff]/90 text-[#f5f5f7] rounded-lg transition-colors"
          >
            Print
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12 text-[#a1a1a6]">Loading...</div>
      ) : (
        <div className="max-w-7xl mx-auto grid grid-cols-4 gap-6">
          {openings.map((opening) => {
            const qrUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/project/${projectId}/door/${opening.id}`;
            return (
              <div
                key={opening.id}
                className="qr-code-item bg-white/[0.04] border border-white/[0.08] p-4 rounded-xl flex flex-col items-center"
              >
                <QRCodeSVG
                  value={qrUrl}
                  size={150}
                  level="H"
                  includeMargin={true}
                />
                <div className="text-center mt-4 text-xs text-[#a1a1a6]">
                  <p className="font-bold text-[#f5f5f7]">Door {opening.door_number}</p>
                  {opening.location && (
                    <p className="text-[#6e6e73]">{opening.location}</p>
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
