import type { ReactNode } from 'react';
import { Book, Gear, History, NewChat, Sidebar, Spinner, Tree } from '../../ui/icons';
import { Wordmark } from '../../ui/Wordmark';

/** The main views. One is shown at a time. */
export type View = 'chat' | 'explorer' | 'library' | 'activity';

interface SideNavProps {
  view: View;
  collapsed: boolean;
  /** The current conversation's name. Null before the first message. */
  chatTitle: string | null;
  /** A turn is running. */
  chatBusy: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  onView: (view: View) => void;
  onSettings: () => void;
}

/** The side menu: where the operator moves between chat, the explorer and activity. */
export function SideNav({
  view,
  collapsed,
  chatTitle,
  chatBusy,
  onToggle,
  onNewChat,
  onView,
  onSettings,
}: SideNavProps) {
  return (
    <nav
      aria-label="Main"
      className={`m-2 mr-0 flex shrink-0 flex-col rounded-xl border border-line bg-surface ${
        collapsed ? 'w-[46px]' : 'w-[216px]'
      }`}
    >
      <div className="flex flex-col gap-0.5 p-1.5">
        <div className="flex h-8 items-center gap-2">
          <Item
            icon={<Sidebar />}
            label={collapsed ? 'Show menu' : 'Hide menu'}
            collapsed
            onClick={onToggle}
          />
          {!collapsed && <Wordmark className="h-[13px] w-auto shrink-0 text-accent" />}
        </div>
        <Item
          icon={<NewChat />}
          label="New Chat"
          collapsed={collapsed}
          // Before the first message, the new chat is the one on screen.
          active={view === 'chat' && chatTitle === null}
          onClick={onNewChat}
        />
        <Item
          icon={<Tree />}
          label="Explorer"
          title="Providers, the query editor and results"
          collapsed={collapsed}
          active={view === 'explorer'}
          onClick={() => {
            onView('explorer');
          }}
        />
        <Item
          icon={<Book />}
          label="Library"
          title="Statements from the query library, ready to open in the editor"
          collapsed={collapsed}
          active={view === 'library'}
          onClick={() => {
            onView('library');
          }}
        />
        <Item
          icon={<History />}
          label="Activity"
          title="What you and the assistant have run"
          collapsed={collapsed}
          active={view === 'activity'}
          onClick={() => {
            onView('activity');
          }}
        />
      </div>

      {!collapsed && chatTitle !== null && (
        <div className="flex min-h-0 flex-col gap-0.5 px-1.5">
          <div className="px-2 pt-2 pb-1 text-[11px] tracking-wide text-ink-muted uppercase">
            Chats
          </div>
          <button
            type="button"
            title={chatTitle}
            aria-current={view === 'chat' ? 'page' : undefined}
            className={`flex h-8 items-center gap-2 rounded-lg px-2 text-left hover:bg-surface-sunken ${
              view === 'chat' ? 'bg-surface-sunken font-medium' : ''
            }`}
            onClick={() => {
              onView('chat');
            }}
          >
            <span className="min-w-0 flex-1 truncate">{chatTitle}</span>
            {chatBusy && <Spinner className="shrink-0 text-ink-muted" />}
          </button>
        </div>
      )}

      <span className="flex-1" />
      <div className="border-t border-line p-1.5">
        <Item icon={<Gear />} label="Settings" collapsed={collapsed} onClick={onSettings} />
      </div>
    </nav>
  );
}

interface ItemProps {
  icon: ReactNode;
  label: string;
  title?: string;
  /** Show the icon only. */
  collapsed: boolean;
  active?: boolean;
  onClick: () => void;
}

function Item({ icon, label, title, collapsed, active, onClick }: ItemProps) {
  return (
    <button
      type="button"
      title={title ?? label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={`flex h-8 items-center gap-2.5 rounded-lg text-left hover:bg-surface-sunken ${
        collapsed ? 'w-8 justify-center' : 'px-2'
      } ${active ? 'bg-surface-sunken font-medium' : ''}`}
      onClick={onClick}
    >
      <span
        className={`flex h-4 w-4 shrink-0 items-center justify-center ${
          active ? 'text-accent' : 'text-ink-muted'
        }`}
      >
        {icon}
      </span>
      {!collapsed && <span className="min-w-0 truncate">{label}</span>}
    </button>
  );
}
