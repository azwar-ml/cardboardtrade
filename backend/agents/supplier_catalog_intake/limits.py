"""Bound catalog request bodies before multipart parsing, including chunked uploads."""
from fastapi.responses import JSONResponse
from .storage import connection


class CatalogBodyLimit:
    def __init__(self, app): self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        if scope['type'] != 'http' or not path.startswith('/api/v1/catalog/') or scope.get('method') == 'GET':
            return await self.app(scope, receive, send)
        cap = 256 * 1024
        if path == '/api/v1/catalog/imports':
            with connection() as conn:
                row = conn.execute('SELECT max_file_mb FROM catalog_controls WHERE id=1').fetchone()
            cap = row[0] * 1024 * 1024 + 128 * 1024
        parts, size = [], 0
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect': return
            piece = message.get('body', b'')
            size += len(piece)
            if size > cap:
                return await JSONResponse({'detail': 'Catalog request exceeds configured size limit'}, status_code=413)(scope, receive, send)
            parts.append(piece)
            if not message.get('more_body', False): break
        delivered = False
        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': b''.join(parts), 'more_body': False}
            return await receive()
        await self.app(scope, bounded_receive, send)
