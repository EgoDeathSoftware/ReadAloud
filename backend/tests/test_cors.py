import pytest
from fastapi.testclient import TestClient

from readaloud.config import allowed_origins, settings
from readaloud.main import create_app


def _client(monkeypatch, origins: str) -> TestClient:
    monkeypatch.setattr(settings, "ALLOWED_ORIGINS", origins)
    return TestClient(create_app())


def _allow_origin(client: TestClient, origin: str) -> str | None:
    response = client.get("/api/settings", headers={"Origin": origin})
    assert response.status_code == 200
    return response.headers.get("access-control-allow-origin")


@pytest.mark.parametrize(
    "origin",
    [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8000",
        "http://127.0.0.1:8000",
    ],
)
def test_local_dev_origins_are_allowed_by_default(monkeypatch, origin):
    client = _client(monkeypatch, "")
    assert _allow_origin(client, origin) == origin


@pytest.mark.parametrize(
    "origin",
    [
        "https://evil.example",
        "http://evil.example",
        "http://localhost.evil.example",
        "null",
    ],
)
def test_unknown_origins_are_rejected(monkeypatch, origin):
    client = _client(monkeypatch, "")
    assert _allow_origin(client, origin) is None


def test_wildcard_is_never_returned(monkeypatch):
    client = _client(monkeypatch, "")
    assert _allow_origin(client, "https://evil.example") != "*"
    assert _allow_origin(client, "http://localhost:5173") != "*"


def test_configured_origins_are_allowed(monkeypatch):
    client = _client(monkeypatch, "https://readaloud.example, https://reader.example")
    assert _allow_origin(client, "https://readaloud.example") == "https://readaloud.example"
    assert _allow_origin(client, "https://reader.example") == "https://reader.example"


def test_configuring_origins_replaces_the_defaults(monkeypatch):
    client = _client(monkeypatch, "https://readaloud.example")
    assert _allow_origin(client, "http://localhost:5173") is None


def test_browser_extension_origins_are_allowed(monkeypatch):
    """The extension is a first-class client and MV2 host permissions already bypass CORS."""
    client = _client(monkeypatch, "")
    for origin in (
        "moz-extension://4d1f2e9a-0000-4000-8000-abcdefabcdef",
        "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    ):
        assert _allow_origin(client, origin) == origin


def test_extension_regex_does_not_match_lookalike_origins(monkeypatch):
    client = _client(monkeypatch, "")
    assert _allow_origin(client, "https://moz-extension.evil.example") is None
    assert _allow_origin(client, "https://evil.example/moz-extension://x") is None


def test_allowed_origins_parses_and_trims_a_comma_separated_list(monkeypatch):
    monkeypatch.setattr(settings, "ALLOWED_ORIGINS", " https://a.example ,https://b.example,, ")
    assert allowed_origins() == ["https://a.example", "https://b.example"]


def test_allowed_origins_falls_back_to_defaults_when_unset(monkeypatch):
    monkeypatch.setattr(settings, "ALLOWED_ORIGINS", "")
    assert "http://localhost:5173" in allowed_origins()
    assert "*" not in allowed_origins()
