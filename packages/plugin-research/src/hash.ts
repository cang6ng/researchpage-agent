/**
 * Content hashing, so "the text did not change" is a check rather than a claim.
 *
 * Two things in this product are pinned by hash: a proposal's base (so an edit
 * cannot land on text that moved underneath it) and a report's content (so a
 * freeze records exactly which wording it holds). Both compare structured
 * values, so the serialization has to be canonical — object keys are sorted
 * before hashing, and undefined-valued keys are dropped, so a record that was
 * read back from JSON hashes the same as the record that was written.
 */

import { createHash } from "node:crypto";

/** JSON with sorted keys, so two equal values always produce one string. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** A stable content hash, with its algorithm named so it can be changed later. */
export function hashOf(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
