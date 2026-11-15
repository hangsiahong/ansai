import type { ComponentChildren, VNode } from "preact";
import { useState } from "preact/hooks";

/**
 * Small Markdown renderer for agent replies. It builds VNodes directly (never
 * innerHTML), so nothing in an agent's output can inject markup or script.
 * Covers what agents actually write: paragraphs, headings, lists, code
 * blocks, quotes, tables, inline code, bold/italic/strike and links.
 */

const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|(?<![\w*])\*(?!\s)([^*]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_]+?)_(?![\w_])|~~([\s\S]+?)~~|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"`])/g;

export function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  let last = 0;
  INLINE.lastIndex = 0;
  for (let m: RegExpExecArray | null; (m = INLINE.exec(text)); ) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<code>{m[2]}</code>);
    else if (m[3] || m[4]) out.push(<strong>{inline(m[3] ?? m[4]!)}</strong>);
    else if (m[5] || m[6]) out.push(<em>{inline(m[5] ?? m[6]!)}</em>);
    else if (m[7]) out.push(<s>{inline(m[7])}</s>);
    else if (m[8])
      out.push(
        <a href={m[9]} target="_blank" rel="noopener noreferrer">
          {inline(m[8])}
        </a>,
      );
    else if (m[10])
      out.push(
        <a href={m[10]} target="_blank" rel="noopener noreferrer">
          {m[10]}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(text: string): ComponentChildren[] {
  const parts = text.split("\n");
  return parts.flatMap((p, i) => (i ? [<br />, ...inline(p)] : inline(p)));
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="md-code">
      <div class="md-code-bar">
        <span>{lang || "code"}</span>
        <button
          onClick={() =>
            navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function blocks(src: string): VNode[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: VNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+-]*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i++;
      out.push(<CodeBlock code={body.join("\n")} lang={fence[2] ?? ""} />);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1]!.length;
      out.push(level <= 2 ? <h3 class="md-h">{inline(h[2]!)}</h3> : <h4 class="md-h">{inline(h[2]!)}</h4>);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(<hr />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      out.push(<blockquote>{blocks(body.join("\n"))}</blockquote>);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]!)) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) rows.push(cells(lines[i++]!));
      out.push(
        <div class="md-table">
          <table>
            <thead>
              <tr>{head.map((c) => <th>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr>{r.map((c) => <td>{inline(c)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const li = line.match(LIST);
    if (li) {
      const ordered = /\d/.test(li[2]!);
      const items: { indent: number; text: string }[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(LIST);
        if (m) {
          items.push({ indent: m[1]!.length, text: m[3]! });
          i++;
        } else if (lines[i]!.trim() && /^\s{2,}/.test(lines[i]!) && items.length) {
          items[items.length - 1]!.text += "\n" + lines[i++]!.trim();
        } else break;
      }
      const base = Math.min(...items.map((x) => x.indent));
      const listItems = items.map((x) => (
        <li class={x.indent > base ? "nested" : ""}>{withBreaks(x.text.replace(/^\[( |x)\]\s+/i, (_, c) => (c === " " ? "☐ " : "☑ ")))}</li>
      ));
      out.push(ordered ? <ol>{listItems}</ol> : <ul>{listItems}</ul>);
      continue;
    }
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^\s*(```|~~~)/.test(lines[i]!) &&
      !/^#{1,6}\s/.test(lines[i]!) &&
      !LIST.test(lines[i]!) &&
      !/^\s*>/.test(lines[i]!)
    )
      para.push(lines[i++]!);
    out.push(<p>{withBreaks(para.join("\n"))}</p>);
  }
  return out;
}

export function Markdown({ text }: { text: string }) {
  return <div class="md">{blocks(text)}</div>;
}
