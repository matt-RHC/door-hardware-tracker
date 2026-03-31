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
    <nav className="bg-slate-900 border-b border-slate-800">
      <div className="max-w-7xl mx-auto px-4 py-4 flex justify-between items-center">
        <div className="text-xl font-bold text-white">
          Door Hardware Tracker
        </div>

        <div className="flex items-center gap-4">
          {!loading && email && (
            <div className="flex items-center gap-4">
              <span className="text-slate-400 text-sm">{email}</span>
              <button
                onClick={handleSignOut}
                className="px-4 py-2 text-sm bg-slate-800 hover:bg-slate-700 text-slate-200 rounded transition-colors"
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
