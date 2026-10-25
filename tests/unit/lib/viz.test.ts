import { HEAT_BANDS, heatColorVars, overflowTone } from "@/app/lib/viz";

describe("viz single-source", () => {
  it("热力色阶只有一份定义 (图例与图表同源, 不许各写一套)", () => {
    expect(HEAT_BANDS).toHaveLength(5);
    expect(new Set(HEAT_BANDS).size).toBe(5);
    expect(heatColorVars()).toEqual(["var(--seq-1)", "var(--seq-2)", "var(--seq-3)", "var(--seq-4)", "var(--seq-5)"]);
  });

  it("超标/不足必须不同色 (旧实现两个分支都是 warn)", () => {
    expect(overflowTone("over")).toBe("tone-crit");
    expect(overflowTone("under")).toBe("tone-warn");
    expect(overflowTone(undefined)).toBe("tone-warn");
  });
});
