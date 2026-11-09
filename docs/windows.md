# Clearsky on Windows

On Windows, Clearsky runs in Linux under WSL2 (Ubuntu), and you use it from Windows: in Edge or Chrome at http://127.0.0.1:7777, or in a window of its own. WSL2 forwards that address to Windows by itself. Your logins (gh, acli) and the Copilot sandbox live in Ubuntu, exactly as on a Linux machine; links and logins open in your Windows browser.

`clearsky doctor` and the welcome page notice WSL and say what's missing there, with the command to run.

## 1. WSL2 and Ubuntu

In PowerShell, as administrator:

```powershell
wsl --install -d Ubuntu
```

Restart when it asks, open **Ubuntu** from the Start menu and pick a user name and password. Check it's WSL2 and not WSL1 (Clearsky can't use WSL1: no sandbox, no VM):

```powershell
wsl -l -v                     # VERSION should say 2
wsl --set-version Ubuntu 2    # if it says 1
```

## 2. What Clearsky uses, inside Ubuntu

Everything from here on runs in the Ubuntu terminal, not in PowerShell.

```sh
sudo apt update
sudo apt install git gh wslu bubblewrap socat ripgrep
```

- `wslu` gives `wslview`, which opens links and logins in your Windows browser.
- `bubblewrap`, `socat` and `ripgrep` are what the Copilot sandbox uses, as on any Linux.
- The Atlassian CLI, if you use Jira: [Atlassian's Linux instructions](https://developer.atlassian.com/cloud/acli/guides/install-acli/) (the Debian/Ubuntu ones).

Node 22 or newer: Ubuntu's own is older, so use nvm (the installer picks it up). Then the GitHub Copilot CLI, for chats:

```sh
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
exec bash
nvm install 22
npm install -g @github/copilot
```

Use the Linux versions of these tools, not the Windows ones: a Windows `gh.exe` or Node keeps its login and files on the Windows side, where Clearsky in Ubuntu can't use them.

## 3. Install Clearsky

Clone it, and your repos, into your Linux home (`~/dev`), not under `/mnt/c`. Windows drives are slow through WSL, and git there sees every file as changed.

```sh
mkdir -p ~/dev && cd ~/dev
git clone https://github.com/ethlo/clearsky && cd clearsky
sh scripts/install.sh
clearsky try        # made-up data first, at http://127.0.0.1:7790
clearsky serve      # the real thing
```

Open **http://127.0.0.1:7777** in your Windows browser. The first time it's the welcome page.

## 4. Log in

The welcome page has a button each for GitHub and Jira. In a terminal it's the same:

```sh
gh auth login --web
acli jira auth login --web
```

With `wslview` installed, both open the login in your Windows browser (Clearsky sets `BROWSER=wslview` for them when you haven't set `BROWSER` yourself). Without it, open the address they print. acli's login calls back to a port on 127.0.0.1, which WSL2 forwards, so it finishes on its own.

## 5. Its own window

```sh
clearsky app
```

This opens Clearsky in Edge (or Chrome) on Windows as an app window: no tabs or address bar, its own taskbar icon. It starts the server first if it isn't running. Its browser profile is kept on Windows, in `%LOCALAPPDATA%\Clearsky\app-window`. `CLEARSKY_BROWSER` picks another browser.

Or, in Edge at http://127.0.0.1:7777: **… → Apps → Install this site as an app**. That gives Clearsky a Start menu entry and taskbar icon of its own; the server has to be running for it to load.

To start it from Windows with one click, make a shortcut with this target, set to **Run: Minimized**:

```
wsl.exe -d Ubuntu -- bash -lc "clearsky app; tail -f ~/.cache/clearsky/clearsky.log"
```

The minimized window keeps Ubuntu running: WSL may stop it a while after its last window closes, and Clearsky with it.

To start Clearsky with Ubuntu instead, turn on systemd in WSL and use the service. Add this to `/etc/wsl.conf`:

```ini
[boot]
systemd=true
```

then `wsl --shutdown` in PowerShell, open Ubuntu again, and run `sh scripts/install.sh --service`.

## Calendar

GNOME Online Accounts, which Clearsky uses for calendars on Linux, isn't there in WSL. Use your calendar's iCal link instead: in Google Calendar, **Settings → your calendar → Integrate calendar → Secret address in iCal format**, and paste it in Clearsky under **Settings → Google Calendar**. Some workplaces turn that link off; without it, Now / Next and the day's schedule stay empty, and everything else works.

## The Copilot sandbox

Sandboxed chats use srt with bubblewrap inside WSL2, the same as on Linux (not srt's Windows mode, which needs an administrator setup). Under WSL the sandbox also hides:

- the Windows drives (`/mnt/c` and the rest), which hold your Windows profile and its browsers' data. A folder you give Copilot there (Settings → Copilot) is let back in, but your repos are better off in `~/dev`.
- WSL's interop socket (`/run/WSL`), so a sandboxed command can't start a Windows program such as `cmd.exe` or `powershell.exe` outside the sandbox.

## Builds that need Docker (the VM)

Tests that start containers (Testcontainers) run in a VM of the chat's own, on KVM. Under WSL2 that VM runs inside WSL's own, which needs nested virtualisation:

**Windows 11:** put this in `%UserProfile%\.wslconfig`, then `wsl --shutdown` in PowerShell:

```ini
[wsl2]
nestedVirtualization=true
```

Then in Ubuntu: `sudo apt install qemu-system-x86 qemu-utils openssh-client socat`, and if `/dev/kvm` is there but not yours, `sudo usermod -aG kvm $USER` and `wsl --shutdown` again.

**Windows 10** can't do nested virtualisation in WSL, so there's no VM there.

`clearsky doctor` says which it is. Without the VM, Copilot runs such builds with `outside`, on Ubuntu itself after asking you each time, so they need Docker there: Docker Desktop with WSL integration turned on for Ubuntu, or Docker Engine installed in Ubuntu.

## Notifications

WSL has no desktop of its own to show notifications on, so Clearsky shows them through the browser: allow notifications for http://127.0.0.1:7777 when it asks (or under **Notifications** in the menu).

## If something's off

- **http://127.0.0.1:7777 doesn't open in Windows:** check that `clearsky serve` is running in Ubuntu, then `wsl --shutdown` in PowerShell and start it again. If it still doesn't, see that `localhostForwarding` isn't set to `false` in `%UserProfile%\.wslconfig`. On Windows 11, `networkingMode=mirrored` under `[wsl2]` there is another way.
- **A login doesn't open a browser:** `sudo apt install wslu`, or open the address the command printed.
- **The School plugin's login:** it opens a Linux Chromium in a window of its own (WSLg shows it), since it talks to that browser directly. Install Chromium in Ubuntu for it.
- `clearsky doctor` lists the rest.
