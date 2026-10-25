import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const distEntry = join(repoRoot, "dist/index.js");

async function mcpStdioSmoke(
  command: string[],
  options?: { timeoutMs?: number }
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 20_000;
  const proc = Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: repoRoot,
  });

  const requests =
    [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "smoke-client", version: "1.0.0" },
        },
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }),
    ].join("\n") + "\n";

  proc.stdin.write(requests);
  proc.stdin.end();

  const stdoutText = await Promise.race([
    new Response(proc.stdout).text(),
    new Promise<string>((_, reject) =>
      setTimeout(() => reject(new Error("MCP smoke timed out")), timeoutMs)
    ),
  ]);

  const exit = await proc.exited;
  if (exit !== 0 && !stdoutText.trim()) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`Process exited ${exit}: ${stderr}`);
  }

  const lines = stdoutText
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id?: number; result?: unknown });

  const initReply = lines.find((m) => m.id === 1) as {
    result?: { serverInfo?: { name?: string } };
  };
  expect(initReply?.result?.serverInfo?.name).toBe("typst-mcp");

  const toolsReply = lines.find((m) => m.id === 2) as {
    result?: { tools?: unknown[] };
  };
  expect(toolsReply?.result?.tools?.length).toBeGreaterThanOrEqual(16);

  proc.kill();
}

describe("Install smoke (MCP stdio)", () => {
  test("node dist/index.js matches npm bin", async () => {
    if (!existsSync(distEntry)) {
      const build = Bun.spawn(["bun", "run", "build"], { cwd: repoRoot });
      expect(await build.exited).toBe(0);
      expect(existsSync(distEntry)).toBe(true);
    }
    await mcpStdioSmoke(["node", distEntry]);
  }, 30_000);

  test("npx -y typst-mcp (published package, pi config)", async () => {
    await mcpStdioSmoke(["npx", "-y", "typst-mcp"], { timeoutMs: 90_000 });
  }, 120_000);
});
