import { afterEach, describe, expect, it, vi } from "vitest";

import { readPrimaryEnvironmentTarget } from "./target";

describe("readPrimaryEnvironmentTarget", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("rewrites loopback configured URLs to the page hostname for LAN-style access", () => {
    vi.stubEnv("VITE_HTTP_URL", "http://localhost:13773");
    vi.stubEnv("VITE_WS_URL", "ws://localhost:13773");
    vi.stubGlobal("window", {
      location: new URL("http://100.64.0.2:5733/"),
      desktopBridge: undefined,
    });

    const target = readPrimaryEnvironmentTarget();
    expect(target).toEqual({
      source: "configured",
      target: {
        httpBaseUrl: "http://100.64.0.2:13773/",
        wsBaseUrl: "ws://100.64.0.2:13773/",
      },
    });
  });

  it("does not rewrite when the page is served from loopback", () => {
    vi.stubEnv("VITE_HTTP_URL", "http://localhost:13773");
    vi.stubEnv("VITE_WS_URL", "ws://localhost:13773");
    vi.stubGlobal("window", {
      location: new URL("http://127.0.0.1:5733/"),
      desktopBridge: undefined,
    });

    const target = readPrimaryEnvironmentTarget();
    expect(target).toEqual({
      source: "configured",
      target: {
        httpBaseUrl: "http://localhost:13773/",
        wsBaseUrl: "ws://localhost:13773/",
      },
    });
  });
});
