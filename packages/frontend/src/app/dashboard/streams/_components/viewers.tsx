import React from 'react';
import { toast } from 'sonner';
import { BiUser } from 'react-icons/bi';
import { Tooltip } from '@aiostreams/ui/tooltip';
import type { StreamViewer } from '../queries';
import { Pill } from './shared';

function configName(v: StreamViewer): string {
  return v.alias ?? v.uuid.slice(0, 8);
}

/** One Jellyfin persona watching a stream; click copies the config UUID. */
function ViewerPill({ viewer }: { viewer: StreamViewer }) {
  const copy = () =>
    navigator.clipboard
      .writeText(viewer.uuid)
      .then(() => toast.success('Configuration UUID copied'))
      .catch(() => toast.error('Could not copy'));
  return (
    <Tooltip
      trigger={
        <button type="button" onClick={copy}>
          <Pill className="border-sky-500/40 bg-sky-500/10 text-sky-300 hover:border-sky-400">
            <BiUser />
            {viewer.persona}
            <span className="font-normal opacity-70">
              · {configName(viewer)}
            </span>
          </Pill>
        </button>
      }
    >
      <div className="space-y-0.5 text-xs">
        <div className="font-medium">
          {viewer.persona}
          {viewer.personaId ? ` (${viewer.personaId})` : ''}
        </div>
        {viewer.title && <div>{viewer.title}</div>}
        {(viewer.client || viewer.device) && (
          <div>
            {[viewer.client, viewer.device].filter(Boolean).join(' on ')}
          </div>
        )}
        <div className="font-mono">
          {viewer.alias ? `${viewer.alias} · ` : ''}
          {viewer.uuid}
        </div>
        <div className="opacity-70">Click to copy the configuration UUID</div>
      </div>
    </Tooltip>
  );
}

/** The Jellyfin personas behind a stream, when the server could tell. */
export function ViewerPills({ viewers }: { viewers?: StreamViewer[] }) {
  if (!viewers?.length) return null;
  return (
    <>
      {viewers.map((v) => (
        <ViewerPill
          key={`${v.uuid}|${v.personaId ?? ''}|${v.client ?? ''}|${v.device ?? ''}`}
          viewer={v}
        />
      ))}
    </>
  );
}
