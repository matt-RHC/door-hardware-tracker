"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function Navbar() {
  const [email, setEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const supabase = createClient();

  useEffect(() => {
    getUser();
  }, []);

  const getUser = async () => {
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setEmail(user?.email || null);
    } catch (err) {
      console.error("Error getting user:", err);
    } finally {
      setLoading(false);
    }
  };

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    router.push("/");
  };

  return (
    <nav className="bg-black/90 backdrop-blur-xl border-b border-white/[0.08]">
      <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div className="text-xl font-semibold" style={{ color: "#f5f5f7" }}>
          Door Hardware Tracker
        </div>

        <div className="flex items-center gap-4">
          {!loading && email && (
            <div className="flex items-center gap-4">
              <span className="text-sm" style={{ color: "#6e6e73" }}>
                {email}
              </span>
              <button
                onClick={handleSignOut}
                className="px-4 py-2 text-sm rounded transition-colors"
                style={{
                  color: "#a1a1a6",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.color = "#f5f5f7")
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.color = "#a1a1a6")
                }
              >
                Sign Out
              </button>
            </div>
          )}
        </div>
      </div>
    </nav>
  );
}
