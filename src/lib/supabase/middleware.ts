import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { Database } from "@/lib/types/database";

/**
 * Session + tenancy middleware.
 *
 * For any protected route:
 *   1. Require a Supabase session.
 *   2. Require a resolved company_id. JWT `app_metadata.company_id` is the
 *      fast path (zero DB hits); if it's missing, a single
 *      company_members SELECT falls through. If neither produces one, we
 *      redirect to /auth/no-company.
 *
 * `/auth/no-company` itself is NOT protected — the user is logged in but
 * intentionally lands there.
 */
export async function updateSession(request: NextRequest) {
  const supabaseResponse = NextResponse.next({ request });

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseKey) {
    return supabaseResponse;
  }

  const supabase = createServerClient<Database>(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const protectedRoutes = ["/dashboard", "/project", "/admin"];
  const isProtectedRoute = protectedRoutes.some((r) => pathname.startsWith(r));

  if (!user && isProtectedRoute) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Tenancy gate for protected routes. /admin is exempt because the admin
  // surface legitimately views cross-company data.
  if (user && isProtectedRoute && !pathname.startsWith("/admin")) {
    const jwtCompanyId =
      ((user.app_metadata as Record<string, unknown> | null)?.company_id as
        | string
        | undefined) ?? null;

    if (!jwtCompanyId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: membership } = await (supabase as any)
        .from("company_members")
        .select("company_id")
        .eq("user_id", user.id)
        .limit(1)
        .maybeSingle();

      if (!membership?.company_id) {
        const redirectUrl = new URL("/auth/no-company", request.url);
        const domain = user.email?.split("@")[1];
        if (domain) redirectUrl.searchParams.set("d", domain);
        return NextResponse.redirect(redirectUrl);
      }
    }
  }

  // If already signed in and hitting login/signup, bounce to dashboard.
  if (user && (pathname === "/" || pathname === "/signup")) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return supabaseResponse;
}
