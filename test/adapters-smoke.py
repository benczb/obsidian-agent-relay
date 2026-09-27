"""Run after npm run build. Uses a temporary board, never the live vault."""
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def request(base, route, token=None, body=None):
    headers = {'Accept': 'application/json, text/event-stream'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    data = None if body is None else json.dumps(body).encode()
    if data is not None:
        headers['Content-Type'] = 'application/json'
    try:
        with urllib.request.urlopen(urllib.request.Request(base + route, data, headers), timeout=3) as response:
            text = response.read().decode()
            if text.startswith('event:'):
                text = next(line[6:] for line in text.splitlines() if line.startswith('data: '))
            return response.status, json.loads(text)
    except urllib.error.HTTPError as error:
        return error.code, None


with tempfile.TemporaryDirectory(prefix='kanban-adapters-') as temp:
    private, rest = free_port(), free_port()
    while rest == private:
        rest = free_port()
    mcp_url, rest_url = f'http://127.0.0.1:{private}', f'http://127.0.0.1:{rest}'
    mcp_token, rest_token = secrets.token_hex(32), secrets.token_hex(32)
    processes = []
    try:
        for entry, port in [('index', private), ('rest-facade', rest)]:
            env = {'PATH': os.environ['PATH'], 'HOST': '127.0.0.1', 'PORT': str(port),
                   'KANBAN_BOARD_PATH': str(Path(temp) / 'board.md'),
                   'MCP_BEARER_TOKEN': mcp_token, 'REST_BEARER_TOKEN': rest_token}
            processes.append(subprocess.Popen(['node', f'dist/src/{entry}.js'], cwd=ROOT,
                                               env=env, stdout=subprocess.DEVNULL))
        for base in [mcp_url, rest_url]:
            for attempt in range(100):
                try:
                    if request(base, '/healthz')[0] == 200:
                        break
                except (OSError, urllib.error.URLError):
                    pass
                time.sleep(0.05)
            else:
                raise AssertionError('service failed to start')
        assert request(rest_url, '/v1/cards')[0] == 401
        assert request(rest_url, '/v1/cards', mcp_token)[0] == 401
        assert request(mcp_url, '/mcp', rest_token, {})[0] == 401

        def mcp(name, arguments):
            status, response = request(mcp_url, '/mcp', mcp_token, {
                'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                'params': {'name': name, 'arguments': arguments}})
            assert status == 200
            result = response['result']
            assert not result.get('isError'), result
            return json.loads(result['content'][0]['text'])

        status, response = request(rest_url, '/v1/cards', rest_token, {
            'title': 'Muse to Hermes', 'from': 'muse', 'to': 'hermes', 'thread': 'smoke'})
        assert status == 201
        card_id = response['card']['id']
        assert mcp('get_task', {'id': card_id})['to'] == 'hermes'
        mcp('claim_task', {'id': card_id, 'agent': 'hermes'})
        assert request(rest_url, f'/v1/cards/{card_id}/claim', rest_token, {'agent': 'hermes'})[0] == 409
        mcp('complete_task', {'id': card_id, 'agent': 'hermes', 'result': 'MCP evidence'})
        status, response = request(rest_url, f'/v1/cards/{card_id}', rest_token)
        assert response['card']['result'] == 'MCP evidence'
        assert response['card']['thread'] == 'smoke'
        reply = mcp('add_task', {'title': 'Hermes to Muse', 'from': 'hermes', 'to': 'muse', 'thread': 'smoke'})
        card_id = reply['id']
        assert request(rest_url, f'/v1/cards/{card_id}/claim', rest_token, {'agent': 'instinct'})[0] == 409
        assert request(rest_url, f'/v1/cards/{card_id}/claim', rest_token, {'agent': 'muse'})[0] == 200
        assert request(rest_url, f'/v1/cards/{card_id}/complete', rest_token, {'agent': 'muse', 'result': 'REST evidence'})[0] == 200
        assert mcp('get_task', {'id': card_id})['result'] == 'REST evidence'
        print('PASS: REST/MCP round trip, routing, claims, completion, auth separation; temporary board only')
    finally:
        for process in processes:
            process.terminate()
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
