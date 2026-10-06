/**
 * RichMarkdown: the one way this product draws model-written prose.
 *
 * The assistant answers in Markdown, and so do the explanations attached to
 * something it did. Drawing that is a single component because it is a single
 * question — "how does text this product did not write get shown?" — and the
 * answer has to be the same in a chat answer, a proposal's reason and a run's
 * own account of itself.
 *
 * Two rules are not negotiable. Raw HTML is never rendered: the pipeline has no
 * `rehype-raw`, and a sanitize pass runs after the Markdown is parsed, so a
 * `<script>` in a model answer is text and never an element. And the styling is
 * this product's, not a README's: 13.5px at a 1.7 line height, hairline tables,
 * a rule rather than a box for quotations, and horizontal scrolling instead of
 * overflow for anything wide.
 *
 * The answer is also read the way a reader reads it. The assistant can see the
 * identifiers of the evidence and objects it is talking about, and it sometimes
 * writes them into its answer — `GraphRAG (sub_graphrag)`, a table cell holding
 * `ev_b28b34…`. Those are the assistant thinking about its own storage, so they
 * are taken out before anything is drawn.
 */

import { type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { withoutInternalIds } from "../document-logic.js";

/**
 * The sanitizer's own default schema, with one addition.
 *
 * `hast-util-sanitize`'s default is GitHub's: it already refuses `script`,
 * `iframe`, `style` and event attributes, and already restricts links to real
 * protocols, so `javascript:` in a model's link is dropped rather than
 * followed. What it does not allow is the class name a fenced code block
 * carries, which is how a language hint survives.
 */
export const RICH_MARKDOWN_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.["code"] ?? []), ["className", /^language-./]],
    pre: [["className", "rp-md__pre"]],
  },
};

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [[rehypeSanitize, RICH_MARKDOWN_SCHEMA]] as const;

/** A link leaves the product; an in-page anchor stays in it. */
function Link({ href, children }: { readonly href?: string; readonly children?: ReactNode }) {
  const internal = href === undefined || href.startsWith("#");
  if (href === undefined) return <span>{children}</span>;
  return (
    <a
      href={href}
      className="rp-md__a"
      {...(internal ? {} : { target: "_blank", rel: "noopener noreferrer" })}
    >
      {children}
    </a>
  );
}

/**
 * The emphasis inside a sentence, and nothing else.
 *
 * Reports and answers are written by a model that emphasises with `**` and
 * codes with backticks, sometimes inside a paragraph that already has its own
 * place in the document's structure. Printing the asterisks is the page failing
 * to read what it was given; letting a paragraph become a list is the page
 * overruling the report's structure. So only the inline vocabulary is allowed
 * through, and anything block-shaped is unwrapped into its own text.
 */
const INLINE_ELEMENTS = ["strong", "em", "code", "a", "del", "br"];

export function RichInline({ text, className }: { readonly text: string; readonly className?: string }) {
  if (text.trim().length === 0) return null;
  return (
    <span className={`rp-md-inline${className === undefined ? "" : ` ${className}`}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS as never}
        allowedElements={INLINE_ELEMENTS}
        unwrapDisallowed
        components={{ a: Link }}
      >
        {withoutInternalIds(text)}
      </ReactMarkdown>
    </span>
  );
}

/**
 * Markdown, drawn as this product draws it.
 *
 * `text` is the source. Nothing else is read from the model's answer: no HTML,
 * no scripts, no styles — only the structure Markdown itself carries.
 */
export function RichMarkdown({
  text,
  className,
  compact = false,
}: {
  readonly text: string;
  readonly className?: string;
  readonly compact?: boolean;
}) {
  if (text.trim().length === 0) return null;
  return (
    <div className={`rp-md${compact ? " rp-md--compact" : ""}${className === undefined ? "" : ` ${className}`}`}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS as never}
        components={{
          a: Link,
          // A wide table or a long code line scrolls inside itself rather than
          // pushing the panel it lives in.
          table: ({ children }) => (
            <div className="rp-md__scroll">
              <table>{children}</table>
            </div>
          ),
          pre: ({ children }) => (
            <div className="rp-md__scroll">
              <pre>{children}</pre>
            </div>
          ),
        }}
      >
        {withoutInternalIds(text)}
      </ReactMarkdown>
    </div>
  );
}
