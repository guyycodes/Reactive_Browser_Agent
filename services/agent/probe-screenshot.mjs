import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const outDir = "/tmp/mcp-probe/out";
const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@playwright/mcp@0.0.70", "--headless", "--browser", "chromium", "--output-dir", outDir],
  env: { ...process.env, PLAYWRIGHT_MCP_OUTPUT_DIR: outDir },
});
const client = new Client({ name: "probe", version: "0.0.1" }, { capabilities: {} });
await client.connect(transport);

await client.callTool({ name: "browser_navigate", arguments: { url: "http://test-webapp:3000/login" } });
const res = await client.callTool({
  name: "browser_take_screenshot",
  arguments: { type: "png", filename: "probe.png" },
});
console.log("---RAW RESPONSE---");
console.log(JSON.stringify(res, (k, v) => typeof v === "string" && v.length > 120 ? `${v.slice(0,120)}...[truncated len=${v.length}]` : v, 2));
await client.close();
