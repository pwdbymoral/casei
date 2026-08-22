import { describe, expect, it } from "vitest";

import { canManageWorkspace } from "../src/access.js";

describe("canManageWorkspace", () => {
  it("permite que a pessoa proprietária administre o próprio espaço", () => {
    expect(canManageWorkspace({ role: "owner" })).toBe(true);
  });

  it("impede que um membro comum administre o espaço", () => {
    expect(canManageWorkspace({ role: "member" })).toBe(false);
  });
});
