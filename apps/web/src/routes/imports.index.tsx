import type { ChatImportStatus } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { ImportedChatsPage } from "../components/ImportedChatsPage";

export const Route = createFileRoute("/imports/")({
  validateSearch: (search: Record<string, unknown>) => ({
    status:
      search.status === "library" || search.status === "archived"
        ? search.status
        : ("inbox" as ChatImportStatus),
  }),
  component: ImportsIndexRoute,
});

function ImportsIndexRoute() {
  const { status } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <ImportedChatsPage
      status={status}
      onStatusChange={(nextStatus) =>
        void navigate({ search: { status: nextStatus }, replace: true })
      }
    />
  );
}
