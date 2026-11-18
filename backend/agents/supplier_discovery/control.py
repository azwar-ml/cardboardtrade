"""Per-job cancellation propagated into crawler worker threads."""
import contextvars
import socket
import threading


class JobCancelled(Exception):
    pass


class Control:
    def __init__(self):
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.sockets = set()

    def check(self):
        if self.stopped.is_set():
            raise JobCancelled('Research cancelled by Admin')

    def attach(self, sock):
        with self.lock:
            self.check()
            self.sockets.add(sock)

    def detach(self, sock):
        with self.lock:
            self.sockets.discard(sock)

    def cancel(self):
        with self.lock:
            self.stopped.set()
            for sock in self.sockets:
                try:
                    sock.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                sock.close()


current = contextvars.ContextVar('discovery_control', default=None)


def check():
    control = current.get()
    if control:
        control.check()
