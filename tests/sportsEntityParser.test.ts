import { describe, expect, it } from "vitest";
import { detectMatchupTeams, parseSportsMarket } from "../src/intelligence/parsing/sportsEntityParser";

describe("sports entity parser", () => {
  it("parses multi-leg yes/no market strings", () => {
    const legs = parseSportsMarket(
      "yes Donovan Mitchell: 20+,yes Evan Mobley: 7+,no Over 231.5 points scored,yes Cleveland"
    );
    expect(legs.length).toBe(4);
    expect(legs[0].type).toBe("PLAYER_PROP");
    expect(legs[0].player).toContain("Donovan");
    expect(legs[2].type).toBe("TOTAL_OVER");
    expect(legs[2].polarity).toBe("NO");
    expect(legs[3].type).toBe("TEAM_WIN");
  });

  it("parses team margin and BTTS semantics", () => {
    const legs = parseSportsMarket("yes Newcastle wins by over 2.5 goals,yes Both Teams To Score");
    expect(legs[0].type).toBe("TEAM_MARGIN");
    expect(legs[0].threshold).toBeCloseTo(2.5);
    expect(legs[1].type).toBe("BTTS");
  });

  it("detects matchup teams from common formats", () => {
    const vs = detectMatchupTeams("Lakers vs Celtics");
    expect(vs?.homeOrLeft).toContain("Lakers");
    expect(vs?.awayOrRight).toContain("Celtics");

    const at = detectMatchupTeams("Knicks @ Heat");
    expect(at?.homeOrLeft).toContain("Heat");
    expect(at?.awayOrRight).toContain("Knicks");
  });
});

