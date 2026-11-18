import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { redo, undo } from '@codemirror/commands';
import { keywordCompletionSource, SQLDialect } from '@codemirror/lang-sql';
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language';
import { Compartment, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { basicSetup } from 'codemirror';
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import {
  EMPTY_CATALOG,
  currentStatement,
  suggest,
  type Catalog,
  type Suggestion,
} from '../../lib/completion';
import { ident } from '../../lib/generateSql';

/** Keywords of the StackQL dialect, on top of plain SQL. */
const stackql = SQLDialect.define({
  keywords:
    'select from where and or not in like between is null as join left right inner outer cross on using ' +
    'group by order having limit offset union all distinct insert into values update set delete ' +
    'exec show describe desc registry pull list providers services resources methods method extended ' +
    'with case when then else end asc exists returning true false create table view materialized ' +
    'drop replace if refresh purge session auth',
  builtin:
    'json_extract json_each json_array_length count sum avg min max coalesce ifnull nullif cast ' +
    'substr length lower upper trim round abs datetime date strftime split_part regexp_replace',
  types: 'int integer bigint text varchar boolean bool numeric real double float timestamp json',
  identifierQuotes: '"',
});

const COMPLETION_TYPE: Record<Suggestion['kind'], string> = {
  provider: 'namespace',
  service: 'namespace',
  resource: 'class',
  field: 'property',
};

/**
 * Names from what the explorer has loaded. Keywords come from the SQL
 * language itself. Nothing is fetched here.
 */
function namesSource(catalog: () => Catalog) {
  return (context: CompletionContext): CompletionResult | null => {
    const { before, statement } = currentStatement(context.state.doc.toString(), context.pos);
    const found = suggest(catalog(), before, statement, context.explicit);
    if (found === null) {
      return null;
    }
    return {
      from: context.pos - found.replace,
      options: found.options.map((option) => ({
        label: option.label,
        type: COMPLETION_TYPE[option.kind],
        detail: option.detail,
        apply: ident(option.label),
        boost: 10,
      })),
      validFor: /^[\w-]*$/,
    };
  };
}

const keywords = keywordCompletionSource(stackql, true);

/** Keywords, except after a dot, where only a name can follow. */
function keywordsSource(context: CompletionContext) {
  return context.matchBefore(/\.[\w-]*/) ? null : keywords(context);
}

/** The SQL language with both sources of completions. */
function language(catalog: () => Catalog) {
  return new LanguageSupport(stackql.language, [
    stackql.language.data.of({ autocomplete: namesSource(catalog) }),
    stackql.language.data.of({ autocomplete: keywordsSource }),
  ]);
}

/** Holds the text an empty editor shows, so it can change after the editor exists. */
const sampleSlot = new Compartment();

const theme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '13px',
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-ink)',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'var(--font-mono)',
    lineHeight: '1.55',
  },
  '.cm-content': { caretColor: 'var(--color-ink)', padding: '6px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-ink)' },
  '.cm-placeholder': { color: 'var(--color-ink-muted)', fontStyle: 'italic' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--color-brand)',
    color: 'var(--color-on-brand)',
  },
  '.cm-completionDetail': { color: 'inherit', opacity: '0.7' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface-alt)',
    color: 'var(--color-ink-muted)',
    border: 'none',
    borderRight: '1px solid var(--color-line)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-accent) 7%, transparent)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
  },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
    { backgroundColor: 'color-mix(in srgb, var(--color-accent) 30%, transparent)' },
  '.cm-matchingBracket': {
    backgroundColor: 'color-mix(in srgb, var(--color-accent) 22%, transparent)',
    outline: 'none',
  },
  '.cm-panels': {
    backgroundColor: 'var(--color-surface-alt)',
    color: 'var(--color-ink)',
    borderColor: 'var(--color-line)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-surface-alt)',
    color: 'var(--color-ink)',
    border: '1px solid var(--color-line)',
  },
});

const highlighting = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--syntax-keyword)', fontWeight: '600' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  {
    tag: [tags.lineComment, tags.blockComment],
    color: 'var(--syntax-comment)',
    fontStyle: 'italic',
  },
  { tag: tags.typeName, color: 'var(--syntax-type)' },
  { tag: tags.standard(tags.name), color: 'var(--syntax-func)' },
  { tag: [tags.operator, tags.punctuation], color: 'var(--color-ink-muted)' },
]);

export interface EditorHandle {
  /** The selected text, or the whole buffer when nothing is selected. */
  runText: () => string;
  /** Inserts text at the cursor, replacing any selection, and focuses the editor. */
  insert: (text: string) => void;
  /** Replaces the whole buffer and focuses the editor. */
  replaceAll: (text: string) => void;
  focus: () => void;
  /** Whether the cursor is in the editor. */
  hasFocus: () => boolean;
  /** Undoes the last edit. The editor keeps its own history. */
  undo: () => void;
  redo: () => void;
}

interface EditorProps {
  initialText: string;
  /** Called on Ctrl+Enter, or Cmd+Enter on macOS. */
  onRun: (sql: string) => void;
  onChange?: (text: string) => void;
  /** What the explorer has loaded, for completing names. */
  catalog?: () => Catalog;
  /** Shown while the editor is empty. */
  sample?: string;
  ref?: Ref<EditorHandle>;
}

function textToRun(view: EditorView): string {
  const { from, to } = view.state.selection.main;
  return from === to ? view.state.doc.toString() : view.state.sliceDoc(from, to);
}

/** One CodeMirror buffer with SQL highlighting. */
export function Editor({ initialText, onRun, onChange, catalog, sample, ref }: EditorProps) {
  const container = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // The editor is created once. Later values of these props reach it through refs.
  const [startText] = useState(initialText);
  const onRunRef = useRef(onRun);
  const onChangeRef = useRef(onChange);
  const catalogRef = useRef(catalog);

  useEffect(() => {
    onRunRef.current = onRun;
    onChangeRef.current = onChange;
    catalogRef.current = catalog;
  }, [onRun, onChange, catalog]);

  useEffect(() => {
    const parent = container.current;
    if (!parent) {
      return;
    }
    const created = new EditorView({
      parent,
      doc: startText,
      extensions: [
        // The default keymap binds this key to "insert blank line". Running
        // the statement has to win, so it goes in at the highest precedence.
        Prec.highest(
          keymap.of([
            {
              key: 'Mod-Enter',
              run: (target) => {
                onRunRef.current(textToRun(target));
                return true;
              },
            },
          ]),
        ),
        basicSetup,
        language(() => catalogRef.current?.() ?? EMPTY_CATALOG),
        sampleSlot.of([]),
        syntaxHighlighting(highlighting),
        theme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current?.(update.state.doc.toString());
          }
        }),
      ],
    });
    view.current = created;
    return () => {
      created.destroy();
      view.current = null;
    };
  }, [startText]);

  useEffect(() => {
    view.current?.dispatch({
      effects: sampleSlot.reconfigure(sample ? placeholder(sample) : []),
    });
  }, [sample]);

  useImperativeHandle(
    ref,
    () => ({
      runText: () => (view.current ? textToRun(view.current) : ''),
      insert: (text) => {
        const target = view.current;
        if (!target) {
          return;
        }
        target.dispatch(target.state.replaceSelection(text));
        target.focus();
      },
      replaceAll: (text) => {
        const target = view.current;
        if (!target) {
          return;
        }
        target.dispatch({
          changes: { from: 0, to: target.state.doc.length, insert: text },
          selection: { anchor: text.length },
        });
        target.focus();
      },
      focus: () => view.current?.focus(),
      hasFocus: () => view.current?.hasFocus ?? false,
      undo: () => {
        if (view.current) {
          undo(view.current);
        }
      },
      redo: () => {
        if (view.current) {
          redo(view.current);
        }
      },
    }),
    [],
  );

  return <div ref={container} className="selectable h-full min-h-0 overflow-hidden" />;
}
