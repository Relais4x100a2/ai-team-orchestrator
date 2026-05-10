import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertSafeRelativeProjectPath } from "./paths-and-env.js";

describe("assertSafeRelativeProjectPath", () => {
  it("rejette un chemin avec segment .. (même si path.normalize le replierait)", () => {
    assert.throws(() => assertSafeRelativeProjectPath("a/../b", "x"), /\.\./);
  });
});
