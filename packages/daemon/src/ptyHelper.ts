// The PTY helper (spec/02 § Terminal sessions — PTY sessions).
//
// A real pseudo-terminal needs `openpty` plus a controlling-terminal handoff,
// which Node cannot do without a native module (node-pty) — and the host
// ships no native module for its terminal. Python's standard library can, and
// python3 is on every host the host runs on (the Linux box and the Mac). So
// a PTY session is this small script, run as
// `python3 -c <script> <cols> <rows> <shell>`, relaying bytes:
//
//   fd 0 (from the host)  -> the PTY master (keystrokes)
//   the PTY master          -> fd 1 (to the host; raw terminal output)
//   fd 3 (from the host)  -> "<cols> <rows>\n" lines: set the window size,
//                              which is what sends the program its SIGWINCH
//
// It exits with the shell's own status once the terminal closes. Anything it
// writes to fd 2 is a helper failure and is surfaced as stderr, never hidden.
//
// The shell starts as a LOGIN shell: a phone's terminal is a remote login, like
// ssh, and a login shell reads the profile that puts the user's own tools (nvm,
// ~/.local/bin, Homebrew) on PATH.

export const PTY_HELPER_SOURCE = String.raw`
import os, sys, select, fcntl, termios, struct, signal

cols, rows, shell = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]

def winsize(fd, c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))

master, slave = os.openpty()
winsize(slave, cols, rows)
pid = os.fork()
if pid == 0:
    os.close(master)
    os.close(3)
    os.setsid()
    fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
    for fd in (0, 1, 2):
        os.dup2(slave, fd)
    if slave > 2:
        os.close(slave)
    os.execvp(shell, [shell, '-l'])

os.close(slave)

def hangup():
    try:
        os.killpg(pid, signal.SIGHUP)
    except OSError:
        pass

def on_term(*_):
    hangup()
    sys.exit(143)

signal.signal(signal.SIGTERM, on_term)

def write_all(fd, data):
    while data:
        n = os.write(fd, data)
        data = data[n:]

watch = [0, master, 3]
pending = b''
while True:
    ready, _, _ = select.select(watch, [], [])
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b''
        if not data:
            break
        write_all(1, data)
    if 0 in ready:
        data = os.read(0, 65536)
        if data:
            write_all(master, data)
        else:
            watch.remove(0)
            hangup()
    if 3 in ready:
        data = os.read(3, 1024)
        if not data:
            watch.remove(3)
        else:
            pending += data
            while b'\n' in pending:
                line, pending = pending.split(b'\n', 1)
                c, r = line.split()
                winsize(master, int(c), int(r))

_, status = os.waitpid(pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
`;
