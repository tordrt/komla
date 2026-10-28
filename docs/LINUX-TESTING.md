# Testing on Linux

Two setups answer different questions:

- **Virtual desktop on a headless host**: `scripts/linux-desktop.sh` runs the dev build on a TigerVNC display you view through an SSH tunnel. It covers terminals, shells, Git, paths, and the UI on Linux. The host has no GPU (rendering falls back to software), keyring, notification daemon, tray, or Wayland.
- **Desktop VM**: covers what real users hit; see [Desktop VM](#desktop-vm).

## Virtual desktop on a headless host

One-time setup on a Debian or Ubuntu host, in a checkout that has run `npm install`:

```bash
sudo apt install -y tigervnc-standalone-server openbox
```

Start the display, then Komla:

```bash
bash scripts/linux-desktop.sh start    # display :1, VNC on 127.0.0.1:5901; prints the password
bash scripts/linux-desktop.sh komla    # runs scripts/dev.sh default on the display
```

`komla` takes `scripts/dev.sh` arguments: `komla sandbox-fresh` gives a first-run onboarding with throwaway data, and `komla default --companion` builds the companion that SSH workspace features need. The renderer hot-reloads; after main-process changes, run `stop-komla` then `komla`. Run the script without arguments for the remaining commands, including `screenshot`, which captures the display over VNC so an agent can check it without a viewer.

### Connect from a Mac

One command opens the tunnel and, once it is up, Screen Sharing:

```bash
ssh -N -o ExitOnForwardFailure=yes -o PermitLocalCommand=yes \
  -o LocalCommand='open vnc://localhost:5901' -L 5901:localhost:5901 <user>@<host>
```

Enter the password from `linux-desktop.sh status` and let Screen Sharing remember it. The tunnel lasts as long as the command runs, so it fits a Komla Terminal Command action in a local project; a second copy fails while the first holds local port 5901. Komla's Linux shortcuts use Ctrl, not Cmd.

### Gotchas

- **Clean environment:** the script launches Komla with a desktop-like environment. Started from a Komla terminal, the inherited `KOMLA_*` variables would point the test instance's terminals at the Komla you launched from.
- **Display already in use:** when another X server of yours holds the display, `start` uses it and `stop` leaves it running; `status` shows its pid, VNC uses that server's own password, and `screenshot` is unavailable. Another user's display is refused; choose a free one with `DESKTOP_DISPLAY`. A lock left by a crashed server is removed.
- **Shared hosts:** electron-vite serves the renderer on `localhost:5173`. When another dev server holds `127.0.0.1:5173`, Vite binds `[::1]:5173` and the window still loads Komla; a reload that shows a different app is that clash.
- **Other worktrees:** `KOMLA_CHECKOUT=<path> bash scripts/linux-desktop.sh komla` runs another checkout's dev build.

## Desktop VM

Before calling Linux support done, run the packaged AppImage on Ubuntu 24.04 Desktop, for example in UTM on Apple Silicon with the arm64 AppImage. Expect:

- **FUSE:** AppImages need `libfuse2t64`; without it, launch with `--appimage-extract-and-run`.
- **Sandbox:** Ubuntu's AppArmor restriction on unprivileged user namespaces can stop Electron's sandbox, and with it the AppImage, from starting.
- **Desktop integration:** Wayland by default, the keyring behind Electron `safeStorage`, notifications, and the tray.
