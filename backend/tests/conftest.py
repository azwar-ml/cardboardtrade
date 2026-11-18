"""No regression test is allowed to spend real provider credits."""
import pytest
import httpx


@pytest.fixture(autouse=True)
def forbid_live_provider(monkeypatch):
    monkeypatch.setenv('SERPAPI_API_KEY', '')
    monkeypatch.setattr('agents.supplier_discovery.providers.dotenv_values', lambda path: {})
    monkeypatch.setattr('agents.supplier_qualification.gemini.settings', lambda: {})
    original_async, original_sync = httpx.AsyncClient.send, httpx.Client.send

    def check(client, request):
        host = request.url.host or ''
        if (host == 'api.resend.com' or host == 'serpapi.com' or host.endswith('.serpapi.com') or host.endswith('googleapis.com')) and not isinstance(client._transport, httpx.MockTransport):
            raise AssertionError('Live provider HTTP is forbidden in automated regression tests')

    async def async_send(client, request, **kwargs):
        check(client, request)
        return await original_async(client, request, **kwargs)

    def sync_send(client, request, **kwargs):
        check(client, request)
        return original_sync(client, request, **kwargs)

    monkeypatch.setattr(httpx.AsyncClient, 'send', async_send)
    monkeypatch.setattr(httpx.Client, 'send', sync_send)
