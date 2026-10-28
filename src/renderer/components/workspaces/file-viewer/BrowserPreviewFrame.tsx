import { isPdfFile } from '../../../../shared/image-utils';

/** Shows an HTML page or PDF from a komla-preview URL, a page's scripts unless `scripts` is false. */
export function BrowserPreviewFrame({
  filePath,
  url,
  scripts = true,
}: {
  filePath: string;
  url: string;
  scripts?: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 bg-white">
      {isPdfFile(filePath) ? (
        <embed
          key={url}
          title={`${filePath} browser preview`}
          className="size-full border-0 bg-white"
          src={url}
          type="application/pdf"
        />
      ) : (
        <iframe
          key={url}
          title={`${filePath} browser preview`}
          className="size-full border-0 bg-white"
          referrerPolicy="no-referrer"
          // No allow-same-origin: the iframe document gets a unique opaque origin,
          // so scripts inside the preview can't reach Komla. They can still fetch
          // the files under the page's komla-preview://<token>/ root, which the
          // scheme's CORS allows; the main process only serves a folder there
          // inside the workspace, a worktree or a temp folder.
          sandbox={scripts ? 'allow-forms allow-scripts' : ''}
          src={url}
        />
      )}
    </div>
  );
}
