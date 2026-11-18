"""Pinned public DNS connections. Redirects, robots requests and pages use the same guard."""
import asyncio
import http.client
import ipaddress
import socket
import ssl
from urllib.parse import urlsplit, urljoin, urlunsplit
from urllib.robotparser import RobotFileParser
from .control import current, check

USER_AGENT = 'CardboardSupplierDiscovery/1.0'
MAX_BYTES = 2 * 1024 * 1024


class UnsafeURL(ValueError):
    pass


def resolve_public(url):
    check()
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
        raise UnsafeURL('Only public HTTP(S) URLs without credentials are permitted')
    if parsed.port not in (None, 80 if parsed.scheme == 'http' else 443):
        raise UnsafeURL('Nonstandard ports are not permitted')
    addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80), type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise UnsafeURL('Private, reserved, loopback or mixed public/private DNS is blocked')
    return parsed, addresses[0][4][0]


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, hostname, ip):
        super().__init__(hostname, timeout=15, context=ssl.create_default_context())
        self.ip = ip

    def connect(self):
        raw = socket.create_connection((self.ip, 443), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except BaseException:
            raw.close()
            raise


def fetch(url, redirects=3):
    for _ in range(redirects + 1):
        check()
        parsed, ip = resolve_public(url)
        conn = PinnedHTTPS(parsed.hostname, ip) if parsed.scheme == 'https' else http.client.HTTPConnection(ip, timeout=15)
        control, sock = current.get(), None
        try:
            check()
            conn.connect()
            sock = conn.sock
            if control:
                control.attach(sock)
            target = urlunsplit(('', '', parsed.path or '/', parsed.query, ''))
            conn.request('GET', target, headers={'Host': parsed.hostname, 'User-Agent': USER_AGENT, 'Accept': 'text/html,text/plain', 'Accept-Encoding': 'identity'})
            response = conn.getresponse()
            if response.status in (301, 302, 303, 307, 308):
                url = urljoin(url, response.getheader('Location', ''))
                if redirects == 0:
                    return response.status, '', url, ''
                continue
            data = response.read(MAX_BYTES + 1)
            if len(data) > MAX_BYTES:
                raise ValueError('Response exceeds 2 MB limit')
            return response.status, data.decode('utf-8', errors='replace'), url, response.getheader('Content-Type', '')
        finally:
            if control and sock:
                control.detach(sock)
            conn.close()
    raise ValueError('Too many redirects')


async def permitted_page(url, allowed_hosts, robots_cache, depth=0):
    if depth > 3:
        raise ValueError('Too many redirects')
    parsed, _ = await asyncio.to_thread(resolve_public, url)
    host = parsed.hostname.lower().removeprefix('www.')
    if allowed_hosts is not None and host not in allowed_hosts:
        raise UnsafeURL('Host is not in the configured permitted-source allowlist')
    origin = f'{parsed.scheme}://{parsed.netloc}'
    if origin not in robots_cache:
        code, body, _, _ = await asyncio.to_thread(fetch, origin + '/robots.txt')
        if code == 404:
            body = 'User-agent: *\nAllow: /'
        elif code != 200:
            raise UnsafeURL(f'Cannot establish robots permission (HTTP {code})')
        robot = RobotFileParser()
        robot.parse(body.splitlines())
        robots_cache[origin] = robot
    robot = robots_cache[origin]
    if not robot.can_fetch(USER_AGENT, url):
        raise UnsafeURL('Disallowed by robots.txt')
    rate = robot.request_rate(USER_AGENT) or robot.request_rate('*')
    delay = max(1.0, float(robot.crawl_delay(USER_AGENT) or robot.crawl_delay('*') or 1), (rate.seconds / rate.requests) if rate else 0)
    if delay > 60:
        raise UnsafeURL('Robots rate limit exceeds the research time budget')
    await asyncio.sleep(delay)
    # Do not follow page redirects without checking destination permission and robots.
    code, body, final, content_type = await asyncio.to_thread(fetch, url, 0)
    if code in (301, 302, 303, 307, 308):
        return await permitted_page(final, allowed_hosts, robots_cache, depth + 1)
    if code in (401, 403, 429):
        raise UnsafeURL(f'Access restricted or rate limited (HTTP {code})')
    if code != 200:
        raise ValueError(f'HTTP {code}')
    if 'html' not in content_type.lower():
        raise ValueError('Only HTML supplier pages are supported')
    return body, final
