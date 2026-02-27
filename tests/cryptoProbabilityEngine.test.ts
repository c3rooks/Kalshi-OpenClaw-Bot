import { describe, expect, it } from "vitest";
import { CryptoProbabilityEngine } from "../src/intel/cryptoProbabilityEngine";

describe("CryptoProbabilityEngine", () => {
  it("farther strike lowers terminal probability", () => {
    const e = new CryptoProbabilityEngine();
    for (let i = 0; i < 200; i += 1) e.updateTick("BTC", 100 + Math.sin(i / 4), Date.now() + i * 1000);
    const pNear = e.pTerminalAbove("BTC", 101, 300)!;
    const pFar = e.pTerminalAbove("BTC", 120, 300)!;
    expect(pNear).toBeGreaterThan(pFar);
  });

  it("higher vol increases touch probability", () => {
    const low = new CryptoProbabilityEngine();
    const high = new CryptoProbabilityEngine();
    for (let i = 0; i < 300; i += 1) {
      low.updateTick("BTC", 100 + Math.sin(i / 15) * 0.2, Date.now() + i * 1000);
      high.updateTick("BTC", 100 + Math.sin(i / 3) * 3, Date.now() + i * 1000);
    }
    const pLow = low.pTouchBarrier("BTC", 105, 600, "UP")!;
    const pHigh = high.pTouchBarrier("BTC", 105, 600, "UP")!;
    expect(pHigh).toBeGreaterThan(pLow);
  });

  it("shorter time lowers touch probability", () => {
    const e = new CryptoProbabilityEngine();
    for (let i = 0; i < 300; i += 1) e.updateTick("BTC", 100 + Math.sin(i / 3), Date.now() + i * 1000);
    const pShort = e.pTouchBarrier("BTC", 105, 60, "UP")!;
    const pLong = e.pTouchBarrier("BTC", 105, 3600, "UP")!;
    expect(pLong).toBeGreaterThan(pShort);
  });
});
