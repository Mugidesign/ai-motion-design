import { NextResponse, type NextRequest } from "next/server";
import { createSupabaseMiddlewareClient } from "@/lib/supabase/middleware";

const PUBLIC_PATH_PREFIXES = ["/sign-in", "/sign-up", "/p/"]; // /p/* = published portfolio sites, public by design

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Replaces Clerk's clerkMiddleware(). Refreshes the Supabase session on
 * every request (required so server components see a valid cookie-backed
 * session — see @supabase/ssr's documented pattern) and redirects
 * unauthenticated requests to /sign-in for anything not explicitly public.
 */
export async function middleware(request: NextRequest) {
  const response = NextResponse.next({ request: { headers: request.headers } });
  const supabase = createSupabaseMiddlewareClient(request, response);

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session && !isPublicPath(request.nextUrl.pathname)) {
    const redirectUrl = new URL("/sign-in", request.url);
    redirectUrl.searchParams.set("redirect_to", request.nextUrl.pathname);
    return NextResponse.redirect(redirectUrl);
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)"],
};
