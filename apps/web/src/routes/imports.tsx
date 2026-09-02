import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { SidebarInset } from "../components/ui/sidebar";

export const Route = createFileRoute("/imports")({
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ImportsLayoutRoute,
});

function ImportsLayoutRoute() {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <Outlet />
    </SidebarInset>
  );
}
