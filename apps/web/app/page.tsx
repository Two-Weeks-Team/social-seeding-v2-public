import { redirect } from "next/navigation";
import { getServerSession } from "@/lib/auth";

/**
 * Root — bounces straight into the campaigns list when authenticated,
 * otherwise into the sign-in stub. There's no separate home view in Phase 1;
 * the "Mission Control dashboard" lands in Phase 4 with the analyst.
 */
export default async function RootPage() {
  const session = await getServerSession();
  redirect(session ? "/campaigns" : "/sign-in");
}
