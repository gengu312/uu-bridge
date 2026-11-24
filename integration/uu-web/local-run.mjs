// 仅用于本机运行：在上游应用外层校验 Host、来源和独立会话令牌，并挂载本地 Agent 通道。
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentBroker } from "../../agent/broker.mjs";
import { createApp } from "./backend/dist/app.js";
import { installFileTee } from "./backend/dist/services/fileTee.js";

export function startLocalUuWebServer({
  host = process.env.HOST ?? "127.0.0.1",
  port = Number(process.env.PORT ?? 18789),
  accessPath = process.env.UUBRIDGE_ACCESS_FILE || fileURLToPath(new URL("../../output/uu-web-local-access.json", import.meta.url)),
  logPath = process.env.UURC_BACKEND_LOG_PATH || fileURLToPath(new URL("../../output/uu-web-backend.log", import.meta.url)),
  enableTee = true,
} = {}) {
  if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Local launcher requires HOST=127.0.0.1 and a valid local PORT.");
  }

  const token = randomBytes(32).toString("base64url");
  const cookieName = "uuwebLocalSession";
  if (enableTee) {
    mkdirSync(path.dirname(logPath), { recursive: true });
    installFileTee(logPath, 5 * 1024 * 1024);
  }
  const { app } = createApp({ host: "127.0.0.1", port: port || 18789, enableDiagnostics: false, enableWisp: false });

  let actualOrigin = `http://127.0.0.1:${port}`;
  const broker = createAgentBroker({
    getOrigin: () => actualOrigin,
  });

  function matchesToken(value = "") {
    const candidate = Buffer.from(value);
    const expected = Buffer.from(token);
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  }

  function reject(res) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    res.end("Local access denied. Open the login URL from output/uu-web-local-access.json.\n");
  }

  const server = createServer((req, res) => {
    const activePort = server.address()?.port ?? port;
    actualOrigin = `http://127.0.0.1:${activePort}`;
    const expectedHost = `127.0.0.1:${activePort}`;
    const url = new URL(req.url ?? "/", actualOrigin);

    // Local MCP / Agent control API uses its own Bearer token and strict loopback validation.
    if (url.pathname.startsWith("/__uubridge/mcp/")) {
      void broker.handleAgentRequest(req, res, url);
      return;
    }

    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== actualOrigin)) {
      reject(res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/login" && matchesToken(url.searchParams.get("localToken") ?? "")) {
      res.writeHead(303, {
        Location: "/login",
        "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      return;
    }
    // 原桥接入口位于另一 loopback 端口；只允许其已认证登录页导航，不放行跨源 API。
    const localLoginNavigation =
      req.method === "GET" &&
      url.pathname === "/login" &&
      req.headers["sec-fetch-site"] === "same-site" &&
      req.headers["sec-fetch-mode"] === "navigate";
    if (
      req.headers["sec-fetch-site"] &&
      !["same-origin", "none"].includes(req.headers["sec-fetch-site"]) &&
      !localLoginNavigation
    ) {
      reject(res);
      return;
    }
    const cookie = (req.headers.cookie ?? "")
      .split(";")
      .map((item) => item.trim())
      .find((item) => item.startsWith(`${cookieName}=`));
    if (!cookie || !matchesToken(cookie.slice(cookieName.length + 1))) {
      reject(res);
      return;
    }
    res.setHeader("Referrer-Policy", "no-referrer");

    if (url.pathname.startsWith("/__uubridge/agent/")) {
      void broker.handleBrowserRequest(req, res, url);
      return;
    }

    app(req, res);
  });

  server.requestTimeout = 0;
  server.headersTimeout = 15_000;
  server.on("close", () => broker.close());

  return new Promise((resolve, rejectStart) => {
    server.once("error", rejectStart);
    server.listen(port, "127.0.0.1", () => {
      const activePort = server.address().port;
      actualOrigin = `http://127.0.0.1:${activePort}`;
      const accessInfo = {
        pid: process.pid,
        origin: actualOrigin,
        loginUrl: `${actualOrigin}/login?localToken=${token}`,
        agentToken: broker.agentToken,
        logPath,
      };
      if (accessPath) {
        mkdirSync(path.dirname(accessPath), { recursive: true });
        writeFileSync(accessPath, JSON.stringify(accessInfo, null, 2) + "\n", { mode: 0o600 });
        chmodSync(accessPath, 0o600);
      }
      resolve({ server, broker, accessInfo, token });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.HOST !== "127.0.0.1" || process.env.PORT !== "18789") {
    throw new Error("Local launcher requires HOST=127.0.0.1 PORT=18789");
  }
  const { server, accessInfo } = await startLocalUuWebServer({ host: "127.0.0.1", port: 18789 });
  console.log(`UU web listening at ${accessInfo.origin}; private login URL & agent token: output/uu-web-local-access.json`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      server.close();
      server.closeAllConnections?.();
    });
  }
}
