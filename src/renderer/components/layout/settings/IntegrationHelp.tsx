import { Info } from '@phosphor-icons/react';

import { Callout } from '@/components/ui/callout';
import { InfoTip } from '@/components/ui/info-tip';
import { reportsOwnStatus } from '@/lib/agent-status-reports';

import type { AgentIntegrationFilter } from './AgentIntegrations';

// What turning on an agent's hooks, Komla skill or MCP server does, behind an info icon, for the
// setup wizard's Connect step and Settings → Integrations, and the copy each tier shares.

// What each tier of the Agent Integrations menu adds, under its name.
export const HOOKS_DESCRIPTION =
  'Komla knows when an agent is really done or needs you, and keeps every workspace named after what you’re working on.';
export const KOMLA_CLI_DESCRIPTION =
  'Every Komla terminal has the komla command, for starting agents, opening previews and more. The Komla skill teaches your agents to use it.';
export const MCP_DESCRIPTION =
  'Only for agents that work through MCP alone: new features go to the komla CLI and skill instead.';

/** Under the Komla skill row: agents without the skill can still find the commands. */
export function KomlaCliHelpNote() {
  return (
    <>
      Agents can also look up any command with <code className="font-mono">komla --help</code> or{' '}
      <code className="font-mono">komla &lt;command&gt; --help</code>.
    </>
  );
}

/** Codex runs Komla's hooks only once approved, below its Hooks row. */
export function CodexHookApproval() {
  return (
    <Callout
      tone="warning"
      size="sm"
      icon={<Info className="size-3.5" />}
      className="ml-6 gap-2 py-2 text-xs"
    >
      <span className="font-medium">
        Codex won&rsquo;t run the Komla hooks until you approve them.
      </span>{' '}
      After enabling, run <code className="font-mono">/hooks</code> inside Codex, then select and
      approve each Komla hook individually. Until you do,{' '}
      {reportsOwnStatus('codex') ? (
        'workspace titles won’t follow the chat.'
      ) : (
        <>
          notifications won&rsquo;t fire at all. Codex <code className="font-mono">/review</code>{' '}
          may also skip the normal completion hook, which can leave the activity spinner on until
          the next completion event.
        </>
      )}
    </Callout>
  );
}

export function HooksHelp({
  agent,
  integration,
}: {
  agent: string;
  integration: AgentIntegrationFilter | null | undefined;
}) {
  return (
    <InfoTip ariaLabel={`About ${agent} hooks`}>
      {reportsOwnStatus(integration) ? (
        <>
          <p>
            Every workspace stays named after what you’re working on in {agent}, and the name keeps
            up as the chat moves on, so you find the right one at a glance.
          </p>
          <p>
            Done shows only once {agent} has really finished, background work included, and you see
            when a turn fails.
          </p>
          <p>
            Recent {agent} versions tell Komla when they finish or need you even without hooks.
            Older ones need hooks for that too.
          </p>
        </>
      ) : (
        <>
          <p>
            Leave {agent} running and come back when it needs you: Komla marks the workspace in the
            sidebar and plays a sound when {agent} finishes, asks for permission or waits on you.
          </p>
          <p>
            Every workspace also stays named after what you’re working on in {agent}, so you find
            the right one at a glance.
          </p>
        </>
      )}
      <p>
        We highly recommend hooks for the best experience. Komla adds them to {agent}’s settings,
        and turning them off removes them again.
      </p>
    </InfoTip>
  );
}

export function KomlaSkillHelp() {
  return (
    <InfoTip ariaLabel="About the Komla skill">
      <p>
        Adds the Komla skill for Claude Code in <code className="font-mono">~/.claude/skills</code>,
        for Codex, OpenCode and other agents in <code className="font-mono">~/.agents/skills</code>,
        and for Antigravity CLI in <code className="font-mono">~/.gemini/config/skills</code> once
        it’s installed. Agents then know how to use the Komla CLI to:
      </p>
      <ul className="list-disc space-y-0.5 pl-4">
        <li>start another agent in a new workspace or tab</li>
        <li>open a page in Komla’s browser</li>
        <li>create custom status bar widgets</li>
        <li>set up automations and quick commands for your projects</li>
        <li>snooze their own workspace or move it to the Trash</li>
        <li>change Komla’s settings</li>
        <li>and more</li>
      </ul>
      <p>Komla keeps the skill up to date. Turning it off removes it again.</p>
      <p>
        In Komla’s terminals, agents can use the CLI without the skill too, when you mention it:{' '}
        <code className="font-mono">komla --help</code> lists every command, and{' '}
        <code className="font-mono">komla skill &lt;name&gt;</code> prints a guide.
      </p>
    </InfoTip>
  );
}

export function McpHelp({ agent }: { agent: string }) {
  return (
    <InfoTip ariaLabel={`About the ${agent} MCP server`}>
      <p>Adds Komla’s MCP server to {agent}, with tools to:</p>
      <ul className="list-disc space-y-0.5 pl-4">
        <li>start another agent in a new workspace or tab</li>
        <li>name its workspace in the sidebar</li>
        <li>open a page in Komla’s browser</li>
        <li>show a status item in the status bar</li>
      </ul>
      <p>
        Komla’s new features go to the <code className="font-mono">komla</code> command and the
        Komla skill instead, which do all of this too. The MCP server stays for agents that only
        work through MCP.
      </p>
    </InfoTip>
  );
}
