import {
  createWsRpcProtocolLayer as createSharedWsRpcProtocolLayer,
  WsTransport as BaseWsTransport,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolSocketUrlProvider,
  type WsTransportOptions,
} from "@t3tools/client-runtime";

import { ClientTracingLive } from "../observability/clientTracing";
import {
  acknowledgeRpcRequest,
  clearAllTrackedRpcRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";
import {
  recordWsConnectionAttempt,
  recordWsConnectionClosed,
  recordWsConnectionErrored,
  recordWsConnectionOpened,
  type WsConnectionMetadata,
} from "./wsConnectionState";

function resolveConnectionMetadata(handlers?: WsProtocolLifecycleHandlers): WsConnectionMetadata {
  return {
    connectionLabel: handlers?.getConnectionLabel?.() ?? null,
    versionMismatchHint: handlers?.getVersionMismatchHint?.() ?? null,
  };
}

function createWsRpcProtocolLayer(
  url: WsRpcProtocolSocketUrlProvider,
  handlers?: WsProtocolLifecycleHandlers,
) {
  return createSharedWsRpcProtocolLayer(url, handlers, {
    telemetryLifecycle: {
      onAttempt: (socketUrl) =>
        recordWsConnectionAttempt(socketUrl, resolveConnectionMetadata(handlers)),
      onOpen: () => recordWsConnectionOpened(resolveConnectionMetadata(handlers)),
      onError: (message) => {
        clearAllTrackedRpcRequests();
        recordWsConnectionErrored(message, resolveConnectionMetadata(handlers));
      },
      onClose: (details, context) => {
        clearAllTrackedRpcRequests();
        if (context.intentional) {
          return;
        }
        recordWsConnectionClosed(details, resolveConnectionMetadata(handlers));
      },
      onHeartbeatTimeout: () => {
        clearAllTrackedRpcRequests();
        recordWsConnectionErrored(
          "WebSocket heartbeat timed out.",
          resolveConnectionMetadata(handlers),
        );
      },
    },
    requestTelemetry: {
      onRequestSent: trackRpcRequestSent,
      onRequestAcknowledged: acknowledgeRpcRequest,
      onClearTrackedRequests: clearAllTrackedRpcRequests,
    },
  });
}

const webWsTransportOptions = {
  tracingLayer: ClientTracingLive,
  createProtocolLayer: createWsRpcProtocolLayer,
  onBeforeReconnect: () => clearAllTrackedRpcRequests(),
} satisfies WsTransportOptions;

export class WsTransport extends BaseWsTransport {
  constructor(
    url: WsRpcProtocolSocketUrlProvider,
    lifecycleHandlers?: WsProtocolLifecycleHandlers,
  ) {
    super(url, lifecycleHandlers, webWsTransportOptions);
  }
}
