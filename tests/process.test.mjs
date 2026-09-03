import assert from "node:assert/strict";
import test from "node:test";
import { execFileWithInput } from "../src/server/process.ts";

test("execFileWithInput writes the complete input and closes stdin", async () => {
  const input = "repository evidence\n".repeat(20_000);
  const script = `
    process.stdin.setEncoding("utf8");
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(input));
  `;

  const result = await execFileWithInput(process.execPath, ["-e", script], input, {
    encoding: "utf8",
    maxBuffer: 1_000_000,
    timeout: 5_000,
  });

  assert.equal(result.stdout, input);
});
