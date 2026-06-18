import { describe, expect, test } from "bun:test";
import { fenceInfo, isMermaidFence } from "../entrypoints/review/mermaid";

describe("fenceInfo", () => {
  test("extracts the info string after the fence, lowercased", () => {
    expect(fenceInfo("```mermaid")).toBe("mermaid");
    expect(fenceInfo("```Mermaid")).toBe("mermaid");
    expect(fenceInfo("~~~mermaid")).toBe("mermaid");
    expect(fenceInfo("```js")).toBe("js");
    expect(fenceInfo("```")).toBe("");
    expect(fenceInfo("   ```mermaid  ")).toBe("mermaid");
  });
});

describe("isMermaidFence", () => {
  test("true only for a mermaid fence", () => {
    expect(isMermaidFence("```mermaid")).toBe(true);
    expect(isMermaidFence("~~~mermaid")).toBe(true);
    expect(isMermaidFence("```mermaidish")).toBe(false);
    expect(isMermaidFence("```ts")).toBe(false);
    expect(isMermaidFence("plain text")).toBe(false);
  });
});
