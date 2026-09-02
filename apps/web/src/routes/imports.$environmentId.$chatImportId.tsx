import { createFileRoute } from "@tanstack/react-router";

import { ImportedChatDetail } from "../components/ImportedChatDetail";

export const Route = createFileRoute("/imports/$environmentId/$chatImportId")({
  component: ImportedChatRoute,
});

function ImportedChatRoute() {
  const { environmentId, chatImportId } = Route.useParams();
  return <ImportedChatDetail environmentId={environmentId} chatImportId={chatImportId} />;
}
