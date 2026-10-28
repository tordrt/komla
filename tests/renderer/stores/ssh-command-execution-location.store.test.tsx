/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { createDeferred } from "../../setup";
import { createWorkspace } from "../../factories";
import { SshCommandExecutionLocationDialogHost } from "../../../src/renderer/components/workspaces/SshCommandExecutionLocationDialogHost";
import { useConfigStore } from "../../../src/renderer/stores/config.store";
import { useProjectsStore } from "../../../src/renderer/stores/projects.store";
import { useSshCommandExecutionLocationStore } from "../../../src/renderer/stores/ssh-command-execution-location.store";
import { useSshHostsStore } from "../../../src/renderer/stores/ssh-hosts.store";

const host = {
  id: "ssh-dev",
  name: "Devbox",
  hostname: "dev.example.com",
  basePath: "~/.komla",
  capabilities: {
    checkedAt: "2026-09-02T00:00:00.000Z",
    git: { status: "available" as const },
    localMirror: {
      platform: "supported" as const,
      localRsync: "available" as const,
      remoteRsync: "available" as const,
    },
    tmux: { status: "available" as const },
  },
};

const workspace = createWorkspace({
  id: "ssh-workspace",
  projectId: "project-1",
  backend: { kind: "ssh", hostId: host.id },
});

const hostMissingRemoteRsync = {
  ...host,
  capabilities: {
    ...host.capabilities,
    localMirror: {
      ...host.capabilities.localMirror,
      remoteRsync: "missing" as const,
    },
  },
};

function resetStores(): void {
  useConfigStore.setState(useConfigStore.getInitialState(), true);
  useProjectsStore.setState(useProjectsStore.getInitialState(), true);
  useSshHostsStore.setState(useSshHostsStore.getInitialState(), true);
  useSshCommandExecutionLocationStore.setState(
    useSshCommandExecutionLocationStore.getInitialState(),
    true,
  );
}

describe("ssh-command-execution-location.store", () => {
  beforeEach(() => {
    resetStores();
    window.api = {
      listSshHosts: vi.fn().mockResolvedValue([host]),
      getProjects: vi.fn().mockResolvedValue([]),
      getWorkspace: vi.fn().mockResolvedValue(workspace),
      verifySshHost: vi.fn(),
      setProjectSshWorkspaceModeIfUnset: vi
        .fn()
        .mockImplementation(async (id, mode) => ({
          id,
          name: id === "project-1" ? "Project" : "Second Project",
          sshWorkspaceMode: mode,
        })),
    } as never;
    useProjectsStore.setState({
      projects: [{ id: "project-1", name: "Project" } as never],
      hasLoaded: true,
    });
  });

  it("uses cached Local copy capabilities without verifying the SSH host", async () => {
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });

    const resolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);

    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );
    expect(window.api.verifySshHost).not.toHaveBeenCalled();

    useSshCommandExecutionLocationStore.getState().cancel();
    await expect(resolution).resolves.toBeNull();
  });

  it("waits for SSH hosts to load before deciding whether to ask", async () => {
    const hosts = createDeferred<(typeof host)[]>();
    window.api.listSshHosts = vi.fn().mockReturnValue(hosts.promise);

    const resolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);

    await vi.waitFor(() =>
      expect(window.api.listSshHosts).toHaveBeenCalledOnce(),
    );
    expect(window.api.verifySshHost).not.toHaveBeenCalled();

    hosts.resolve([host]);
    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );
    expect(window.api.verifySshHost).not.toHaveBeenCalled();
    expect(
      useSshCommandExecutionLocationStore.getState().pending?.workspaceId,
    ).toBe(workspace.id);

    useSshCommandExecutionLocationStore.getState().cancel();
    await expect(resolution).resolves.toBeNull();
  });

  it("queues concurrent requests while the first choice is loading", async () => {
    const hosts = createDeferred<(typeof host)[]>();
    window.api.listSshHosts = vi.fn().mockReturnValue(hosts.promise);

    const firstResolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    const secondResolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);

    hosts.resolve([host]);
    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );

    useSshCommandExecutionLocationStore.getState().setChoice("remote");
    await useSshCommandExecutionLocationStore.getState().confirm();

    await expect(firstResolution).resolves.toBe("remote");
    await expect(secondResolution).resolves.toBe("remote");
    expect(window.api.verifySshHost).not.toHaveBeenCalled();
  });

  it("queues choices for different projects instead of dropping either command", async () => {
    const secondWorkspace = createWorkspace({
      id: "ssh-workspace-2",
      projectId: "project-2",
      backend: { kind: "ssh", hostId: host.id },
    });
    useProjectsStore.setState({
      projects: [
        { id: "project-1", name: "Project" } as never,
        { id: "project-2", name: "Second Project" } as never,
      ],
      hasLoaded: true,
    });
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });

    const firstResolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    const secondResolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(secondWorkspace);

    await vi.waitFor(() =>
      expect(
        useSshCommandExecutionLocationStore.getState().pending?.workspaceId,
      ).toBe(workspace.id),
    );
    await useSshCommandExecutionLocationStore.getState().confirm();
    await expect(firstResolution).resolves.toBe("remote");

    await vi.waitFor(() =>
      expect(
        useSshCommandExecutionLocationStore.getState().pending?.workspaceId,
      ).toBe(secondWorkspace.id),
    );
    await useSshCommandExecutionLocationStore.getState().confirm();
    await expect(secondResolution).resolves.toBe("remote");
  });

  it("drops a queued choice after its originating Workspace is deleted", async () => {
    const secondWorkspace = createWorkspace({
      id: "ssh-workspace-2",
      projectId: "project-2",
      backend: { kind: "ssh", hostId: host.id },
    });
    let secondWorkspaceExists = true;
    window.api.getWorkspace = vi.fn().mockImplementation(async (workspaceId) =>
      workspaceId === workspace.id
        ? workspace
        : secondWorkspaceExists
          ? secondWorkspace
          : undefined,
    );
    useProjectsStore.setState({
      projects: [
        { id: "project-1", name: "Project" } as never,
        { id: "project-2", name: "Second Project" } as never,
      ],
      hasLoaded: true,
    });
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });

    const firstResolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    const secondResolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(secondWorkspace);
    await vi.waitFor(() =>
      expect(
        useSshCommandExecutionLocationStore.getState().pending?.workspaceId,
      ).toBe(workspace.id),
    );

    secondWorkspaceExists = false;
    await useSshCommandExecutionLocationStore.getState().confirm();
    await expect(firstResolution).resolves.toBe("remote");

    await vi.waitFor(() =>
      expect(window.api.getWorkspace).toHaveBeenCalledWith(secondWorkspace.id),
    );
    await expect(secondResolution).resolves.toBeNull();
    expect(useSshCommandExecutionLocationStore.getState().pending).toBeNull();
    expect(window.api.setProjectSshWorkspaceModeIfUnset).toHaveBeenCalledTimes(1);
  });

  it("does not save a choice after the chooser's Workspace is deleted", async () => {
    let workspaceExists = true;
    window.api.getWorkspace = vi.fn().mockImplementation(async () =>
      workspaceExists ? workspace : undefined,
    );
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });
    const resolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );

    workspaceExists = false;
    await useSshCommandExecutionLocationStore.getState().confirm();

    await expect(resolution).resolves.toBeNull();
    expect(window.api.setProjectSshWorkspaceModeIfUnset).not.toHaveBeenCalled();
  });

  it("waits for projects to load before checking the project choice", async () => {
    const projects = createDeferred<never[]>();
    window.api.getProjects = vi.fn().mockReturnValue(projects.promise);
    useProjectsStore.setState({ projects: [], hasLoaded: false });
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });

    const resolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);

    expect(window.api.verifySshHost).not.toHaveBeenCalled();
    projects.resolve([{ id: "project-1", name: "Loaded Project" } as never]);
    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );
    expect(window.api.verifySshHost).not.toHaveBeenCalled();

    useSshCommandExecutionLocationStore.getState().cancel();
    await expect(resolution).resolves.toBeNull();
  });

  it("runs remotely without asking when rsync requirements are not satisfied", async () => {
    useSshHostsStore.setState({
      hosts: [hostMissingRemoteRsync],
      hasLoaded: true,
    });

    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(workspace),
    ).resolves.toBe("remote");
    expect(useSshCommandExecutionLocationStore.getState().pending).toBeNull();
    expect(window.api.verifySshHost).not.toHaveBeenCalled();
  });

  it("runs remotely without asking when cached capabilities are unavailable", async () => {
    useSshHostsStore.setState({
      hosts: [{ ...host, capabilities: undefined }],
      hasLoaded: true,
    });

    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(workspace),
    ).resolves.toBe("remote");
    expect(useSshCommandExecutionLocationStore.getState().pending).toBeNull();
    expect(window.api.verifySshHost).not.toHaveBeenCalled();
  });

  it("uses cached requirements before honoring a saved Local copy choice", async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: "project-1",
          name: "Project",
          sshWorkspaceMode: "local-mirror-actions",
        } as never,
      ],
      hasLoaded: true,
    });
    useSshHostsStore.setState({
      hosts: [hostMissingRemoteRsync],
      hasLoaded: true,
    });

    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(workspace),
    ).resolves.toBe("remote");
    expect(window.api.verifySshHost).not.toHaveBeenCalled();
  });

  it("runs an Action set to the remote machine remotely in a Local copy project", async () => {
    const localCopyProject = {
      id: "project-1",
      name: "Project",
      sshWorkspaceMode: "local-mirror-actions",
    };
    useProjectsStore.setState({ projects: [localCopyProject as never], hasLoaded: true });
    window.api.getProjects = vi.fn().mockResolvedValue([localCopyProject]);
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });

    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(workspace, "remote"),
    ).resolves.toBe("remote");
  });

  it("runs an Action set to this computer in the Local copy without asking", async () => {
    const remoteProject = { id: "project-1", name: "Project", sshWorkspaceMode: "remote" };
    useProjectsStore.setState({ projects: [remoteProject as never], hasLoaded: true });
    window.api.getProjects = vi.fn().mockResolvedValue([remoteProject]);
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });

    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(workspace, "local-mirror"),
    ).resolves.toBe("local-mirror");

    useProjectsStore.setState({
      projects: [{ id: "project-1", name: "Project" } as never],
      hasLoaded: true,
    });
    window.api.getProjects = vi.fn().mockResolvedValue([]);
    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(workspace, "local-mirror"),
    ).resolves.toBe("local-mirror");
    expect(useSshCommandExecutionLocationStore.getState().pending).toBeNull();
  });

  it("runs an Action set to this computer without waiting for projects to load", async () => {
    window.api.getProjects = vi.fn().mockReturnValue(createDeferred<never[]>().promise);
    useProjectsStore.setState({ projects: [], hasLoaded: false });
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });

    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(workspace, "local-mirror"),
    ).resolves.toBe("local-mirror");
    expect(window.api.getProjects).not.toHaveBeenCalled();
  });

  it("runs an Action set to this computer remotely without Local copy support", async () => {
    useSshHostsStore.setState({ hosts: [hostMissingRemoteRsync], hasLoaded: true });

    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(workspace, "local-mirror"),
    ).resolves.toBe("remote");
    expect(useSshCommandExecutionLocationStore.getState().pending).toBeNull();
  });

  it("runs an Action with a location of its own while another project's choice is open", async () => {
    const secondWorkspace = createWorkspace({
      id: "ssh-workspace-2",
      projectId: "project-2",
      backend: { kind: "ssh", hostId: host.id },
    });
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });
    const chosen = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );

    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(secondWorkspace, "remote"),
    ).resolves.toBe("remote");
    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(secondWorkspace, "local-mirror"),
    ).resolves.toBe("local-mirror");

    useSshCommandExecutionLocationStore.getState().cancel();
    await expect(chosen).resolves.toBeNull();
  });

  it("queues an Action with an unknown location behind another project's choice", async () => {
    const secondWorkspace = createWorkspace({
      id: "ssh-workspace-2",
      projectId: "project-2",
      backend: { kind: "ssh", hostId: host.id },
    });
    useProjectsStore.setState({
      projects: [
        { id: "project-1", name: "Project" } as never,
        { id: "project-2", name: "Second Project" } as never,
      ],
      hasLoaded: true,
    });
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });
    const chosen = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );

    // From a hand-edited actions.json, which Komla loads as is.
    const unknown = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(secondWorkspace, "local" as never);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      useSshCommandExecutionLocationStore.getState().pending?.workspaceId,
    ).toBe(workspace.id);

    useSshCommandExecutionLocationStore.getState().cancel();
    await expect(chosen).resolves.toBeNull();
    await vi.waitFor(() =>
      expect(
        useSshCommandExecutionLocationStore.getState().pending?.workspaceId,
      ).toBe(secondWorkspace.id),
    );
    useSshCommandExecutionLocationStore.getState().cancel();
    await expect(unknown).resolves.toBeNull();
  });

  it("uses a project choice received while SSH hosts are loading", async () => {
    const hosts = createDeferred<(typeof host)[]>();
    window.api.listSshHosts = vi.fn().mockReturnValue(hosts.promise);

    const resolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    await vi.waitFor(() =>
      expect(window.api.listSshHosts).toHaveBeenCalledOnce(),
    );

    window.api.getProjects = vi.fn().mockResolvedValue([
      {
        id: "project-1",
        name: "Project",
        sshWorkspaceMode: "local-mirror-actions",
      } as never,
    ]);
    hosts.resolve([host]);

    await expect(resolution).resolves.toBe("local-mirror");
    expect(window.api.getProjects).toHaveBeenCalledOnce();
    expect(window.api.verifySshHost).not.toHaveBeenCalled();
    expect(useSshCommandExecutionLocationStore.getState().pending).toBeNull();
  });

  it("refreshes a cached Remote choice before launching the command", async () => {
    useProjectsStore.setState({
      projects: [
        {
          id: "project-1",
          name: "Project",
          sshWorkspaceMode: "remote",
        } as never,
      ],
      hasLoaded: true,
    });
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });
    window.api.getProjects = vi.fn().mockResolvedValue([
      {
        id: "project-1",
        name: "Project",
        sshWorkspaceMode: "local-mirror-actions",
      } as never,
    ]);

    await expect(
      useSshCommandExecutionLocationStore
        .getState()
        .requestExecutionLocation(workspace),
    ).resolves.toBe("local-mirror");
    expect(window.api.getProjects).toHaveBeenCalled();
    expect(window.api.verifySshHost).not.toHaveBeenCalled();
  });

  it("saves the app-level dialog choice for the originating project", async () => {
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });
    const resolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    render(<SshCommandExecutionLocationDialogHost />);

    expect(
      await screen.findByText("Where should Terminal Commands run by default?"),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "This computer" }));
    await user.click(screen.getByRole("button", { name: "Run on this computer" }));

    await expect(resolution).resolves.toBe("local-mirror");
    expect(window.api.setProjectSshWorkspaceModeIfUnset).toHaveBeenCalledWith(
      "project-1",
      "local-mirror-actions",
    );
  });

  it("uses the choice selected when confirmation starts", async () => {
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });
    const resolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );

    const savedProject = createDeferred<never>();
    window.api.setProjectSshWorkspaceModeIfUnset = vi
      .fn()
      .mockReturnValue(savedProject.promise);
    useSshCommandExecutionLocationStore
      .getState()
      .setChoice("local-mirror-actions");
    const confirmation = useSshCommandExecutionLocationStore
      .getState()
      .confirm();

    useSshCommandExecutionLocationStore.getState().setChoice("remote");
    savedProject.resolve({
      id: "project-1",
      name: "Project",
      sshWorkspaceMode: "local-mirror-actions",
    } as never);
    await confirmation;

    await expect(resolution).resolves.toBe("local-mirror");
    expect(window.api.setProjectSshWorkspaceModeIfUnset).toHaveBeenCalledWith(
      "project-1",
      "local-mirror-actions",
    );
  });

  it("uses the first project choice persisted by any app window", async () => {
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });
    const resolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );
    window.api.setProjectSshWorkspaceModeIfUnset = vi.fn().mockResolvedValue({
      id: "project-1",
      name: "Project",
      sshWorkspaceMode: "remote",
    } as never);
    useSshCommandExecutionLocationStore
      .getState()
      .setChoice("local-mirror-actions");

    await useSshCommandExecutionLocationStore.getState().confirm();

    await expect(resolution).resolves.toBe("remote");
    expect(window.api.setProjectSshWorkspaceModeIfUnset).toHaveBeenCalledWith(
      "project-1",
      "local-mirror-actions",
    );
  });

  it("dismisses a pending choice when another app window saves the project mode", async () => {
    useSshHostsStore.setState({ hosts: [host], hasLoaded: true });
    const resolution = useSshCommandExecutionLocationStore
      .getState()
      .requestExecutionLocation(workspace);
    await vi.waitFor(() =>
      expect(useSshCommandExecutionLocationStore.getState().pending).not.toBeNull(),
    );
    useSshCommandExecutionLocationStore
      .getState()
      .setChoice("local-mirror-actions");

    useProjectsStore.setState({
      projects: [
        {
          id: "project-1",
          name: "Project",
          sshWorkspaceMode: "remote",
        } as never,
      ],
    });

    await expect(resolution).resolves.toBe("remote");
    expect(useSshCommandExecutionLocationStore.getState().pending).toBeNull();
    expect(window.api.setProjectSshWorkspaceModeIfUnset).not.toHaveBeenCalled();
  });
});
