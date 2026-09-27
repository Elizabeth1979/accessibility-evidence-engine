import { readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import type { Browser, TestInfo } from "@playwright/test";

import {
  compileScenarioPlan,
  executeScenario,
  loadScenario,
  type ExecuteScenarioOptions
} from "@aee/cli";

type RequestHandler = Parameters<typeof createServer>[0];

export async function startHtmlServer(
  handler: RequestHandler
): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

const contentTypes: Record<string, string> = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml"
};

/** Serves the files in one directory, so a scenario can reach them over http. */
export function serveDirectory(root: string): RequestHandler {
  const base = path.resolve(root);
  return (request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://localhost");
    const filePath = path.join(base, decodeURIComponent(pathname));
    if (!filePath.startsWith(`${base}${path.sep}`)) {
      response.writeHead(403).end();
      return;
    }
    readFile(filePath).then(
      (body) => {
        const type = contentTypes[path.extname(filePath)] ?? "application/octet-stream";
        response.writeHead(200, { "content-type": type }).end(body);
      },
      () => response.writeHead(404).end()
    );
  };
}

/**
 * Writes a scenario, approves the exact plan it compiles to and runs it. The YAML must end with
 * its `approval:` block, so the plan digest can be appended to it.
 */
export async function runApprovedScenario(
  browser: Browser,
  scenarioYaml: string,
  testInfo: TestInfo,
  options: Pick<ExecuteScenarioOptions, "aiProvider"> = {}
): Promise<Awaited<ReturnType<typeof executeScenario>>> {
  const scenarioPath = testInfo.outputPath("scenario.yml");
  await writeFile(scenarioPath, scenarioYaml, "utf8");
  const plan = compileScenarioPlan(await loadScenario(scenarioPath));
  await writeFile(
    scenarioPath,
    `${scenarioYaml}  approvedPlanDigest: ${plan.planDigest}\n`,
    "utf8"
  );
  return executeScenario(scenarioPath, {
    browser,
    outputDir: testInfo.outputPath("scenario-output"),
    ...options
  });
}
