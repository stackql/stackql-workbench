import { SAFETY_MODES, modeDescription, type ChatItem } from '../../lib/chat';
import { Popover } from '../../ui/Popover';

type SessionItem = Extract<ChatItem, { kind: 'session' }>;

interface SessionChipsProps {
  item: SessionItem;
  /** The backend and model in use, for a session the host opened itself. */
  backend: { name: string; model: string; delegated: boolean };
}

/**
 * What a session was started with, as chips: who runs the model, which
 * model, the safety mode and the tools. The rest is one click away.
 */
export function SessionChips({ item, backend }: SessionChipsProps) {
  const mode = SAFETY_MODES.find((m) => m.mode === item.mode);
  const modeLabel = mode?.label ?? item.mode;
  const delegated = item.agent !== undefined;
  const who = delegated ? [item.agent, item.agentVersion].filter(Boolean).join(' ') : backend.name;
  const model = delegated ? (item.model ?? '') : backend.model;
  const tools = `${item.tools} engine tools only`;
  const chips = [who, model, modeLabel, tools].filter((chip) => chip !== '');

  return (
    <Popover
      label="Session details"
      triggerClassName="flex flex-wrap items-center gap-1.5 rounded text-left"
      trigger={chips.map((chip) => (
        <span
          key={chip}
          className="rounded-full border border-line bg-surface-alt px-2 py-0.5 text-[11px] text-ink-muted"
        >
          {chip}
        </span>
      ))}
    >
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <Row name={delegated ? 'Agent' : 'Backend'} value={who} />
        {delegated && <Row name="Driven over" value={item.agentProtocol ?? ''} />}
        <Row name="Model" value={model || 'The backend default'} />
        <Row name="Safety mode" value={`${modeLabel}. ${modeDescription(item.mode, delegated)}`} />
        <Row
          name="Tools"
          value={`${item.tools} tools from the engine and no others. The model has no shell and no file access.`}
        />
        {!delegated && item.protocolVersion !== '' && (
          <Row name="Engine protocol" value={`MCP ${item.protocolVersion}`} />
        )}
      </dl>
    </Popover>
  );
}

function Row({ name, value }: { name: string; value: string }) {
  return (
    <>
      <dt className="text-ink-muted">{name}</dt>
      <dd className="selectable m-0 min-w-0 break-words">{value}</dd>
    </>
  );
}
