/**
 * The document's own arithmetic.
 *
 * Three questions the report view asks over and over, answered in one place so
 * that a screen, a preview and a proposal panel cannot answer them differently:
 * which citation numbers a block carries, whether a block is ResearchPage's own
 * synthesis rather than a source's statement, and which claims a proposal would
 * add or replace.
 *
 * None of these decide anything about the research. The numbers come from the
 * report's citation map, the synthesis mark from the claim contract, and the
 * add-or-replace split from the base report's own claim ids.
 */



/** The citation numbers a block carries, in the order the report minted them. */
export function citationNumbersFor(
  claimIds: readonly string[],
  numbersByClaim: Readonly<Record<string, readonly number[]>>,
): readonly number[] {
  const numbers: number[] = [];
  for (const claimId of claimIds) {
    for (const number of numbersByClaim[claimId] ?? []) {
      if (!numbers.includes(number)) numbers.push(number);
    }
  }
  return numbers;
}

/** Which claim a citation number belongs to, for a click on that number. */
export function firstClaimByNumber(
  claimIds: readonly string[],
  numbersByClaim: Readonly<Record<string, readonly number[]>>,
): ReadonlyMap<number, string> {
  const byNumber = new Map<number, string>();
  for (const claimId of claimIds) {
    for (const number of numbersByClaim[claimId] ?? []) {
      if (!byNumber.has(number)) byNumber.set(number, claimId);
    }
  }
  return byNumber;
}

/**
 * Whether a block states ResearchPage's own judgement rather than a source's.
 *
 * A synthesis is marked in the claim contract, not inferred from wording: the
 * document has to be able to say which sentences are ours, and a block is
 * marked as ours when every claim it carries is one.
 */
/** The two marks that decide whether a claim is ours: the flag and the contract type. */
export interface SynthesisMark {
  readonly synthesis?: boolean;
  readonly claimType?: string;
}

export function blockIsSynthesis(
  claimIds: readonly string[],
  claims: ReadonlyMap<string, SynthesisMark>,
): boolean {
  if (claimIds.length === 0) return false;
  return claimIds.every((claimId) => {
    const claim = claims.get(claimId);
    return claim !== undefined && (claim.synthesis === true || claim.claimType === "synthesis");
  });
}

/** One claim a proposal touches, and whether it replaces an existing one. */
export interface ClaimChange<T> {
  readonly claim: T;
  readonly replaced: boolean;
}

/**
 * What a proposal does to the claims: a claim whose id already exists in the
 * base is a replacement, one that does not is an addition.
 */
export function claimChanges<T extends { readonly id: string }>(
  proposed: readonly T[],
  baseClaimIds: Iterable<string>,
): readonly ClaimChange<T>[] {
  const base = new Set(baseClaimIds);
  return proposed.map((claim) => ({ claim, replaced: base.has(claim.id) }));
}
