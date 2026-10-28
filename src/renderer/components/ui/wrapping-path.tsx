import { Fragment } from 'react';

/**
 * Wraps between segments so names like `llmschema-db-diff` stay whole; a name
 * wider than the line on its own breaks anywhere rather than overflowing.
 */
export function WrappingPath({ path }: { path: string }) {
  const segments = path.split(/(?<=[/\\])/);
  return (
    <span>
      {segments.map((segment, index) => (
        <Fragment key={segments.slice(0, index + 1).join('')}>
          {index > 0 && <wbr />}
          <span className="inline-block max-w-full break-all">{segment}</span>
        </Fragment>
      ))}
    </span>
  );
}
