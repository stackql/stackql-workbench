import { looksLikeSql, splitFences } from '../../lib/chat';
import { IconButton } from '../../ui/IconButton';
import { OpenInEditor } from '../../ui/icons';
import { Markdown } from './Markdown';

interface AssistantTextProps {
  text: string;
  onOpenInEditor: (sql: string) => void;
}

/**
 * Markdown text, with fenced code shown as code and SQL offered to the
 * editor. Used for a model's reply and for a query library document.
 */
export function AssistantText({ text, onOpenInEditor }: AssistantTextProps) {
  return (
    <div className="flex flex-col gap-1.5">
      {splitFences(text).map((segment, index) =>
        segment.kind === 'text' ? (
          <Markdown key={index} text={segment.text} />
        ) : (
          <div key={index} className="relative rounded-lg border border-line bg-surface">
            <pre className="selectable m-0 max-h-60 overflow-auto py-2 pr-8 pl-3 font-mono text-[12px] break-words whitespace-pre-wrap">
              {segment.code}
            </pre>
            {looksLikeSql(segment) && (
              <div className="absolute top-0.5 right-0.5">
                <IconButton
                  label="Open in editor"
                  onClick={() => {
                    onOpenInEditor(segment.code);
                  }}
                >
                  <OpenInEditor />
                </IconButton>
              </div>
            )}
          </div>
        ),
      )}
    </div>
  );
}
