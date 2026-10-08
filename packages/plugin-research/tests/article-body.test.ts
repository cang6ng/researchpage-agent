/**
 * What a generic HTML page has to show before its text may be called the body.
 *
 * The defect these tests close is a subscription publisher's landing page: HTTP
 * 200, no body at all, and hundreds of paragraphs of abstract, reference list,
 * author block and navigation. It used to be recorded as `full_text` — and
 * body-level scope is exactly what lets a matrix cell reach「已核对」 and a claim
 * `adequate`, so a reference entry could be quoted as evidence for a question
 * the page never answered. The rule under test is therefore: a page that is not
 * a known full-text document must *show* paper sections before anything in it
 * is called the body, and must degrade to an abstract-level read, or to an
 * honest failure, when it does not.
 *
 * The fixtures mirror the real pages these rules were written against — a
 * Nature landing page (abstract, access options, references, back matter,
 * footer), an ACL/AAAI abstract card, and a PLOS/Frontiers full text — while
 * every stub here is deterministic: a `fetch` is scripted and the reader itself
 * is the code under test.
 */

import { describe, expect, it } from "vitest";

import {
  isArticleBodyHeading,
  isNonArticleHeading,
  MIN_BODY_CHARS,
  normaliseHeading,
  recogniseArticleBody,
} from "../src/article.js";
import { deriveClaimAdequacy, type ClaimContext } from "../src/claims.js";
import type { CellRef, Evidence, ReportClaim, Source, SupportAssessment } from "../src/domain.js";
import { deriveCellCoverage } from "../src/domain.js";
import { draftEvidence } from "../src/evidence.js";
import { extractHtmlDocument } from "../src/html.js";
import { readSource } from "../src/read.js";

// ---------------------------------------------------------------- fixtures ---

const ABSTRACT_TEXT =
  "Deep learning allows computational models that are composed of multiple processing layers to learn representations of data with multiple levels of abstraction. " +
  "These methods have dramatically improved the state of the art in speech recognition, visual object recognition and object detection, and they are now used across many scientific domains.";

const PROSE = (sentence: string, times = 3): string => sentence.repeat(times);

function referenceEntry(index: number): string {
  return (
    `Author${index}, A. and Collaborator${index}, B. Representation learning in deep architectures, study ${index}. ` +
    `Journal of Machine Learning Research ${10 + (index % 8)}(${index}): 1${index}–${index + 40}, 201${index % 10}.`
  );
}

function referenceList(count: number): string {
  return Array.from({ length: count }, (_whole, index) => `<li>${referenceEntry(index + 1)}</li>`).join("");
}

interface LandingOptions {
  /** `section` renders an abstract block, `meta` only declares one, `none` neither. */
  readonly abstract?: "section" | "meta" | "none";
  readonly references?: number;
  readonly title?: string;
}

/** A subscription publisher's landing page: everything except the paper. */
function publisherLandingPage(options: LandingOptions = {}): string {
  const mode = options.abstract ?? "section";
  const title = options.title ?? "Deep learning";
  const meta = mode === "meta" ? `<meta name="dc.description" content="${ABSTRACT_TEXT}" />` : "";
  const block = mode === "section" ? `<h2>Abstract</h2><p>${ABSTRACT_TEXT}</p>` : "";
  return `<!doctype html><html><head><title>${title} | Nature</title>${meta}</head><body><article>
<h1>${title}</h1>
<p>Yann LeCun, Yoshua Bengio and Geoffrey Hinton</p>
${block}
<h2>Access options</h2><p>Subscribe to this journal and receive 51 print issues and online access, or rent or buy this article.</p>
<h3>Additional access options:</h3><p>Log in, or learn about institutional subscriptions and read our FAQs and contact support.</p>
<h2>References</h2><ol>${referenceList(options.references ?? 40)}</ol>
<h2>Acknowledgements</h2><p>We thank the many colleagues who discussed the ideas in this review with us over the years.</p>
<h2>Author information</h2><h3>Authors and Affiliations</h3><p>Facebook AI Research, New York, NY, USA. Yann LeCun and colleagues.</p>
<h3>Corresponding author</h3><p>Correspondence to Yann LeCun, who is the corresponding author for this review.</p>
<h2>Ethics declarations</h2><h3>Competing interests</h3><p>The authors declare no competing financial interests in this work.</p>
<h2>Additional information</h2><p>Reprints and permissions information is available at www.nature.com/reprints.</p>
<h2>Rights and permissions</h2><p>Springer Nature or its licensor holds exclusive rights to this article under a licensing agreement.</p>
<h2>About this article</h2><h3>Cite this article</h3><p>LeCun, Y., Bengio, Y. &amp; Hinton, G. Deep learning. Nature 521, 436–444 (2015).</p>
<h2>Comments</h2><p>By submitting a comment you agree to abide by our Terms and Community Guidelines, which we apply to all discussion.</p>
<h2>Explore content</h2><p>Research articles, Reviews and Analysis, News and Comment, and the current issue of the journal.</p>
<h2>Search</h2><p>Search articles by subject, keyword or author across the whole of nature.com and its archives.</p>
</article></body></html>`;
}

/** An open-access article page: the paper really is here. */
function openAccessArticle(): string {
  return `<!doctype html><html><head><title>An open access article</title></head><body>
<h1>An open access article</h1>
<h2>Abstract</h2><p>${ABSTRACT_TEXT}</p>
<h2>Introduction</h2>
<p>${PROSE("Retrieval-augmented generation couples a language model to an external corpus, and the index it builds decides which passages the model can ever see. ")}</p>
<p>${PROSE("Early systems retrieved flat passages, while later work added graph structure so that a question can draw on relations rather than only on similar text. ")}</p>
<p>${PROSE("This article asks how much of the reported gain comes from the structure and how much from the summarisation step that precedes retrieval. ")}</p>
<h2>Methods</h2>
<p>${PROSE("We build a knowledge graph over the corpus, cluster its entities, and pre-generate a summary for each cluster during indexing rather than at query time. ")}</p>
<p>${PROSE("Each question is mapped to the clusters whose summaries mention its entities, and the summaries are concatenated into the model's context as evidence. ")}</p>
<p>${PROSE("We compare the graph summaries against passage retrieval on the same corpus with the same generator and the same evaluation judge. ")}</p>
<h2>Results and discussion</h2>
<p>${PROSE("Graph summaries answer corpus-level questions more completely, while passage retrieval answers entity questions with less context and lower cost. ")}</p>
<p>${PROSE("The reported differences are largest on questions that require aggregating many documents, which is where the summary step contributes most of the gain. ")}</p>
<h2>Conclusion</h2>
<p>${PROSE("Structure and summarisation are separable contributions, and the index-time cost of summaries is only justified for questions that span the corpus. ")}</p>
<p>${PROSE("Future work should report both costs separately, because the two retrieval families are not interchangeable at the same budget. ")}</p>
<h2>References</h2><ol>${referenceList(8)}</ol>
</body></html>`;
}

function respond(body: string, contentType: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": contentType } });
}

const LANDING_URL = "https://www.nature.com/articles/nature14539";
const landingFetch = (html: string) => async (): Promise<Response> => respond(html, "text/html");

// ------------------------------------------------------------- A: landing ---

describe("A. a subscription landing page is never the body", () => {
  it("degrades a page of many paragraphs to its abstract", async () => {
    const html = publisherLandingPage({ references: 60 });
    // The page really is paragraph-heavy — the property that used to be enough
    // to call it a full text.
    expect(extractHtmlDocument(html).paragraphs.length).toBeGreaterThan(60);

    const outcome = await readSource({ url: LANDING_URL }, { fetchImpl: landingFetch(html) });

    expect(outcome.status).toBe("ok");
    expect(outcome.scope).toBe("abstract");
    expect(["full_text", "body_excerpt"]).not.toContain(outcome.scope);
    // What is saved is the paper's abstract, and nothing from the reference list.
    expect(outcome.text).toContain("multiple processing layers");
    expect(outcome.text).not.toContain("Journal of Machine Learning Research");
    expect(outcome.text).not.toContain("Cite this article");
    expect(outcome.paragraphs.length).toBe(1);
    // The note says the range out loud, and why the body was refused.
    expect(outcome.note).toContain("没有可识别的论文章节");
    expect(outcome.note).toContain("abstract 级读取");
    // The source's real address and its page title are kept.
    expect(outcome.readUrl).toBe(LANDING_URL);
    expect(outcome.title).toContain("Deep learning");
  });

  it("does not accept a page whose only body-like heading is its own title", async () => {
    // A paper called "An approach to …" puts a body word in the page title,
    // which every chrome paragraph then inherits as its heading path. One
    // heading is not a body: a body is made of sections. Here there is no
    // abstract either, so the honest answer is a reported failure.
    const chrome = Array.from(
      { length: 6 },
      (_whole, index) => `<p>${PROBE_CHROME[index % PROBE_CHROME.length]}</p>`,
    ).join("");
    const html = `<!doctype html><html><head><title>An approach to deep retrieval</title></head><body>
<h1>An approach to deep retrieval</h1>${chrome}
<h2>References</h2><ol>${referenceList(20)}</ol></body></html>`;

    const outcome = await readSource({ url: LANDING_URL }, { fetchImpl: landingFetch(html) });

    expect(outcome.status).toBe("failed");
    expect(outcome.scope).toBeNull();
    expect(outcome.failure).toContain("1 个正文章节标题");
  });

  it("falls back to the discovery abstract when the page states none", async () => {
    const html = publisherLandingPage({ abstract: "none", references: 20 });

    const outcome = await readSource(
      { url: LANDING_URL, metadata: { provider: "openalex", abstract: ABSTRACT_TEXT, workUrl: "https://api.openalex.org/works/W1" } },
      { fetchImpl: landingFetch(html) },
    );

    expect(outcome.scope).toBe("abstract");
    expect(outcome.text).toBe(ABSTRACT_TEXT);
    expect(outcome.note).toContain("OpenAlex");
    expect(outcome.note).toContain("不是正文");
  });
});

/** Long chrome paragraphs: prose that is not a paper. */
const PROBE_CHROME = [
  "Subscribe to this journal and receive 51 print issues and online access, or rent or buy this article for a single read.",
  "Log in to your account, or learn about institutional subscriptions and read our frequently asked questions and support pages.",
  "Published in issue 7553 of volume 521, with a full list of authors, affiliations and the corresponding author for this review.",
  "Reprints and permissions information is available from the publisher, together with the rights and licensing statement.",
  "Search across the journal by subject, keyword or author, and browse the current issue, the archive and the most read articles.",
  "The authors declare that they have no competing financial interests, and that all data needed to interpret the work is cited.",
];

// ----------------------------------------------------- B: abstract only -----

describe("B. a page that only states an abstract is read as an abstract", () => {
  it("takes the rendered abstract and stops before the bibliographic fields", async () => {
    // The ACL shape: the abstract card is followed by the page's own
    // bibliographic fields, which inherit the same heading path.
    const html = `<!doctype html><html><head><title>Query-Driven Multimodal GraphRAG</title></head><body>
<h1>Query-Driven Multimodal GraphRAG</h1>
<h5>Abstract</h5>
<p>${ABSTRACT_TEXT}</p>
<div class="card-body"><dl><dt>Anthology ID:</dt><dd>2025.findings-acl.1100</dd><dt>Volume:</dt><dd>Findings of the Association for Computational Linguistics</dd><dt>Year:</dt><dd>2025</dd></dl></div>
<h5>Export citation</h5><p>BiBTeX, EndNote and Markdown export options for this paper are listed here as plain text.</p>
</body></html>`;

    const outcome = await readSource({ url: "https://aclanthology.org/2025.findings-acl.1100/" }, { fetchImpl: landingFetch(html) });

    expect(outcome.status).toBe("ok");
    expect(outcome.scope).toBe("abstract");
    expect(outcome.text).toBe(ABSTRACT_TEXT);
    expect(outcome.text).not.toContain("Anthology ID");
    expect(outcome.text).not.toContain("BiBTeX");
  });

  it("accepts an abstract the page declares in a meta tag", async () => {
    const html = publisherLandingPage({ abstract: "meta", references: 5 });

    const outcome = await readSource({ url: LANDING_URL }, { fetchImpl: landingFetch(html) });

    expect(outcome.scope).toBe("abstract");
    expect(outcome.text).toContain("multiple processing layers");
    expect(outcome.note).toContain("citation/dc");
  });

  it("still reads a declared abstract when the page cannot be parsed into a body", async () => {
    const html = `<!doctype html><html><head><title>Closed article</title>
<meta name="citation_abstract" content="${ABSTRACT_TEXT}" /></head><body><p>Access denied.</p></body></html>`;

    const outcome = await readSource({ url: LANDING_URL }, { fetchImpl: landingFetch(html) });

    expect(outcome.scope).toBe("abstract");
    expect(outcome.text).toBe(ABSTRACT_TEXT);
  });
});

// ------------------------------------------------- C: arXiv is unchanged ----

describe("C. the arXiv HTML full text is not regressed", () => {
  it("keeps body scope for section names the generic rules would not accept", async () => {
    // A real LaTeXML paper can name its sections anything at all. The arXiv
    // HTML route is a known full-text document, so it does not depend on the
    // generic allow-list — this is the route the product's arXiv reads take.
    const html = `<!doctype html><html><head><title>Sample Paper</title></head><body>
<h1>Sample Paper</h1>
<h2>The Question</h2>
<p>${PROSE("Corpus-level summarisation answers questions that no single passage can answer on its own. ")}</p>
<p>${PROSE("Passage retrieval answers entity questions cheaply but cannot aggregate across documents. ")}</p>
<h2>Our Proposal</h2>
<p>${PROSE("We build the index once and reuse it, paying the summarisation cost before any question arrives. ")}</p>
<p>${PROSE("Questions are routed to the clusters whose summaries mention the entities named in the question. ")}</p>
<h2>What We Found</h2>
<p>${PROSE("The gains concentrate on questions that need many documents, which is the effect we set out to measure. ")}</p>
</body></html>`;

    const outcome = await readSource(
      { url: "https://arxiv.org/abs/2501.00309" },
      {
        fetchImpl: async (input) =>
          String(input).includes("/html/") ? respond(html, "text/html") : respond("missing", "text/html", 404),
      },
    );

    expect(outcome.status).toBe("ok");
    expect(outcome.scope).toBe("full_text");
    expect(outcome.readUrl).toContain("arxiv.org/html/");
    expect(outcome.text).toContain("Corpus-level summarisation");
  });
});

// --------------------------------------------- D: real open-access pages -----

describe("D. an open-access full text keeps its body, and the body is the body", () => {
  it("records the paper's sections and leaves out the abstract and references", async () => {
    const outcome = await readSource({ url: "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0061217" }, {
      fetchImpl: landingFetch(openAccessArticle()),
    });

    expect(outcome.status).toBe("ok");
    expect(outcome.scope).toBe("full_text");
    expect(outcome.text).toContain("Retrieval-augmented generation couples a language model");
    // The abstract is not body text, and neither is a reference entry: a body
    // read must not be quotable from either.
    expect(outcome.text).not.toContain("multiple processing layers");
    expect(outcome.text).not.toContain("Journal of Machine Learning Research");
    for (const paragraph of outcome.paragraphs) {
      expect(outcome.text.slice(paragraph.charStart, paragraph.charEnd)).toBe(paragraph.text);
      expect(paragraph.headingPath.join(" ")).not.toMatch(/Abstract|References/i);
    }
    expect(outcome.note).toContain("识别到论文正文");
  });

  it("refuses a preview that is too short to be a body", async () => {
    const html = `<!doctype html><html><head><title>Preview</title></head><body>
<h1>Preview</h1>
<h2>Abstract</h2><p>${ABSTRACT_TEXT}</p>
<h2>Introduction</h2><p>This introduction is visible to everyone, and it is short.</p>
<h2>Methods</h2><p>This methods preview is visible to everyone, and it is short too.</p>
<h2>References</h2><ol>${referenceList(5)}</ol>
</body></html>`;

    const outcome = await readSource({ url: LANDING_URL }, { fetchImpl: landingFetch(html) });

    expect(outcome.scope).toBe("abstract");
    expect(outcome.note).toContain("正文");
    expect(outcome.note).toContain("段落过少");
  });

  it("refuses a preview that is about as long as its own abstract", async () => {
    // Volume alone is not enough: a preview of the first sections renders about
    // as much prose as the abstract does, so the body has to be a multiple of
    // it. The preconditions below are asserted rather than assumed.
    const longAbstract = `${ABSTRACT_TEXT} ${PROSE("The review surveys representation learning across domains and lists the open problems it leaves unresolved. ", 10)}`;
    const previewParagraph = PROSE(
      "This preview paragraph is rendered to every visitor before the paywall, and it is long enough to clear the length floor on its own. ",
      3,
    );
    const previewChars = previewParagraph.length * 4;
    expect(previewChars).toBeGreaterThan(MIN_BODY_CHARS);
    expect(previewChars).toBeLessThan(longAbstract.length * 2);
    expect(longAbstract.length).toBeLessThan(2_000);

    const html = `<!doctype html><html><head><title>Preview</title></head><body>
<h1>Preview</h1>
<h2>Abstract</h2><p>${longAbstract}</p>
<h2>Introduction</h2><p>${previewParagraph}</p><p>${previewParagraph}</p>
<h2>Methods</h2><p>${previewParagraph}</p><p>${previewParagraph}</p>
<h2>References</h2><ol>${referenceList(5)}</ol>
</body></html>`;

    const outcome = await readSource({ url: LANDING_URL }, { fetchImpl: landingFetch(html) });

    expect(outcome.scope).toBe("abstract");
    expect(outcome.note).toContain("预览");
  });
});

// ------------------------------------------------ F: no invented evidence ----

describe("F. a page with nothing readable produces no text at all", () => {
  it("fails instead of recording the chrome as a read", async () => {
    const html = publisherLandingPage({ abstract: "none", references: 60 });

    const outcome = await readSource({ url: LANDING_URL }, { fetchImpl: landingFetch(html) });

    expect(outcome.status).toBe("failed");
    expect(outcome.scope).toBeNull();
    expect(outcome.text).toBe("");
    expect(outcome.paragraphs).toEqual([]);
    expect(outcome.note).toContain("没有可识别的论文章节");
    expect(outcome.failure).toBeTruthy();
  });

  it("fails rather than reading a metadata block as an abstract", async () => {
    // "Abstract" as a card title over a table of bibliographic fields is not an
    // abstract; a two-word fragment is not one either.
    const html = `<!doctype html><html><head><title>Records</title></head><body>
<h1>Records</h1>
<h2>Abstract</h2>
<dl><dt>Anthology ID:</dt><dd>2025.findings-acl.1100</dd><dt>Volume:</dt><dd>Findings</dd><dt>Year:</dt><dd>2025</dd></dl>
<h2>References</h2><ol>${referenceList(30)}</ol>
</body></html>`;

    const outcome = await readSource({ url: LANDING_URL }, { fetchImpl: landingFetch(html) });

    expect(outcome.status).toBe("failed");
    expect(outcome.text).toBe("");
  });
});

// --------------------------------------------------------- heading rules -----

describe("the section rules themselves", () => {
  it("counts paper sections in", () => {
    for (const heading of [
      "Introduction",
      "2 Methods",
      "3.1 Evaluation setup",
      "IV. Experiments",
      "Results and discussion",
      "Related work",
      "Materials and Methods",
      "Case study",
      "Discussion and conclusion",
      "Limitations and future work",
      "Data collection",
    ]) {
      expect(isArticleBodyHeading(heading), heading).toBe(true);
    }
  });

  it("keeps front matter, back matter and chrome out", () => {
    for (const heading of [
      "Abstract",
      "Summary",
      "References",
      "Bibliography",
      "Data availability",
      "Data availability statement",
      "Availability of data and materials",
      "Supplementary materials",
      "Author contributions",
      "Acknowledgements",
      "Ethics declarations",
      "Competing interests",
      "Rights and permissions",
      "About this article",
      "Cite this article",
      "Access options",
      "Peer review",
      "Similar content being viewed by others",
      "Search",
      "Fig. 1",
      "Table 2",
      "",
      "Deep learning",
    ]) {
      expect(isArticleBodyHeading(heading), heading).toBe(false);
    }
  });

  it("names what a page must never present as the body", () => {
    for (const heading of ["References", "Data availability", "Supplementary materials", "Author information", "About this article"]) {
      expect(isNonArticleHeading(heading), heading).toBe(true);
    }
    for (const heading of ["Introduction", "Methods", "Related work", "Deep learning"]) {
      expect(isNonArticleHeading(heading), heading).toBe(false);
    }
  });

  it("strips numbering and section words before matching", () => {
    expect(normaliseHeading("3.2 Results and Discussion:")).toBe("results and discussion");
    expect(normaliseHeading("Section 4 Conclusions")).toBe("conclusions");
  });
});

// ------------------------------------------- the body is a body, not a pile --

describe("body recognition refuses a pile of prose", () => {
  const longParagraph = `<p>${PROSE("A long paragraph of real prose about retrieval systems and what they cost to run. ", 4)}</p>`;

  it("needs at least two sections that own prose, several paragraphs and real length", () => {
    // One section with plenty of prose: a section is not a body.
    const oneSection = recogniseArticleBody(
      extractHtmlDocument(`<h1>Retrieval systems</h1><h2>Introduction</h2>${longParagraph.repeat(5)}`),
    );
    expect(oneSection.recognised).toBe(false);
    expect(oneSection.reason).toContain("1 个正文章节标题");

    // A page title with a body word in it ("An approach to …") does not add a
    // section either: it owns no prose, so a single real section is still one.
    const titleAndOneSection = recogniseArticleBody(
      extractHtmlDocument(`<h1>An approach to retrieval</h1><h2>Introduction</h2>${longParagraph.repeat(5)}`),
    );
    expect(titleAndOneSection.recognised).toBe(false);
    expect(titleAndOneSection.sections).toEqual(["introduction"]);

    // Two sections with too few paragraphs to be a body.
    const thin = recogniseArticleBody(
      extractHtmlDocument(`<h1>Paper</h1><h2>Introduction</h2><p>Short.</p><h2>Methods</h2><p>Also short.</p>`),
    );
    expect(thin.recognised).toBe(false);
    expect(thin.reason).toContain("段落过少");

    // Two sections with four paragraphs that are simply too short.
    const fourShort = `<p>${PROSE("A short sentence about retrieval. ", 5)}</p>`.repeat(4);
    const short = recogniseArticleBody(
      extractHtmlDocument(`<h1>Paper</h1><h2>Introduction</h2>${fourShort}<h2>Methods</h2>${fourShort}`),
    );
    expect(short.recognised).toBe(false);
    expect(short.reason).toContain("过短");
  });
});

// ------------------------------- E: abstract evidence stays abstract-level ---

const CELL: CellRef = { sectionId: "mechanism", subjectId: "sub_model", dimensionId: "dim_idea" };

function sourceFixture(): Source {
  return {
    id: "src_landing",
    taskId: "task_boundary",
    title: "Deep learning",
    authors: ["Yann LeCun"],
    org: "Nature",
    url: LANDING_URL,
    pdfUrl: null,
    doi: "10.1038/nature14539",
    publishedAt: "2015-05-27",
    venue: "Nature",
    role: "primary",
    abstract: "",
    discovery: { provider: "openalex", query: "deep learning", queriedAt: "2026-10-08T00:00:00.000Z", target: null },
    readStatus: "ok",
    readScope: "abstract",
    readAt: "2026-10-08T00:00:00.000Z",
    readUrl: LANDING_URL,
    retrievalNote: "",
    failure: null,
    snapshotId: "read_landing",
  };
}

describe("E. abstract-level evidence cannot be talked up into a body finding", () => {
  it("leaves the cell limited and the claim short of adequate, however many excerpts there are", async () => {
    // The material comes from the real read path, so the scope under test is the
    // one the reader actually reported.
    const outcome = await readSource({ url: LANDING_URL }, { fetchImpl: landingFetch(publisherLandingPage()) });
    expect(outcome.scope).toBe("abstract");
    const paragraph = outcome.paragraphs[0] as NonNullable<(typeof outcome.paragraphs)[number]>;

    const evidence: readonly Evidence[] = Array.from({ length: 4 }, (_whole, index) =>
      draftEvidence({
        taskId: "task_boundary",
        sourceId: "src_landing",
        readId: "read_landing",
        readScope: "abstract",
        draft: { paragraph, cells: [CELL], pickedBecause: `pick ${index}` },
        now: "2026-10-08T00:00:00.000Z",
      }),
    );
    const ids = evidence.map((item) => item.id);
    const assessments: readonly SupportAssessment[] = [
      {
        id: "asm_1",
        taskId: "task_boundary",
        target: CELL,
        evidenceIds: ids,
        relationship: "supports",
        directness: "direct",
        scope: "整段摘要",
        rationale: "摘要直接陈述了该结论",
        assessor: "agent",
        createdAt: "2026-10-08T00:00:00.000Z",
      },
    ];

    const coverage = deriveCellCoverage(CELL, evidence, assessments);
    expect(coverage.status).toBe("limited");
    expect(coverage.reason).toContain("摘要");

    const claim: ReportClaim = {
      id: "clm_1",
      text: "深层模型在多个任务上取得进展。",
      kind: "fact",
      claimType: "fact",
      evidenceIds: ids,
      subjects: ["sub_model"],
    };
    const context: ClaimContext = {
      evidence,
      sources: [sourceFixture()],
      assessments,
      subjectNames: new Map([["sub_model", "深层模型"]]),
    };
    expect(deriveClaimAdequacy(claim, context).state).toBe("limited");
    expect(deriveClaimAdequacy(claim, context).state).not.toBe("adequate");

    // The counterfactual is the whole point of the repair: had the landing page
    // still been recorded as full text, *the same material* would have been read
    // as a body finding. The suffciency rules are not what closes this — the
    // read boundary is.
    const asBody = evidence.map((item) => ({ ...item, readScope: "full_text" as const }));
    expect(deriveCellCoverage(CELL, asBody, assessments).status).toBe("reviewed");
    expect(deriveClaimAdequacy(claim, { ...context, evidence: asBody }).state).toBe("adequate");
  });
});
