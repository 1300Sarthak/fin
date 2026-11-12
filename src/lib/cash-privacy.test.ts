import { expect, test } from "bun:test";
import type { CompleteOptions, CompleteResult } from "@/lib/ai/types";
import { parseCashCommand } from "./cash";

test("a typed cash note leaves pseudonymised and comes back with the real name", async () => {
  const prior = process.env.FIN_PRIVATE_NAMES;
  process.env.FIN_PRIVATE_NAMES = "Priya Nair";
  try {
    let sent = "";
    const fake = async (o: CompleteOptions): Promise<CompleteResult> => {
      sent = JSON.stringify([o.system, o.messages]);
      const token = /⟦person:\d+⟧/.exec(sent)?.[0] ?? "nobody";
      return { provider: "anthropic", model: "fake", toolCalls: [], stopReason: "end", text: JSON.stringify({ op: "subtract", amount: 15, note: `lunch with ${token}`, date: "" }) };
    };
    const cmd = await parseCashCommand("spent $15 on lunch with Priya Nair, call 408-555-0199", fake);
    expect(sent).not.toContain("Priya");
    expect(sent).not.toContain("555-0199");
    expect(sent).toContain("$15");
    expect(cmd).toMatchObject({ op: "subtract", amountCents: 1500, note: "lunch with Priya Nair" });
  } finally {
    if (prior === undefined) delete process.env.FIN_PRIVATE_NAMES;
    else process.env.FIN_PRIVATE_NAMES = prior;
  }
});
