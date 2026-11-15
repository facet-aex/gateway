import { executeGet, type OperationConfig } from "../src/executor.js";

const config: OperationConfig = {
  baseUrl: "https://api.github.com/",
  pathTemplate: "/repos/{owner}/{repo}",
  method: "GET",
  authKind: "none",
  timeoutMs: 15_000,
  maxResponseBytes: 1_048_576,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: {
        type: "object",
        additionalProperties: false,
        required: ["owner", "repo"],
        properties: { owner: { type: "string" }, repo: { type: "string" } },
      },
    },
  },
};
const result = (await executeGet(config, {
  path: { owner: "octocat", repo: "Hello-World" },
})) as Record<string, unknown>;
if (result.full_name !== "octocat/Hello-World" || result.private !== false)
  throw new Error("Unexpected GitHub repository response");
process.stdout.write(
  JSON.stringify({
    id: result.id,
    full_name: result.full_name,
    private: result.private,
  }) + "\n",
);
