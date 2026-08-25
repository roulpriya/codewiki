import { query } from "@anthropic-ai/claude-agent-sdk";

const prompt = process.argv.slice(2).join(" ").trim();

if (!prompt) {
  console.error('Usage: bun run claude -- "Your question about this repository"');
  process.exit(1);
}

const maxTurns = Number.parseInt(process.env.CLAUDE_AGENT_MAX_TURNS ?? "5", 10);

if (!Number.isSafeInteger(maxTurns) || maxTurns < 1) {
  throw new Error("CLAUDE_AGENT_MAX_TURNS must be a positive integer.");
}

for await (const message of query({
  prompt,
  options: {
    cwd: process.cwd(),
    executable: "bun",
    maxTurns,
    tools: ["Read", "Glob", "Grep"],
  },
})) {
  if (message.type !== "result") continue;

  if (message.subtype === "success") {
    if (message.is_error) {
      console.error(message.result);
      process.exitCode = 1;
    } else {
      console.log(message.result);
    }
    continue;
  }

  console.error(message.errors.join("\n") || `Claude Agent SDK stopped: ${message.subtype}`);
  process.exitCode = 1;
}
