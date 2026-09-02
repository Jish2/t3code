import { createChatImportEnvironmentAtoms } from "@t3tools/client-runtime/state/chat-imports";

import { connectionAtomRuntime } from "../connection/runtime";

export const chatImportEnvironment = createChatImportEnvironmentAtoms(connectionAtomRuntime);
