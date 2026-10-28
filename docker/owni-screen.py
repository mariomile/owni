#!/usr/bin/python3 -I
"""
The agente's screen inside its computer (ADR 0135): a virtual screen (Xvfb) with Chromium,
driven with xdotool and looked at with ImageMagick. It runs as uid 1001, apart from the commands
(uid 1000): they cannot read its profile in /screen, end it, or look at it, since X wants the
cookie in /screen/run. Downloads go to /work/Downloads, which the commands read.

  owni-screen '{"tool": "click", "args": {"x": 10, "y": 20}}'

The tools are the ones Owni's desktop tools call (src/core/desktop.ts, DESKTOP_TOOLS), and
`restart`, which ends Chromium and Xvfb (the settings' «Riavvia lo schermo»). It
answers {"text", "image" (base64 PNG), "structured"} on stdout; a refusal Owni says as it is
exits 3 with the reason on stderr, anything else exits 1. Xvfb and Chromium are started on the
first call and left running for the next; the machine stopping ends them, the profile stays.
"""
import base64
import fcntl
import json
import os
import secrets
import struct
import subprocess
import sys
import time

SCREEN = os.environ.get("OWNI_SCREEN_DIR", "/screen")
WORK = os.environ.get("OWNI_RUN_WORK", "/work")
RUN = os.path.join(SCREEN, "run")
PROFILE = os.path.join(SCREEN, "profile")
DOWNLOADS = os.path.join(WORK, "Downloads")
X11 = "/tmp/.X11-unix"
UID, WORK_GID = 1001, 1000
WIDTH, HEIGHT = 1280, 800
BROWSERS = ("chromium", "chrome", "google chrome", "browser", "web browser", "firefox", "internet")
BUTTONS = {"left": "1", "middle": "2", "right": "3"}
WHEEL = {"up": "4", "down": "5", "left": "6", "right": "7"}
MODIFIERS = {"ctrl", "alt", "shift", "super"}
CHROMIUM = [
    "chromium",
    f"--user-data-dir={PROFILE}",
    # The machine is the sandbox (ADR 0135): Chromium's own wants user namespaces, closed on Fly.
    "--no-sandbox",
    # No infobar about the flag above over the page.
    "--test-type",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--disable-features=Translate,MediaRouter",
    "--window-position=0,0",
    f"--window-size={WIDTH},{HEIGHT}",
    f"--disk-cache-dir={SCREEN}/cache",
    "--disk-cache-size=104857600",
]


class Refused(Exception):
    """Something Owni says as it is: an app that is not here, an argument out of range."""


def env(display):
    return {
        "DISPLAY": display,
        "XAUTHORITY": os.path.join(RUN, "xauth"),
        "HOME": SCREEN,
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "PATH": "/usr/local/bin:/usr/bin:/bin",
    }


def mine(path):
    """A folder of this user, nobody else's to read: made if missing, never followed if a link."""
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    info = os.lstat(path)
    if not os.path.isdir(path) or os.path.islink(path) or info.st_uid != os.getuid():
        raise RuntimeError(f"{path} is not the screen's own folder")
    os.chmod(path, 0o700)


def checked():
    """The places the screen trusts are its own: a command could otherwise stand in for X."""
    if os.getuid() != UID and os.environ.get("OWNI_SCREEN_ANY_UID") != "1":
        raise RuntimeError(f"owni-screen runs as uid {UID}, not {os.getuid()}")
    info = os.lstat(SCREEN)
    if os.path.islink(SCREEN) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError(f"{SCREEN} must be the screen's own folder, mode 0700")
    for folder in (RUN, PROFILE, os.path.join(SCREEN, "cache")):
        mine(folder)
    x11 = os.lstat(X11)
    if os.path.islink(X11) or x11.st_uid != 0 or not x11.st_mode & 0o1000:
        raise RuntimeError(f"{X11} must be root's, with the sticky bit (made at boot)")


def alive(name, comm):
    """The process in RUN/name, if it still runs, is this user's and is `comm`."""
    try:
        with open(os.path.join(RUN, name)) as f:
            pid = int(f.read())
        with open(f"/proc/{pid}/status") as f:
            status = dict(line.rstrip("\n").split(":\t", 1) for line in f if ":\t" in line)
    except (OSError, ValueError):
        return None
    if status.get("Name") != comm[:15] or status.get("Uid", "").split()[0] != str(os.getuid()) or status.get("State", "").startswith("Z"):
        return None
    return pid


def remember(name, value):
    with open(os.path.join(RUN, name + ".tmp"), "w") as f:
        f.write(str(value))
    os.rename(os.path.join(RUN, name + ".tmp"), os.path.join(RUN, name))


def xauth():
    """A cookie for X, wildcard address and display (libXau's format): only who reads it gets in."""
    cookie = secrets.token_bytes(16)

    def field(data):
        return struct.pack(">H", len(data)) + data

    entry = struct.pack(">H", 0xFFFF) + field(b"") + field(b"") + field(b"MIT-MAGIC-COOKIE-1") + field(cookie)
    path = os.path.join(RUN, "xauth")
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(entry)
    os.rename(path + ".tmp", path)


def detached(argv, extra_env, pass_fds=()):
    return subprocess.Popen(argv, env=extra_env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, pass_fds=pass_fds, close_fds=True)


def display():
    """Xvfb running, on the display it picked itself (a command cannot take a number ahead of it)."""
    if alive("xvfb.pid", "Xvfb") is not None:
        try:
            with open(os.path.join(RUN, "display")) as f:
                return f.read().strip()
        except OSError:
            pass
    xauth()
    read, write = os.pipe()
    proc = detached(["Xvfb", "-displayfd", str(write), "-screen", "0", f"{WIDTH}x{HEIGHT}x24", "-auth", os.path.join(RUN, "xauth"), "-nolisten", "tcp", "-noreset"], env(""), pass_fds=(write,))
    os.close(write)
    number = b""
    until = time.monotonic() + 15
    os.set_blocking(read, False)
    while time.monotonic() < until and not number.endswith(b"\n"):
        try:
            chunk = os.read(read, 16)
            if chunk == b"":
                break
            number += chunk
        except BlockingIOError:
            time.sleep(0.05)
    os.close(read)
    if not number.strip().isdigit():
        proc.kill()
        raise RuntimeError("Xvfb did not start")
    remember("xvfb.pid", proc.pid)
    remember("display", ":" + number.decode().strip())
    return ":" + number.decode().strip()


def downloads():
    """/work/Downloads, writable by the commands' group: what the browser saves, the commands read."""
    try:
        os.mkdir(DOWNLOADS, 0o2775)
    except FileExistsError:
        return
    except PermissionError as error:
        raise RuntimeError(f"{WORK} is not writable by the screen (its group, 775)") from error
    os.chown(DOWNLOADS, -1, WORK_GID)
    os.chmod(DOWNLOADS, 0o2775)


def browser(here, url=None):
    """Chromium running on the screen; with a url, that url in a new tab of it."""
    running = alive("chromium.pid", "chromium") is not None
    if running and url is None:
        return
    if not running:
        downloads()
        # A profile left locked by a machine that stopped is not in use: Chromium would refuse it.
        for lock in ("SingletonLock", "SingletonSocket", "SingletonCookie"):
            try:
                os.unlink(os.path.join(PROFILE, lock))
            except FileNotFoundError:
                pass
    os.umask(0o022)
    proc = detached(CHROMIUM + ([url] if url is not None else []), env(here))
    if running:
        # The running Chromium takes the url and this one ends.
        proc.wait(timeout=20)
        return
    remember("chromium.pid", proc.pid)
    until = time.monotonic() + 30
    while time.monotonic() < until:
        if xdo(here, ["search", "--onlyvisible", "--class", "chromium"], check=False).returncode == 0:
            return
        time.sleep(0.3)
    raise RuntimeError("Chromium did not show a window")


def xdo(here, args, check=True):
    done = subprocess.run(["xdotool", *args], env=env(here), capture_output=True, text=True, timeout=30)
    if check and done.returncode != 0:
        raise RuntimeError(f"xdotool {args[0]} failed: {done.stderr.strip()[:200]}")
    return done


def screenshot(here, largest):
    resize = [] if largest >= max(WIDTH, HEIGHT) else ["-resize", f"{largest}x{largest}>"]
    done = subprocess.run(["import", "-window", "root", *resize, "png:-"], env=env(here), capture_output=True, timeout=30)
    if done.returncode != 0 or not done.stdout.startswith(b"\x89PNG"):
        raise RuntimeError(f"no screenshot: {done.stderr.decode(errors='replace').strip()[:200]}")
    return done.stdout


def integer(args, name, low, high, default=None):
    value = args.get(name, default)
    if not (isinstance(value, int) and not isinstance(value, bool) and low <= value <= high):
        raise Refused(f"{name} va da {low} a {high}")
    return value


def choice(table, value):
    """The entry for a name the model gave, or None: a name that is not a string is no name."""
    return table.get(value) if isinstance(value, str) else None


def key_name(value):
    if not (isinstance(value, str) and 1 <= len(value) <= 30 and all(c.isalnum() or c in "_+-.,;'/\\=[]`" for c in value)):
        raise Refused("tasto non valido")
    return value


def restart():
    """Chromium and Xvfb ended: the next action starts them again. The profile, with its logins, stays."""
    for name, comm in (("chromium.pid", "chromium"), ("xvfb.pid", "Xvfb")):
        pid = alive(name, comm)
        if pid is None:
            continue
        try:
            os.killpg(pid, 9)
        except (ProcessLookupError, PermissionError):
            os.kill(pid, 9)
    return {"text": ""}


def act(tool, args):
    checked()
    # One action at a time: two first actions at once (the live view and a click) would start two Xvfb.
    lock = os.open(os.path.join(RUN, "lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return locked(tool, args)
    finally:
        os.close(lock)


def locked(tool, args):
    if tool == "restart":
        return restart()
    here = display()
    browser(here)
    if tool == "get_desktop_state":
        png = screenshot(here, integer(args, "max_image_dimension", 64, 4000, max(WIDTH, HEIGHT)))
        names = xdo(here, ["search", "--onlyvisible", "--class", "chromium", "getwindowname", "%@"], check=False).stdout.strip()
        return {"text": names, "image": base64.b64encode(png).decode("ascii"), "structured": {"screenshot_original_width": WIDTH, "screenshot_original_height": HEIGHT}}
    if tool == "get_screen_size":
        return {"text": "", "structured": {"width": WIDTH, "height": HEIGHT}}
    if tool == "click":
        x, y = integer(args, "x", 0, WIDTH - 1), integer(args, "y", 0, HEIGHT - 1)
        button = choice(BUTTONS, args.get("button", "left"))
        if button is None:
            raise Refused("button è left, right o middle")
        count = integer(args, "count", 1, 3, 1)
        xdo(here, ["mousemove", "--sync", str(x), str(y), "click", "--repeat", str(count), "--delay", "80", button])
        return {"text": ""}
    if tool == "type_text":
        text = args.get("text")
        if not (isinstance(text, str) and 1 <= len(text) <= 2000):
            raise Refused("text va da 1 a 2000 caratteri")
        xdo(here, ["type", "--clearmodifiers", "--delay", "8", "--", text])
        return {"text": ""}
    if tool == "press_key":
        xdo(here, ["key", "--clearmodifiers", "--", key_name(args.get("key"))])
        return {"text": ""}
    if tool == "hotkey":
        keys = args.get("keys")
        if not (isinstance(keys, list) and 2 <= len(keys) <= 4 and all(isinstance(k, str) and k in MODIFIERS for k in keys[:-1])):
            raise Refused("keys sono dei modificatori (ctrl, alt, shift, super) e un tasto")
        xdo(here, ["key", "--clearmodifiers", "--", "+".join([*keys[:-1], key_name(keys[-1])])])
        return {"text": ""}
    if tool == "scroll":
        wheel = choice(WHEEL, args.get("direction"))
        if wheel is None:
            raise Refused("direction è up, down, left o right")
        amount = integer(args, "amount", 1, 50, 5)
        move = ["mousemove", "--sync", str(integer(args, "x", 0, WIDTH - 1)), str(integer(args, "y", 0, HEIGHT - 1))] if "x" in args or "y" in args else []
        xdo(here, [*move, "click", "--repeat", str(amount), "--delay", "30", wheel])
        return {"text": ""}
    if tool == "drag":
        fx, fy = integer(args, "from_x", 0, WIDTH - 1), integer(args, "from_y", 0, HEIGHT - 1)
        tx, ty = integer(args, "to_x", 0, WIDTH - 1), integer(args, "to_y", 0, HEIGHT - 1)
        xdo(here, ["mousemove", "--sync", str(fx), str(fy), "mousedown", "1", "sleep", "0.1", "mousemove", "--sync", str((fx + tx) // 2), str((fy + ty) // 2), "sleep", "0.1", "mousemove", "--sync", str(tx), str(ty), "sleep", "0.1", "mouseup", "1"])
        return {"text": ""}
    if tool == "launch_app":
        urls = args.get("urls")
        if urls is not None:
            if not (isinstance(urls, list) and len(urls) == 1 and isinstance(urls[0], str) and urls[0][:8].lower().startswith(("http://", "https://")) and len(urls[0]) <= 2000 and not any(c.isspace() for c in urls[0])):
                raise Refused("urls è un indirizzo http o https")
            browser(here, urls[0])
            return {"text": ""}
        name = str(args.get("name", "")).strip().lower()
        if name not in BROWSERS:
            raise Refused("su questo schermo c'è solo il browser (Chromium): per file, dati e programmi usa computer_run, nello stesso computer")
        return {"text": ""}
    raise Refused(f"lo schermo non ha lo strumento {tool}")


def main(argv):
    try:
        request = json.loads(argv[1]) if len(argv) == 2 else None
        if not (isinstance(request, dict) and isinstance(request.get("tool"), str) and isinstance(request.get("args", {}), dict)):
            raise Refused("richiesta non valida")
        answer = act(request["tool"], request.get("args", {}))
    except Refused as refused:
        sys.stderr.write(str(refused))
        sys.exit(3)
    except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
        sys.stderr.write(f"{type(error).__name__}: {error}")
        sys.exit(1)
    sys.stdout.write(json.dumps(answer))
    sys.stdout.flush()


if __name__ == "__main__":
    main(sys.argv)
