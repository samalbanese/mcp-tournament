import { Fragment, type ReactNode } from "react";

/** Deliberately small Markdown subset. Model output never becomes raw HTML. */
function inline(text: string): ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g)
    .map((part, index) => {
      if (part.startsWith("**") && part.endsWith("**"))
        return <strong key={index}>{part.slice(2, -2)}</strong>;
      if (part.startsWith("`") && part.endsWith("`"))
        return <code key={index}>{part.slice(1, -1)}</code>;
      if (part.startsWith("*") && part.endsWith("*"))
        return <em key={index}>{part.slice(1, -1)}</em>;
      return part;
    });
}

export default function EvidenceText({ text }: { text: string }) {
  return (
    <>
      {text.split(/(```[\s\S]*?```)/g).map((section, sectionIndex) => {
        if (section.startsWith("```"))
          return (
            <pre key={sectionIndex}>
              <code>
                {section.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")}
              </code>
            </pre>
          );
        return (
          <Fragment key={sectionIndex}>
            {section
              .split(/\n\s*\n/)
              .filter(Boolean)
              .map((block, index) => {
                const lines = block.trim().split("\n");
                if (/^#{1,6}\s/.test(block.trim()) && lines.length === 1)
                  return (
                    <h3 key={index}>
                      {inline(block.trim().replace(/^#{1,6}\s+/, ""))}
                    </h3>
                  );
                if (lines.every((line) => /^\s*[-*]\s/.test(line)))
                  return (
                    <ul key={index}>
                      {lines.map((line, i) => (
                        <li key={i}>
                          {inline(line.replace(/^\s*[-*]\s+/, ""))}
                        </li>
                      ))}
                    </ul>
                  );
                if (lines.every((line) => /^\s*\d+\.\s/.test(line)))
                  return (
                    <ol key={index} start={parseInt(lines[0], 10)}>
                      {lines.map((line, i) => (
                        <li key={i}>
                          {inline(line.replace(/^\s*\d+\.\s+/, ""))}
                        </li>
                      ))}
                    </ol>
                  );
                return <p key={index}>{inline(block)}</p>;
              })}
          </Fragment>
        );
      })}
    </>
  );
}
