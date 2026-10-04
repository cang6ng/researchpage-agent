/**
 * The settings draft's authority, as a rule rather than as a page.
 *
 * A revision is a number inside one host's authority. Two hosts can be at the
 * same number, and a draft that outlived its host must not be written to
 * whoever is connected now: this is the question the panel asks, isolated so it
 * can be answered without a browser.
 */

import { describe, expect, it } from "vitest";

import { settingsAuthorityChanged } from "../src/browser/presentation.js";

describe("a settings draft's authority", () => {
  it("stays with the host instance it was read from", () => {
    expect(settingsAuthorityChanged("host-a", "host-a")).toBe(false);
  });

  it("is not satisfied by another host with the same numeric revision", () => {
    // The numbers being equal is exactly the trap: revision 5 on host A is not
    // revision 5 on host B.
    expect(settingsAuthorityChanged("host-a", "host-b"), "a draft's host is part of its authority").toBe(true);
  });

  it("is unknown before any host has described itself, and unknown is not authority", () => {
    expect(settingsAuthorityChanged(null, "host-a")).toBe(true);
    expect(settingsAuthorityChanged("host-a", null)).toBe(true);
    expect(settingsAuthorityChanged(null, null)).toBe(true);
  });
});
