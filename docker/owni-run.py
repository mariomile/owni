#!/usr/bin/python3 -I
"""
The computer's runner on a micro-VM (ADR 0015). The provider reaches the machine only through
Fly's exec API, which answers within 60 seconds and takes its input as a string: so a command
starts here in the background and is waited for in slices, and files go in and out in pieces.

  start ID TIMEOUT_S FULL   the command on stdin; runs as uid 1000 in /work, in the background
  wait ID SECONDS           its result, as soon as it is there or after SECONDS: {"done": false}
  kill ID                   ends the command and everything of uid 1000
  write PATH OFFSET         base64 on stdin, written at OFFSET of /work/PATH (0 starts the file)
  stat PATH                 {"kind": "file" | "dir" | "link" | "other" | "missing", "size": n}
  read PATH OFFSET LENGTH   base64 of up to LENGTH bytes from OFFSET
  idle SECONDS              the machine's first process: returns (and the machine stops) after
                            SECONDS with no call and no command running
  egress apply nft|legacy   as root: only the public internet out (below), then checked
  egress check              exit 0 only if those rules are the ones in place
  egress rules              the rules for this /etc/resolv.conf, as JSON (for tests)
  guard nft|legacy          the Docker computer's first process: egress apply, `ready`, then idles
  screen JSON               on a machine, as root: the screen's action (owni-screen) as uid 1001

Run as root it drops to uid 1000 for everything that touches /work, and walks /work without
following links. A command starts only once the machine's first process has closed Fly's API
inside it and put the egress rules in place: the file `ready`, written by owni-fly-init. The
machine reaches the internet (ADR 0124), not the network around it: on a machine ("machine" in
`ready`) the rules are checked again before each command, and a command gets no vsock socket,
which talks to the host, no packet socket, which ordinary internet use never needs, no io_uring
and no user namespace (no_side_sockets).

The egress rules are the same for both providers: out to anything but loopback, link-local
(the cloud's metadata endpoint, 169.254.169.254, hands out the host's credentials), private and
CGNAT ranges (Alibaba's metadata is 100.100.100.200), Azure's host endpoint 168.63.129.16, "this
network", benchmarking, documentation, multicast and reserved addresses, IPv6 unique-local (Fly's
private network, AWS's metadata at fd00:ec2::254), site-local, and the IPv6 prefixes that wrap an
IPv4 address (NAT64, 6to4, Teredo). IPv6 Neighbor Discovery stays allowed on the link. A resolver in /etc/resolv.conf at one of those addresses (Fly's fdaa::3, a cloud's
VPC resolver) stays reachable on port 53 only. TCP is refused with a reset, which gVisor handles
(its ICMP reject can hang a connect); the rest is dropped.
"""
import base64
import binascii
import ctypes
import ipaddress
import json
import os
import resource
import selectors
import shutil
import signal
import stat as st
import subprocess
import sys
import time

STATE = os.environ.get("OWNI_RUN_STATE", "/run/owni")
WORK = os.environ.get("OWNI_RUN_WORK", "/work")
# Tests run as root on a shared host give an unused uid: sweeping it ends nobody else's processes.
UID = int(os.environ.get("OWNI_RUN_UID", "1000"))
# The screen (ADR 0135): another user, so the sweep after a command leaves it, in the commands' group for the downloads.
SCREEN_UID = 1001
SCREEN = "/usr/local/bin/owni-screen"
# As a normal user (tests) there is nothing to drop, and nothing broad to kill.
ROOT = os.getuid() == 0
MAX_STREAM = 64 * 1024
MAX_FILE = 1024 * 1024 * 1024
FULL_FILE = 2048 * 512
MAX_READ = 4 * 1024 * 1024
MAX_PROCESSES = 128
# As the image's ENV (docker/computer.Dockerfile): pip install goes to /work/.local.
ENV = {"HOME": "/tmp", "MPLCONFIGDIR": "/tmp", "MPLBACKEND": "Agg", "LANG": "C.UTF-8", "PYTHONUSERBASE": WORK + "/.local", "PATH": WORK + "/.local/bin:/usr/local/bin:/usr/bin:/bin"}
AF_PACKET, AF_VSOCK = 17, 40
CLONE_NEWUSER = 0x10000000
RESOLV = os.environ.get("OWNI_RUN_RESOLV", "/etc/resolv.conf")
DENY = "OWNI-DENY"
DENIED = {
    "iptables": [
        "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "168.63.129.16/32", "169.254.0.0/16", "172.16.0.0/12",
        "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
        "224.0.0.0/4", "240.0.0.0/4",
    ],
    # NAT64, 6to4 and Teredo carry an IPv4 address inside an IPv6 one: a way around the IPv4 list.
    "ip6tables": ["64:ff9b::/96", "64:ff9b:1::/48", "2001::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8"],
}
# IPv6 needs Neighbor Discovery (router and neighbor solicitations and advertisements) and the
# errors that go with it, link-local and to the link's multicast only; without it a machine
# loses its neighbors, and Fly's resolver with them, when the cache expires.
NDP_TYPES = (1, 2, 3, 4, 133, 134, 135, 136)
NDP_TO = ("fe80::/10", "ff02::/16")
BACKENDS = ("nft", "legacy")


class Refused(Exception):
    """Something the provider says back as it is (a bad path, a missing file)."""


def out(value):
    sys.stdout.write(json.dumps(value, ensure_ascii=False))
    sys.stdout.flush()


def fail(message):
    sys.stderr.write(message)
    sys.exit(2)


def job(name):
    if not (8 <= len(name) <= 40 and all(c in "0123456789abcdefghijklmnopqrstuvwxyz" for c in name)):
        fail("invalid job id")
    return os.path.join(STATE, name)


def parts_of(path):
    """A path under /work as the provider checked it (core/computer.ts workPath): checked again."""
    parts = [p for p in path.split("/") if p not in ("", ".")]
    if not parts or path.startswith("/") or len(parts) > 16:
        raise Refused("invalid path")
    for p in parts:
        if p == ".." or p.startswith("-") or "\\" in p or any(ord(c) < 32 or ord(c) == 127 for c in p) or len(p.encode()) > 100:
            raise Refused("invalid path")
    return parts


def folder_of(parts, create):
    """The folder holding the last part, opened one part at a time without following any link."""
    fd = os.open(WORK, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            try:
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(part, 0o755, dir_fd=fd)
                nxt = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            except OSError as error:
                # A link (ELOOP) or a file (ENOTDIR) where a folder should be.
                raise Refused("not a file") from error
            os.close(fd)
            fd = nxt
        return fd
    except BaseException:
        os.close(fd)
        raise


def touch():
    """Every call keeps the machine up (see idle)."""
    os.makedirs(STATE, mode=0o700, exist_ok=True)
    with open(os.path.join(STATE, "last"), "a"):
        pass
    os.utime(os.path.join(STATE, "last"))


def on_machine():
    """A real machine: owni-fly-init wrote "machine" in `ready`."""
    try:
        with open(os.path.join(STATE, "ready")) as f:
            return f.read().strip() == "machine"
    except FileNotFoundError:
        return False


def no_new_privs():
    if ctypes.CDLL(None, use_errno=True).prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
        raise OSError(ctypes.get_errno(), "no_new_privs refused")


def oom_score(value):
    """Who the kernel ends first when memory runs out: the command, never the runner."""
    try:
        with open("/proc/self/oom_score_adj", "w") as f:
            f.write(str(value))
    except OSError:
        pass


def drop():
    """Become uid 1000 for good: what a command could do to /work, and no more."""
    if not ROOT:
        return
    os.setgroups([])
    os.setgid(UID)
    os.setuid(UID)
    no_new_privs()


def no_side_sockets():
    """
    No vsock (it talks to the host, not the internet) and no raw packets (spoofing and sniffing,
    never needed to use the internet). No io_uring either: its own socket and connect operations
    would open those sockets past this filter. And no user namespaces, the way into most of the
    kernel's attack surface (nf_tables among it), whose bugs would let a command take the egress
    rules or Fly's API: clone3 says ENOSYS, its flags being out of a filter's reach, and libc
    falls back to clone, where CLONE_NEWUSER is refused.
    """
    import seccomp  # python3-seccomp, in the fly image

    f = seccomp.SyscallFilter(defaction=seccomp.ALLOW)
    for family in (AF_VSOCK, AF_PACKET):
        f.add_rule(seccomp.ERRNO(97), "socket", seccomp.Arg(0, seccomp.EQ, family))  # EAFNOSUPPORT
    for call in ("io_uring_setup", "io_uring_enter", "io_uring_register"):
        f.add_rule(seccomp.ERRNO(1), call)  # EPERM
    for call in ("unshare", "clone"):
        f.add_rule(seccomp.ERRNO(1), call, seccomp.Arg(0, seccomp.MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER))
    f.add_rule(seccomp.ERRNO(38), "clone3")  # ENOSYS
    f.load()


def sweep(group):
    """Everything of uid 1000 ends (kill -9 -1 as that user); as a normal user, the command's group only."""
    if not ROOT:
        try:
            os.killpg(group, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
        return
    pid = os.fork()
    if pid == 0:
        try:
            os.setgroups([])
            os.setgid(UID)
            os.setuid(UID)
            os.kill(-1, signal.SIGKILL)
        except OSError:
            pass
        os._exit(0)
    os.waitpid(pid, 0)


def disk_kb():
    total = 0
    device = os.lstat(WORK).st_dev
    for folder, dirs, files in os.walk(WORK, onerror=lambda e: None):
        for name in dirs + files:
            try:
                info = os.lstat(os.path.join(folder, name))
            except OSError:
                continue
            if info.st_dev == device:
                total += info.st_blocks * 512
        dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(folder, d))]
    return total // 1024


def nameservers():
    found = []
    try:
        with open(RESOLV) as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and parts[0] == "nameserver":
                    try:
                        found.append(ipaddress.ip_address(parts[1].split("%")[0]))
                    except ValueError:
                        pass
    except FileNotFoundError:
        pass
    return found


def egress_rules(servers):
    """Per table, the OUTPUT chain and the deny chain exactly as `iptables -S CHAIN` prints them."""
    rules = {}
    for table, denied in DENIED.items():
        version = 4 if table == "iptables" else 6
        nets = [ipaddress.ip_network(n) for n in denied]
        output = ["-P OUTPUT ACCEPT", "-A OUTPUT -o lo -j ACCEPT"]
        for server in servers:
            if server.version == version and any(server in net for net in nets):
                for proto in ("udp", "tcp"):
                    output.append(f"-A OUTPUT -d {server}/{server.max_prefixlen} -p {proto} -m {proto} --dport 53 -j ACCEPT")
        if version == 6:
            output += [f"-A OUTPUT -d {net} -p ipv6-icmp -m icmp6 --icmpv6-type {kind} -j ACCEPT" for net in NDP_TO for kind in NDP_TYPES]
        output +=[f"-A OUTPUT -d {net} -j {DENY}" for net in denied]
        deny = [f"-N {DENY}", f"-A {DENY} -p tcp -j REJECT --reject-with tcp-reset", f"-A {DENY} -j DROP"]
        rules[table] = {"OUTPUT": output, DENY: deny}
    return rules


def restore_input(chains):
    """The filter table for iptables-restore, applied in one step."""
    lines = ["*filter", ":INPUT ACCEPT [0:0]", ":FORWARD ACCEPT [0:0]", ":OUTPUT ACCEPT [0:0]", f":{DENY} - [0:0]"]
    lines += [rule for rule in chains["OUTPUT"] + chains[DENY] if rule.startswith("-A ")]
    return "\n".join(lines + ["COMMIT"]) + "\n"


def egress_apply(backend):
    if backend not in BACKENDS:
        fail("usage: owni-run egress apply nft|legacy")
    for table, chains in egress_rules(nameservers()).items():
        done = subprocess.run([f"/usr/sbin/{table}-{backend}-restore"], input=restore_input(chains), capture_output=True, text=True, timeout=30)
        if done.returncode != 0:
            fail(f"egress: {table}-{backend}-restore failed: {done.stderr.strip()[-500:]}")
    with open(os.path.join(STATE, "egress"), "w") as f:
        f.write(backend)
    if not egress_holds():
        fail("egress: the rules in place are not the ones applied")


def egress_holds():
    """The egress rules still the ones in place, with the backend that applied them."""
    try:
        with open(os.path.join(STATE, "egress")) as f:
            backend = f.read().strip()
    except FileNotFoundError:
        return False
    if backend not in BACKENDS:
        return False
    for table, chains in egress_rules(nameservers()).items():
        for chain, expected in chains.items():
            try:
                shown = subprocess.run([f"/usr/sbin/{table}-{backend}", "-S", chain], capture_output=True, text=True, timeout=10)
            except (OSError, subprocess.TimeoutExpired):
                return False
            if shown.returncode != 0 or shown.stdout.splitlines() != expected:
                return False
    return True


def x11_dir():
    """X's socket folder, root's with the sticky bit: no command can put its own socket where the screen's goes."""
    try:
        os.mkdir("/tmp/.X11-unix", 0o1777)
    except FileExistsError:
        pass
    os.chmod("/tmp/.X11-unix", 0o1777)


def guard(backend):
    """The Docker computer's first process, as root with only NET_ADMIN: the rules, X's folder, `ready`, then nothing."""
    egress_apply(backend)
    x11_dir()
    with open(os.path.join(STATE, "ready"), "w") as f:
        f.write("container")
    while True:
        signal.pause()


def supervised(here):
    """A command still under way: no result yet, and its supervisor alive."""
    if os.path.exists(os.path.join(here, "result.json")):
        return False
    try:
        with open(os.path.join(here, "pid")) as f:
            os.kill(int(f.read()), 0)
        return True
    except (OSError, ValueError):
        # Just started (no pid yet) counts as running; a dead supervisor does not.
        return not os.path.exists(os.path.join(here, "pid"))


def jobs():
    return [os.path.join(STATE, d) for d in os.listdir(STATE) if os.path.isdir(os.path.join(STATE, d))]


def start(name, timeout_s, full):
    if not os.path.exists(os.path.join(STATE, "ready")):
        fail("not ready: the machine's first process has not closed Fly's API and set the egress rules yet")
    if on_machine() and not egress_holds():
        fail("not ready: the egress rules are not in place")
    command = sys.stdin.read()
    here = job(name)
    # A command of before still running (its kill lost) is ended first: its last sweep would end this one.
    others = [d for d in jobs() if supervised(d)]
    for other in others:
        with open(os.path.join(other, "kill"), "w"):
            pass
    if others:
        sweep(0)
        until = time.monotonic() + 10
        while any(supervised(d) for d in others) and time.monotonic() < until:
            time.sleep(0.1)
        if any(supervised(d) for d in others):
            fail("busy: a command of before does not end")
    # Results nobody came back for are cleared after an hour.
    for old in jobs():
        if os.path.exists(os.path.join(old, "result.json")) and time.time() - os.path.getmtime(old) > 3600:
            shutil.rmtree(old, ignore_errors=True)
    os.mkdir(here, 0o700)
    if os.fork() > 0:
        out({"started": True})
        return
    # The supervisor: away from the exec that started it, so the exec can answer now.
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    null = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(null, fd)
    try:
        supervise(here, command, timeout_s, full)
    finally:
        os._exit(0)


def supervise(here, command, timeout_s, full):
    oom_score(-1000)
    machine = on_machine()

    def limits():
        size = FULL_FILE if full else MAX_FILE
        resource.setrlimit(resource.RLIMIT_FSIZE, (size, size))
        oom_score(1000)
        if ROOT:
            resource.setrlimit(resource.RLIMIT_NPROC, (MAX_PROCESSES, MAX_PROCESSES))
        if machine:
            no_side_sockets()
        drop()

    with open(os.path.join(here, "pid"), "w") as f:
        f.write(str(os.getpid()))
    started = time.monotonic()
    try:
        proc = subprocess.Popen(["sh", "-c", command], cwd=WORK, env=ENV, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, preexec_fn=limits, start_new_session=True)
    except (OSError, subprocess.SubprocessError) as error:
        return finish(here, {"done": True, "exitCode": 126, "stdout": "", "stderr": f"the command did not start: {error}", "truncated": False, "timedOut": False, "killed": False, "ms": 0, "diskKb": disk_kb()})
    stdout, stderr = bytearray(), bytearray()
    truncated = False
    timed_out = False
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ, "out")
    sel.register(proc.stderr, selectors.EVENT_READ, "err")

    def take(until):
        nonlocal truncated
        while sel.get_map() and time.monotonic() < until:
            for key, _ in sel.select(timeout=0.2):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    sel.unregister(key.fileobj)
                    continue
                if key.data == "out":
                    # The start of stdout; the rest is read and dropped.
                    room = MAX_STREAM - len(stdout)
                    if len(chunk) > room:
                        truncated = True
                    stdout.extend(chunk[: max(0, room)])
                else:
                    # The end of stderr, where the error is.
                    stderr.extend(chunk)
                    if len(stderr) > MAX_STREAM:
                        truncated = True
                        del stderr[: len(stderr) - MAX_STREAM]
            if proc.poll() is not None or os.path.exists(os.path.join(here, "kill")):
                return
            if time.monotonic() - started >= timeout_s:
                return

    deadline = started + timeout_s
    while proc.poll() is None:
        take(deadline)
        if os.path.exists(os.path.join(here, "kill")):
            break
        if time.monotonic() >= deadline and proc.poll() is None:
            timed_out = True
            break
        if not sel.get_map():
            time.sleep(0.05)
    # Whatever the command left behind ends with it; then what is left in the pipes is read.
    sweep(proc.pid)
    proc.wait()
    take(time.monotonic() + 2)
    code = proc.returncode
    code = 128 - code if code < 0 else code
    cut = os.path.exists(os.path.join(here, "kill"))
    finish(here, {
        "done": True,
        "exitCode": None if cut else code,
        "stdout": stdout.decode("utf-8", "replace"),
        "stderr": stderr.decode("utf-8", "replace"),
        "truncated": truncated,
        "timedOut": timed_out or cut,
        "killed": not timed_out and not cut and code == 137,
        "ms": int((time.monotonic() - started) * 1000),
        "diskKb": disk_kb(),
    })


def finish(here, result):
    with open(os.path.join(here, "result.tmp"), "w") as f:
        json.dump(result, f, ensure_ascii=False)
    os.rename(os.path.join(here, "result.tmp"), os.path.join(here, "result.json"))


def wait(name, seconds):
    here = job(name)
    until = time.monotonic() + seconds
    while True:
        try:
            with open(os.path.join(here, "result.json")) as f:
                sys.stdout.write(f.read())
            return
        except FileNotFoundError:
            pass
        if not os.path.isdir(here) or not supervised(here):
            # Gone, or its supervisor died without a result (the machine ran out of memory).
            if not os.path.exists(os.path.join(here, "result.json")):
                return out({"done": False, "missing": True})
            continue
        if time.monotonic() >= until:
            return out({"done": False})
        time.sleep(0.2)


def kill(name):
    here = job(name)
    if os.path.isdir(here):
        with open(os.path.join(here, "kill"), "w"):
            pass
    if ROOT:
        sweep(0)
    out({"ok": True})


def write(path, offset):
    try:
        data = base64.b64decode(sys.stdin.read().strip(), validate=True)
    except binascii.Error:
        fail("invalid data")
    drop()
    parts = parts_of(path)
    folder = folder_of(parts, create=True)
    try:
        flags = os.O_WRONLY | os.O_NOFOLLOW | (os.O_CREAT | os.O_TRUNC if offset == 0 else 0)
        fd = os.open(parts[-1], flags, 0o644, dir_fd=folder)
    finally:
        os.close(folder)
    try:
        if not st.S_ISREG(os.fstat(fd).st_mode):
            raise Refused("not a file")
        if os.fstat(fd).st_size != offset:
            fail("out of order")
        os.lseek(fd, offset, os.SEEK_SET)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
    finally:
        os.close(fd)
    out({"ok": True})


def stat(path):
    drop()
    parts = parts_of(path)
    try:
        folder = folder_of(parts, create=False)
    except FileNotFoundError:
        return out({"kind": "missing", "size": 0})
    try:
        info = os.lstat(parts[-1], dir_fd=folder)
    except FileNotFoundError:
        return out({"kind": "missing", "size": 0})
    finally:
        os.close(folder)
    kind = "file" if st.S_ISREG(info.st_mode) else "dir" if st.S_ISDIR(info.st_mode) else "link" if st.S_ISLNK(info.st_mode) else "other"
    out({"kind": kind, "size": info.st_size})


def read(path, offset, length):
    drop()
    parts = parts_of(path)
    folder = folder_of(parts, create=False)
    try:
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW, dir_fd=folder)
    finally:
        os.close(folder)
    try:
        if not st.S_ISREG(os.fstat(fd).st_mode):
            raise Refused("not a file")
        os.lseek(fd, offset, os.SEEK_SET)
        sys.stdout.write(base64.b64encode(os.read(fd, min(length, MAX_READ))).decode("ascii"))
    finally:
        os.close(fd)


def idle(seconds):
    oom_score(-1000)
    touch()
    while True:
        time.sleep(min(30, max(1, seconds / 4)))
        running = [d for d in jobs() if supervised(d)]
        if not running and time.time() - os.path.getmtime(os.path.join(STATE, "last")) > seconds:
            return


def screen(request):
    """On a machine: the screen's action as uid 1001, with the commands' filter (no_side_sockets)."""
    # Read as root: /run/owni is closed to 1001.
    machine = on_machine()
    if not os.path.exists(os.path.join(STATE, "ready")) or (machine and not egress_holds()):
        fail("not ready: the egress rules are not in place")
    if ROOT:
        os.setgroups([UID])
        os.setgid(SCREEN_UID)
        os.setuid(SCREEN_UID)
        no_new_privs()
        if machine:
            no_side_sockets()
    os.execve(SCREEN, [SCREEN, request], {"HOME": "/screen", "LANG": "C.UTF-8", "PATH": "/usr/local/bin:/usr/bin:/bin"})


def number(text):
    try:
        return int(text)
    except ValueError:
        fail("invalid number")


def main(argv):
    if len(argv) < 2:
        fail("usage: owni-run start|wait|kill|write|stat|read|idle|egress|guard|screen ...")
    what, args = argv[1], argv[2:]
    # As uid 1000 (stat on Docker, whose root cannot drop to it) there is no idle clock to keep.
    if ROOT:
        touch()
    try:
        if what == "start" and len(args) == 3:
            return start(args[0], max(1, number(args[1])), args[2] == "1")
        if what == "wait" and len(args) == 2:
            return wait(args[0], max(0, min(55, number(args[1]))))
        if what == "kill" and len(args) == 1:
            return kill(args[0])
        if what == "write" and len(args) == 2:
            return write(args[0], number(args[1]))
        if what == "stat" and len(args) == 1:
            return stat(args[0])
        if what == "read" and len(args) == 3:
            return read(args[0], number(args[1]), number(args[2]))
        if what == "idle" and len(args) == 1:
            return idle(number(args[0]))
        if what == "egress" and args[:1] == ["apply"] and len(args) == 2:
            egress_apply(args[1])
            return out({"ok": True})
        if what == "egress" and args == ["check"]:
            return out({"ok": True}) if egress_holds() else fail("egress: the rules are not in place")
        if what == "egress" and args == ["rules"]:
            return out(egress_rules(nameservers()))
        if what == "guard" and len(args) == 1:
            return guard(args[0])
        if what == "screen" and len(args) == 1:
            return screen(args[0])
    except Refused as refused:
        fail(str(refused))
    except OSError as error:
        if error.errno == 40:  # ELOOP: a link where a file or folder was expected
            fail("not a file")
        fail(f"{type(error).__name__}: {error.strerror or error}")
    fail("usage: owni-run start|wait|kill|write|stat|read|idle|egress|guard|screen ...")


if __name__ == "__main__":
    main(sys.argv)
