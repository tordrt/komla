import { exec } from 'child_process';
import { join } from 'path';

import { ipcMain } from 'electron';

import { AGENTS_WITH_AUTO_INTEGRATIONS } from '../../../shared/constants/agents';
import { IPC } from '../../../shared/constants/ipc-channels';
import { buildSkillFetchInstruction } from '../../../shared/constants/skill-fetch-instruction';
import { getNotifyHelper, isKomlaCliBlocked } from '../../lib/komla-cli';
import { antigravitySettingsService } from '../../services/antigravity-settings.service';
import { claudeSettingsService } from '../../services/claude-settings.service';
import { codexSettingsService } from '../../services/codex-settings.service';
import { configService } from '../../services/config.service';
import { httpServerService } from '../../services/http-server.service';
import { komlaSkillService } from '../../services/komla-skill.service';
import { opencodeSettingsService } from '../../services/opencode-settings.service';
import { getKomlaBasePath } from '../../services/paths';
import { remoteKomlaDataPort, sshWorkspaceService } from '../../services/ssh-workspace.service';
import { komlaSkillArgsSchema } from '../validation/config-ipc.schemas';
import { handleValidated } from '../validation/ipc-validators';

import type { KomlaSkillStatus } from '../../../shared/types/komla-skill';
import type { McpStatus } from '../../../shared/types/mcp-status';
import type { NotificationIntegrationUpdate } from '../../../shared/types/notification-integration';

export function registerAgentSettingsHandlers(): void {
  // Claude notification handlers
  ipcMain.handle(IPC.NOTIFICATIONS_ENABLE, async () => {
    claudeSettingsService.enableNotificationHook(
      await claudeSettingsService.getClaudeVersion({ fresh: true })
    );
    configService.update({ notificationsEnabled: true });
  });

  ipcMain.handle(IPC.NOTIFICATIONS_DISABLE, async () => {
    claudeSettingsService.disableNotificationHook();
    configService.update({ notificationsEnabled: false });
  });

  ipcMain.handle(
    IPC.NOTIFICATIONS_GET_HOOK_DETAILS,
    async (): Promise<{
      command: string;
      configJson: string;
      settingsPath: string;
      port: number;
      isConfigured: boolean;
      update?: NotificationIntegrationUpdate;
    }> => {
      // Asking Claude for its version starts a login shell, so only an installed integration,
      // whose update depends on it, asks. Enabling asks afresh.
      const claudeVersion = claudeSettingsService.hasNotificationHooks()
        ? await claudeSettingsService.getClaudeVersion()
        : undefined;
      return {
        command: claudeSettingsService.getHookCommand(),
        configJson: claudeSettingsService.getNotificationConfigJson(claudeVersion),
        settingsPath: claudeSettingsService.getSettingsPath(),
        port: httpServerService.getPort(),
        isConfigured: claudeSettingsService.isNotificationHookEnabled(),
        update: claudeSettingsService.getNotificationUpdate(claudeVersion),
      };
    }
  );

  // Codex notification handlers
  ipcMain.handle(IPC.CODEX_NOTIFICATIONS_ENABLE, async () => {
    codexSettingsService.enableNotificationHook();
    configService.update({ notificationsEnabled: true });
  });

  ipcMain.handle(IPC.CODEX_NOTIFICATIONS_DISABLE, async () => {
    codexSettingsService.disableNotificationHook();
  });

  ipcMain.handle(
    IPC.CODEX_NOTIFICATIONS_GET_HOOK_DETAILS,
    async (): Promise<{
      command: string;
      configJson: string;
      settingsPath: string;
      port: number;
      isConfigured: boolean;
      update?: NotificationIntegrationUpdate;
      hasConflict: boolean;
      canAutoConfigure: boolean;
      conflictMessage: string | null;
      isKomlaManaged?: boolean;
    }> => {
      const status = codexSettingsService.getNotificationStatus();
      return {
        command: codexSettingsService.getNotifyCommand(),
        configJson: codexSettingsService.getNotificationConfigJson(),
        settingsPath: codexSettingsService.getHooksPath(),
        port: httpServerService.getPort(),
        isConfigured: status.isConfigured,
        update: codexSettingsService.getNotificationUpdate(),
        hasConflict: status.hasConflict,
        canAutoConfigure: status.canAutoConfigure,
        conflictMessage: status.conflictMessage,
        isKomlaManaged: status.isKomlaManaged,
      };
    }
  );

  ipcMain.handle(
    IPC.CODEX_NOTIFICATIONS_ENABLE_FORCE,
    async (): Promise<{
      success: boolean;
      backupPath?: string;
      error?: string;
    }> => {
      const result = codexSettingsService.enableNotificationHookForce();
      if (result.success) {
        configService.update({ notificationsEnabled: true });
      }
      return result;
    }
  );

  // Antigravity CLI notification handlers
  ipcMain.handle(IPC.ANTIGRAVITY_NOTIFICATIONS_ENABLE, async () => {
    antigravitySettingsService.enableNotificationHook();
    configService.update({ notificationsEnabled: true });
  });

  ipcMain.handle(IPC.ANTIGRAVITY_NOTIFICATIONS_DISABLE, async () => {
    antigravitySettingsService.disableNotificationHook();
  });

  ipcMain.handle(
    IPC.ANTIGRAVITY_NOTIFICATIONS_GET_HOOK_DETAILS,
    async (): Promise<{
      command: string;
      configJson: string;
      settingsPath: string;
      port: number;
      isConfigured: boolean;
      update?: NotificationIntegrationUpdate;
    }> => {
      return {
        command: antigravitySettingsService.getHookCommand(),
        configJson: antigravitySettingsService.getNotificationConfigJson(),
        settingsPath: antigravitySettingsService.getSettingsPath(),
        port: httpServerService.getPort(),
        isConfigured: antigravitySettingsService.isNotificationHookEnabled(),
        update: antigravitySettingsService.getNotificationUpdate(),
      };
    }
  );

  // OpenCode notification handlers
  ipcMain.handle(IPC.OPENCODE_NOTIFICATIONS_ENABLE, async () => {
    opencodeSettingsService.enableNotificationPlugin();
    configService.update({ notificationsEnabled: true });
  });

  ipcMain.handle(IPC.OPENCODE_NOTIFICATIONS_DISABLE, async () => {
    opencodeSettingsService.disableNotificationPlugin();
  });

  ipcMain.handle(
    IPC.OPENCODE_NOTIFICATIONS_GET_HOOK_DETAILS,
    async (): Promise<{
      pluginContent: string;
      pluginPath: string;
      port: number;
      isConfigured: boolean;
      update?: NotificationIntegrationUpdate;
    }> => {
      return {
        pluginContent: opencodeSettingsService.getPluginContent(),
        pluginPath: opencodeSettingsService.getPluginPath(),
        port: httpServerService.getPort(),
        isConfigured: opencodeSettingsService.isNotificationPluginEnabled(),
        update: opencodeSettingsService.getNotificationUpdate(),
      };
    }
  );

  // Komla skill handlers
  ipcMain.handle(
    IPC.KOMLA_SKILL_GET_STATUS,
    handleValidated(
      IPC.KOMLA_SKILL_GET_STATUS,
      komlaSkillArgsSchema,
      async (): Promise<KomlaSkillStatus> => komlaSkillService.getStatus()
    )
  );

  ipcMain.handle(
    IPC.KOMLA_SKILL_ENABLE,
    handleValidated(IPC.KOMLA_SKILL_ENABLE, komlaSkillArgsSchema, async () =>
      komlaSkillService.enable()
    )
  );

  ipcMain.handle(
    IPC.KOMLA_SKILL_DISABLE,
    handleValidated(IPC.KOMLA_SKILL_DISABLE, komlaSkillArgsSchema, async () =>
      komlaSkillService.disable()
    )
  );

  // MCP handlers
  ipcMain.handle(
    IPC.MCP_GET_STATUS,
    async (_event, agent?: string, sshHostId?: string): Promise<McpStatus> => {
      if (sshHostId) sshWorkspaceService.getHost(sshHostId);
      const port = sshHostId ? remoteKomlaDataPort(sshHostId) : httpServerService.getPort();
      const loopbackHost = sshHostId ? '127.0.0.1' : 'localhost';
      const mcpServerUrl = `http://${loopbackHost}:${port}/api/v1/mcp`;

      // SSH agents run their own CLI, which Windows doesn't police.
      const cliBlocked = !sshHostId && isKomlaCliBlocked();
      const { nodeCommand, script } = getNotifyHelper();
      const notifyCommand = cliBlocked
        ? `${JSON.stringify(nodeCommand.replace(/\\/g, '/'))} ${JSON.stringify(script.replace(/\\/g, '/'))} --source my-agent --event Stop`
        : 'komla notify --source my-agent --event Stop';
      const mcpCliCommand = 'komla mcp';
      const mcpConfigJson = JSON.stringify(
        {
          mcpServers: {
            komla: {
              command: 'komla',
              args: ['mcp'],
            },
          },
        },
        null,
        2
      );
      // `komla skill` prints this installed guide, which also covers hooks for a blocked CLI.
      const blockedCliFallback = cliBlocked
        ? ` If Windows refuses to run it, read \`${join(getKomlaBasePath(), 'skills', 'komla-self-integration-instructions.md').replace(/\\/g, '/')}\` instead.`
        : '';
      const integrationPrompt = `# Integrate this agent with Komla

${buildSkillFetchInstruction('self-integration')}${blockedCliFallback}

It walks through wiring up Komla's notification hook and the Komla skill, and stopping this agent asking to trust each new workspace — investigate first, then apply the changes after I approve.`;

      const genericFields = {
        generic: {
          cliCommand: mcpCliCommand,
          configJson: mcpConfigJson,
          notifyCommand,
          integrationPrompt,
        },
      };

      // Remote runtimes and generic agents only need the environment-specific payload.
      if (sshHostId || (agent && !AGENTS_WITH_AUTO_INTEGRATIONS.includes(agent))) {
        return {
          isConfigured: false,
          mcpServerUrl,
          cliCommand: '',
          configJson: '',
          ...genericFields,
        };
      }

      // Base fields without reading Claude's config (used by per-agent paths)
      const baseFields = {
        isConfigured: false,
        mcpServerUrl,
        cliCommand: '',
        configJson: '',
      };

      // If a specific agent was requested, only check that one
      if (agent === 'Claude Code') {
        const claudeStatus = await claudeSettingsService.getMcpStatus(port);
        return { ...claudeStatus, ...genericFields };
      }

      if (agent === 'Codex') {
        const codexMcpStatus = codexSettingsService.getMcpStatus();
        return {
          ...baseFields,
          codex: {
            isConfigured: codexMcpStatus.isConfigured,
            cliCommand: codexSettingsService.getMcpCliCommand(port),
            removeCliCommand: codexSettingsService.getMcpRemoveCliCommand(),
            configToml: codexSettingsService.getMcpConfigToml(port),
            settingsPath: codexSettingsService.getSettingsPath(),
          },
          ...genericFields,
        };
      }

      if (agent === 'Antigravity CLI') {
        const antigravityMcpStatus = antigravitySettingsService.getMcpStatus();
        return {
          ...baseFields,
          antigravity: {
            isConfigured: antigravityMcpStatus.isConfigured,
            cliCommand: antigravitySettingsService.getMcpCliCommand(port),
            removeCliCommand: antigravitySettingsService.getMcpRemoveCliCommand(),
            settingsPath: antigravitySettingsService.getMcpSettingsPath(),
          },
          ...genericFields,
        };
      }

      if (agent === 'OpenCode') {
        const opencodeMcpStatus = opencodeSettingsService.getMcpStatus();
        return {
          ...baseFields,
          opencode: {
            isConfigured: opencodeMcpStatus.isConfigured,
            cliCommand: opencodeSettingsService.getMcpCliCommand(port),
            configJson: opencodeSettingsService.getMcpConfigJson(port),
            settingsPath: opencodeSettingsService.getSettingsPath(),
          },
          ...genericFields,
        };
      }

      // No agent specified — return everything (used by settings page)
      const claudeStatus = await claudeSettingsService.getMcpStatus(port);
      const codexMcpStatus = codexSettingsService.getMcpStatus();
      const antigravityMcpStatus = antigravitySettingsService.getMcpStatus();
      const opencodeMcpStatus = opencodeSettingsService.getMcpStatus();

      return {
        ...claudeStatus,
        codex: {
          isConfigured: codexMcpStatus.isConfigured,
          cliCommand: codexSettingsService.getMcpCliCommand(port),
          removeCliCommand: codexSettingsService.getMcpRemoveCliCommand(),
          configToml: codexSettingsService.getMcpConfigToml(port),
          settingsPath: codexSettingsService.getSettingsPath(),
        },
        antigravity: {
          isConfigured: antigravityMcpStatus.isConfigured,
          cliCommand: antigravitySettingsService.getMcpCliCommand(port),
          removeCliCommand: antigravitySettingsService.getMcpRemoveCliCommand(),
          settingsPath: antigravitySettingsService.getMcpSettingsPath(),
        },
        opencode: {
          isConfigured: opencodeMcpStatus.isConfigured,
          cliCommand: opencodeSettingsService.getMcpCliCommand(port),
          configJson: opencodeSettingsService.getMcpConfigJson(port),
          settingsPath: opencodeSettingsService.getSettingsPath(),
        },
        ...genericFields,
      };
    }
  );

  ipcMain.handle(IPC.MCP_ENABLE, async (): Promise<{ success: boolean; error?: string }> => {
    return claudeSettingsService.enableMcpServer(httpServerService.getPort());
  });

  ipcMain.handle(IPC.MCP_DISABLE, async (): Promise<{ success: boolean; error?: string }> => {
    return claudeSettingsService.disableMcpServer();
  });

  ipcMain.handle(
    IPC.MCP_RUN_CLI,
    async (): Promise<{ success: boolean; output?: string; error?: string }> => {
      const port = httpServerService.getPort();
      const command = claudeSettingsService.loginShellCommand(
        claudeSettingsService.getMcpCliCommand(port)
      );

      return new Promise((resolve) => {
        exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
          if (error) {
            // Fall back to direct file write if CLI not found (e.g. claude not in PATH)
            const errMsg = (stderr.trim() || error.message).toLowerCase();
            if (
              errMsg.includes('command not found') ||
              errMsg.includes('enoent') ||
              errMsg.includes('no such file or directory')
            ) {
              const result = claudeSettingsService.enableMcpServer(port);
              resolve({
                success: result.success,
                output: result.success
                  ? 'Configured via ~/.claude.json (claude CLI not in PATH)'
                  : undefined,
                error: result.error,
              });
            } else {
              resolve({ success: false, error: stderr.trim() || error.message });
            }
          } else {
            resolve({ success: true, output: stdout.trim() });
          }
        });
      });
    }
  );

  ipcMain.handle(
    IPC.MCP_RUN_REMOVE_CLI,
    async (): Promise<{ success: boolean; output?: string; error?: string }> => {
      const command = claudeSettingsService.loginShellCommand(
        claudeSettingsService.getMcpRemoveCliCommand()
      );

      return new Promise((resolve) => {
        exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
          if (error) {
            // Fall back to direct file write if CLI not found (e.g. claude not in PATH)
            const errMsg = (stderr.trim() || error.message).toLowerCase();
            if (
              errMsg.includes('command not found') ||
              errMsg.includes('enoent') ||
              errMsg.includes('no such file or directory')
            ) {
              const result = claudeSettingsService.disableMcpServer();
              resolve({
                success: result.success,
                output: result.success
                  ? 'Removed from ~/.claude.json (claude CLI not in PATH)'
                  : undefined,
                error: result.error,
              });
            } else {
              resolve({ success: false, error: stderr.trim() || error.message });
            }
          } else {
            resolve({ success: true, output: stdout.trim() });
          }
        });
      });
    }
  );

  ipcMain.handle(
    IPC.MCP_RUN_CODEX_CLI,
    async (): Promise<{ success: boolean; output?: string; error?: string }> => {
      const port = httpServerService.getPort();
      const command = claudeSettingsService.loginShellCommand(
        codexSettingsService.getMcpCliCommand(port)
      );

      return new Promise((resolve) => {
        exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
          if (error) {
            // Fall back to direct file write if CLI runtime isn't available in PATH
            // (e.g. "env: node: No such file or directory" from npm-installed shims).
            const errMsg = (stderr.trim() || error.message).toLowerCase();
            if (
              errMsg.includes('command not found') ||
              errMsg.includes('enoent') ||
              errMsg.includes('no such file or directory')
            ) {
              const result = codexSettingsService.enableMcpServer(port);
              resolve({
                success: result.success,
                output: result.success
                  ? 'Configured via ~/.codex/config.toml (codex CLI runtime not in PATH)'
                  : undefined,
                error: result.error,
              });
            } else {
              resolve({ success: false, error: stderr.trim() || error.message });
            }
          } else {
            resolve({ success: true, output: stdout.trim() });
          }
        });
      });
    }
  );

  ipcMain.handle(
    IPC.MCP_RUN_CODEX_REMOVE_CLI,
    async (): Promise<{ success: boolean; output?: string; error?: string }> => {
      const command = claudeSettingsService.loginShellCommand(
        codexSettingsService.getMcpRemoveCliCommand()
      );

      return new Promise((resolve) => {
        exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
          if (error) {
            // Fall back to direct file write if CLI not found (e.g. codex not in PATH)
            const errMsg = (stderr.trim() || error.message).toLowerCase();
            if (
              errMsg.includes('command not found') ||
              errMsg.includes('enoent') ||
              errMsg.includes('no such file or directory')
            ) {
              const result = codexSettingsService.disableMcpServer();
              resolve({
                success: result.success,
                output: result.success
                  ? 'Removed from ~/.codex/config.toml (codex CLI not in PATH)'
                  : undefined,
                error: result.error,
              });
            } else {
              resolve({ success: false, error: stderr.trim() || error.message });
            }
          } else {
            resolve({ success: true, output: stdout.trim() });
          }
        });
      });
    }
  );

  ipcMain.handle(
    IPC.MCP_RUN_ANTIGRAVITY_CLI,
    async (): Promise<{ success: boolean; output?: string; error?: string }> => {
      const port = httpServerService.getPort();
      const command = claudeSettingsService.loginShellCommand(
        antigravitySettingsService.getMcpCliCommand(port)
      );

      return new Promise((resolve) => {
        exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
          if (error) {
            // Fall back to direct file write if agy isn't in PATH.
            const errMsg = (stderr.trim() || error.message).toLowerCase();
            if (
              errMsg.includes('command not found') ||
              errMsg.includes('enoent') ||
              errMsg.includes('no such file or directory')
            ) {
              const result = antigravitySettingsService.enableMcpServer(port);
              resolve({
                success: result.success,
                output: result.success
                  ? 'Configured via ~/.gemini/config/mcp_config.json (agy not in PATH)'
                  : undefined,
                error: result.error,
              });
            } else {
              resolve({ success: false, error: stderr.trim() || error.message });
            }
          } else {
            resolve({ success: true, output: stdout.trim() });
          }
        });
      });
    }
  );

  ipcMain.handle(
    IPC.MCP_RUN_ANTIGRAVITY_REMOVE_CLI,
    async (): Promise<{ success: boolean; output?: string; error?: string }> => {
      const command = claudeSettingsService.loginShellCommand(
        antigravitySettingsService.getMcpRemoveCliCommand()
      );

      return new Promise((resolve) => {
        exec(command, { timeout: 15000 }, (error, stdout, stderr) => {
          if (error) {
            // Fall back to direct file write if CLI not found (e.g. agy not in PATH)
            const errMsg = (stderr.trim() || error.message).toLowerCase();
            if (
              errMsg.includes('command not found') ||
              errMsg.includes('enoent') ||
              errMsg.includes('no such file or directory')
            ) {
              const result = antigravitySettingsService.disableMcpServer();
              resolve({
                success: result.success,
                output: result.success
                  ? 'Removed from ~/.gemini/config/mcp_config.json (agy not in PATH)'
                  : undefined,
                error: result.error,
              });
            } else {
              resolve({ success: false, error: stderr.trim() || error.message });
            }
          } else {
            resolve({ success: true, output: stdout.trim() });
          }
        });
      });
    }
  );

  ipcMain.handle(IPC.SERVER_GET_PORT_CHANGE, (): { oldPort: number; newPort: number } | null => {
    return httpServerService.getPortChangeEvent();
  });

  ipcMain.handle(IPC.SERVER_GET_PORT, (): Promise<number> => {
    // Wait for the server to bind before answering. The renderer can ask
    // before startup finishes, and getPort() would otherwise return the
    // preferred port even if the bind lands on a fallback. onStarted()
    // resolves immediately when the server is already up.
    return new Promise((resolve) => {
      httpServerService.onStarted(() => resolve(httpServerService.getPort()));
    });
  });

  ipcMain.handle(
    IPC.MCP_RECONFIGURE_ALL,
    async (): Promise<{
      success: boolean;
      results: { agent: string; success: boolean; error?: string }[];
    }> => {
      const port = httpServerService.getPort();
      const results: { agent: string; success: boolean; error?: string }[] = [];

      // Claude
      if (claudeSettingsService.isMcpServerInConfig()) {
        const removeCommand = claudeSettingsService.loginShellCommand(
          claudeSettingsService.getMcpRemoveCliCommand()
        );
        const removeResult = await new Promise<{
          success: boolean;
          output?: string;
          error?: string;
        }>((resolve) => {
          exec(removeCommand, { timeout: 15000 }, (error, stdout, stderr) => {
            if (error) {
              const errMsg = (stderr.trim() || error.message).toLowerCase();
              if (
                errMsg.includes('command not found') ||
                errMsg.includes('enoent') ||
                errMsg.includes('no such file or directory')
              ) {
                const result = claudeSettingsService.disableMcpServer();
                resolve({
                  success: result.success,
                  output: result.success
                    ? 'Removed from ~/.claude.json (claude CLI not in PATH)'
                    : undefined,
                  error: result.error,
                });
              } else {
                resolve({ success: false, error: stderr.trim() || error.message });
              }
            } else {
              resolve({ success: true, output: stdout.trim() });
            }
          });
        });

        if (!removeResult.success) {
          results.push({ agent: 'claude', success: false, error: removeResult.error });
        } else {
          const addCommand = claudeSettingsService.loginShellCommand(
            claudeSettingsService.getMcpCliCommand(port)
          );
          const addResult = await new Promise<{
            success: boolean;
            output?: string;
            error?: string;
          }>((resolve) => {
            exec(addCommand, { timeout: 15000 }, (error, stdout, stderr) => {
              if (error) {
                const errMsg = (stderr.trim() || error.message).toLowerCase();
                if (
                  errMsg.includes('command not found') ||
                  errMsg.includes('enoent') ||
                  errMsg.includes('no such file or directory')
                ) {
                  const result = claudeSettingsService.enableMcpServer(port);
                  resolve({
                    success: result.success,
                    output: result.success
                      ? 'Configured via ~/.claude.json (claude CLI not in PATH)'
                      : undefined,
                    error: result.error,
                  });
                } else {
                  resolve({ success: false, error: stderr.trim() || error.message });
                }
              } else {
                resolve({ success: true, output: stdout.trim() });
              }
            });
          });
          results.push({ agent: 'claude', success: addResult.success, error: addResult.error });
        }
      }

      // Codex
      if (codexSettingsService.getMcpStatus().isConfigured) {
        const removeCommand = claudeSettingsService.loginShellCommand(
          codexSettingsService.getMcpRemoveCliCommand()
        );
        const removeResult = await new Promise<{
          success: boolean;
          output?: string;
          error?: string;
        }>((resolve) => {
          exec(removeCommand, { timeout: 15000 }, (error, stdout, stderr) => {
            if (error) {
              const errMsg = (stderr.trim() || error.message).toLowerCase();
              if (
                errMsg.includes('command not found') ||
                errMsg.includes('enoent') ||
                errMsg.includes('no such file or directory')
              ) {
                const result = codexSettingsService.disableMcpServer();
                resolve({
                  success: result.success,
                  output: result.success
                    ? 'Removed from ~/.codex/config.toml (codex CLI not in PATH)'
                    : undefined,
                  error: result.error,
                });
              } else {
                resolve({ success: false, error: stderr.trim() || error.message });
              }
            } else {
              resolve({ success: true, output: stdout.trim() });
            }
          });
        });

        if (!removeResult.success) {
          results.push({ agent: 'codex', success: false, error: removeResult.error });
        } else {
          const addCommand = claudeSettingsService.loginShellCommand(
            codexSettingsService.getMcpCliCommand(port)
          );
          const addResult = await new Promise<{
            success: boolean;
            output?: string;
            error?: string;
          }>((resolve) => {
            exec(addCommand, { timeout: 15000 }, (error, stdout, stderr) => {
              if (error) {
                const errMsg = (stderr.trim() || error.message).toLowerCase();
                if (
                  errMsg.includes('command not found') ||
                  errMsg.includes('enoent') ||
                  errMsg.includes('no such file or directory')
                ) {
                  const result = codexSettingsService.enableMcpServer(port);
                  resolve({
                    success: result.success,
                    output: result.success
                      ? 'Configured via ~/.codex/config.toml (codex CLI runtime not in PATH)'
                      : undefined,
                    error: result.error,
                  });
                } else {
                  resolve({ success: false, error: stderr.trim() || error.message });
                }
              } else {
                resolve({ success: true, output: stdout.trim() });
              }
            });
          });
          results.push({ agent: 'codex', success: addResult.success, error: addResult.error });
        }
      }

      // Antigravity CLI
      if (antigravitySettingsService.getMcpStatus().isConfigured) {
        const removeCommand = claudeSettingsService.loginShellCommand(
          antigravitySettingsService.getMcpRemoveCliCommand()
        );
        const removeResult = await new Promise<{
          success: boolean;
          output?: string;
          error?: string;
        }>((resolve) => {
          exec(removeCommand, { timeout: 15000 }, (error, stdout, stderr) => {
            if (error) {
              const errMsg = (stderr.trim() || error.message).toLowerCase();
              if (
                errMsg.includes('command not found') ||
                errMsg.includes('enoent') ||
                errMsg.includes('no such file or directory')
              ) {
                const result = antigravitySettingsService.disableMcpServer();
                resolve({
                  success: result.success,
                  output: result.success
                    ? 'Removed from ~/.gemini/config/mcp_config.json (agy not in PATH)'
                    : undefined,
                  error: result.error,
                });
              } else {
                resolve({ success: false, error: stderr.trim() || error.message });
              }
            } else {
              resolve({ success: true, output: stdout.trim() });
            }
          });
        });

        if (!removeResult.success) {
          results.push({ agent: 'antigravity', success: false, error: removeResult.error });
        } else {
          const addCommand = claudeSettingsService.loginShellCommand(
            antigravitySettingsService.getMcpCliCommand(port)
          );
          const addResult = await new Promise<{
            success: boolean;
            output?: string;
            error?: string;
          }>((resolve) => {
            exec(addCommand, { timeout: 15000 }, (error, stdout, stderr) => {
              if (error) {
                const errMsg = (stderr.trim() || error.message).toLowerCase();
                if (
                  errMsg.includes('command not found') ||
                  errMsg.includes('enoent') ||
                  errMsg.includes('no such file or directory')
                ) {
                  const result = antigravitySettingsService.enableMcpServer(port);
                  resolve({
                    success: result.success,
                    output: result.success
                      ? 'Configured via ~/.gemini/config/mcp_config.json (agy not in PATH)'
                      : undefined,
                    error: result.error,
                  });
                } else {
                  resolve({ success: false, error: stderr.trim() || error.message });
                }
              } else {
                resolve({ success: true, output: stdout.trim() });
              }
            });
          });
          results.push({
            agent: 'antigravity',
            success: addResult.success,
            error: addResult.error,
          });
        }
      }

      return { success: true, results };
    }
  );
}
